import sharp from "sharp";

const profileWidth = 1590;
const profileHeight = 1800;
const postsPerPage = 6;
const maxRemoteImageBytes = 8 * 1024 * 1024;
const allowedImageHosts = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

export type ProfileCardInput = {
  displayName: string;
  avatarUrl: string;
  bannerUrl: string | null;
  backgroundColor: string;
  totalPosts: number;
  followingCount: number;
  followerCount: number;
  currentXp: number;
  level: number;
  nextLevelXp: number;
  posts: Array<{ imageUrl: string | null; likeCount: number }>;
};

function escapeXml(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateText(value: string, maxCharacters: number) {
  const characters = Array.from(value.trim());
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters - 1).join("")}…`
    : characters.join("");
}

function safeHex(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "#39393D";
}

function darkenHex(hex: string, factor: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = Math.round(((value >> 16) & 0xff) * factor);
  const green = Math.round(((value >> 8) & 0xff) * factor);
  const blue = Math.round((value & 0xff) * factor);
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function fetchDiscordImage(url: string) {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    !allowedImageHosts.has(parsedUrl.hostname)
  ) {
    throw new Error("Profile images must come from Discord's CDN.");
  }

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("A profile image could not be downloaded.");

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxRemoteImageBytes) {
    throw new Error("A profile image exceeds the supported size.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > maxRemoteImageBytes) {
    throw new Error("A profile image has an unsupported size.");
  }
  return buffer;
}

async function resizeImage(url: string, width: number, height: number) {
  const buffer = await fetchDiscordImage(url);
  const resized = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(width, height, { fit: "cover", position: "attention" })
    .jpeg({ quality: 84 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function buildSvg(
  input: ProfileCardInput,
  avatarData: string,
  bannerData: string | null,
  postImages: Array<{ imageData: string | null; likeCount: number }>,
) {
  const backgroundColor = safeHex(input.backgroundColor);
  const mediumBackground = darkenHex(backgroundColor, 0.62);
  const darkBackground = darkenHex(backgroundColor, 0.3);
  const panelBackground = darkenHex(backgroundColor, 0.72);
  const tileBackground = darkenHex(backgroundColor, 0.67);
  const tileWidth = 390;
  const tileHeight = 382;
  const xPositions = [178, 600, 1022];
  const yPositions = [924, 1336];
  const progressWidth = Math.max(
    0,
    Math.min(input.currentXp / Math.max(input.nextLevelXp, 1), 1) * 875,
  );

  const tiles = Array.from({ length: postsPerPage }, (_, index) => {
    const x = xPositions[index % 3];
    const y = yPositions[Math.floor(index / 3)];
    const post = postImages[index];
    const clipId = `post-tile-${index}`;

    if (!post?.imageData) {
      return `<g>
        <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="36" fill="${tileBackground}"/>
        <text x="${x + tileWidth / 2}" y="${y + tileHeight / 2 + 34}" text-anchor="middle"
          fill="#414144" font-family="Arial, sans-serif" font-size="112" font-weight="700">+</text>
      </g>`;
    }

    const likeBadgeWidth = post.likeCount > 999 ? 152 : 130;
    return `<g clip-path="url(#${clipId})">
      <image x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}"
        href="${post.imageData}" preserveAspectRatio="xMidYMid slice"/>
      <rect x="${x}" y="${y + tileHeight - 120}" width="${tileWidth}" height="120"
        fill="url(#tile-fade)"/>
      <rect x="${x + 18}" y="${y + tileHeight - 73}" width="${likeBadgeWidth}" height="52"
        rx="26" fill="#111214" fill-opacity=".88"/>
      <text x="${x + 38}" y="${y + tileHeight - 37}" fill="#ff5665"
        font-family="Arial, sans-serif" font-size="29">♥</text>
      <text x="${x + 77}" y="${y + tileHeight - 37}" fill="#ffffff"
        font-family="Arial, sans-serif" font-size="25" font-weight="700">${post.likeCount}</text>
    </g>`;
  }).join("");

  const clipPaths = Array.from({ length: postsPerPage }, (_, index) => {
    const x = xPositions[index % 3];
    const y = yPositions[Math.floor(index / 3)];
    return `<clipPath id="post-tile-${index}">
      <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="36"/>
    </clipPath>`;
  }).join("");

  const displayName = escapeXml(
    truncateText(input.displayName || "Discord Member", 28),
  );
  const formattedXp = `${input.currentXp.toLocaleString("en-US")} / ${input.nextLevelXp.toLocaleString("en-US")} XP`;
  const bannerLayer = bannerData
    ? `<image x="34" y="34" width="1522" height="508" href="${bannerData}"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#banner-clip)"/>`
    : `<rect x="34" y="34" width="1522" height="508" rx="62" fill="url(#banner-fallback)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${profileWidth}" height="${profileHeight}" viewBox="0 0 ${profileWidth} ${profileHeight}">
    <defs>
      <linearGradient id="page-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${backgroundColor}"/>
        <stop offset=".48" stop-color="${mediumBackground}"/>
        <stop offset="1" stop-color="${darkBackground}"/>
      </linearGradient>
      <linearGradient id="banner-fallback" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${darkenHex(backgroundColor, 0.55)}"/>
        <stop offset=".56" stop-color="#111113"/>
        <stop offset="1" stop-color="#070708"/>
      </linearGradient>
      <linearGradient id="banner-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity=".15"/>
        <stop offset="1" stop-color="#000000" stop-opacity=".42"/>
      </linearGradient>
      <linearGradient id="tile-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000000" stop-opacity=".72"/>
      </linearGradient>
      <linearGradient id="xp-fill" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#6388f4"/>
        <stop offset="1" stop-color="#8859d7"/>
      </linearGradient>
      <linearGradient id="stats-panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${darkenHex(backgroundColor, 0.78)}"/>
        <stop offset="1" stop-color="${darkenHex(backgroundColor, 0.45)}"/>
      </linearGradient>
      <clipPath id="name-clip"><rect x="578" y="566" width="670" height="75"/></clipPath>
      <clipPath id="xp-clip"><rect x="585" y="650" width="875" height="45" rx="23"/></clipPath>
      <clipPath id="banner-clip"><rect x="34" y="34" width="1522" height="508" rx="62"/></clipPath>
      <clipPath id="avatar-clip"><circle cx="292" cy="500" r="210"/></clipPath>
      ${clipPaths}
    </defs>
    <rect width="${profileWidth}" height="${profileHeight}" fill="url(#page-bg)"/>
    <rect x="34" y="34" width="1522" height="508" rx="62" fill="#080809"/>
    ${bannerLayer}
    <rect x="34" y="34" width="1522" height="508" rx="62" fill="url(#banner-shade)" clip-path="url(#banner-clip)"/>

    <rect x="535" y="546" width="1021" height="190" rx="42" fill="${panelBackground}"/>
    <text x="587" y="626" fill="#ffffff" font-family="Arial, sans-serif" font-size="58"
      font-weight="700" clip-path="url(#name-clip)">${displayName}</text>
    <text x="1508" y="626" text-anchor="end" fill="#bfc0c5"
      font-family="Arial, sans-serif" font-size="25">${formattedXp}</text>
    <rect x="585" y="650" width="875" height="45" rx="23" fill="#3d3d43"/>
    <g clip-path="url(#xp-clip)">
      <rect x="585" y="650" width="${progressWidth}" height="45" fill="url(#xp-fill)"/>
    </g>
    <text x="1022" y="681" text-anchor="middle" fill="#ffffff"
      font-family="Arial, sans-serif" font-size="23" font-weight="700">Account · Lv. ${input.level}</text>

    <circle cx="292" cy="500" r="222" fill="#414144"/>
    <image x="82" y="290" width="420" height="420" href="${avatarData}"
      preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>

    <rect x="34" y="755" width="1522" height="1017" rx="46" fill="url(#stats-panel)"/>
    <text x="435" y="842" text-anchor="middle" fill="#ffd33d"
      font-family="Arial, sans-serif" font-size="66" font-weight="700">${input.totalPosts}</text>
    <text x="435" y="894" text-anchor="middle" fill="#a6a6ac"
      font-family="Arial, sans-serif" font-size="34">Posts</text>
    <text x="795" y="842" text-anchor="middle" fill="#f16f79"
      font-family="Arial, sans-serif" font-size="66" font-weight="700">${input.followingCount}</text>
    <text x="795" y="894" text-anchor="middle" fill="#a6a6ac"
      font-family="Arial, sans-serif" font-size="34">Following</text>
    <text x="1155" y="842" text-anchor="middle" fill="#12c5e7"
      font-family="Arial, sans-serif" font-size="66" font-weight="700">${input.followerCount}</text>
    <text x="1155" y="894" text-anchor="middle" fill="#a6a6ac"
      font-family="Arial, sans-serif" font-size="34">Followers</text>
    ${tiles}
  </svg>`;
}

export async function renderProfileCard(input: ProfileCardInput) {
  const [avatarData, bannerData, postImages] = await Promise.all([
    resizeImage(input.avatarUrl, 600, 600),
    input.bannerUrl ? resizeImage(input.bannerUrl, 1600, 540) : Promise.resolve(null),
    mapWithConcurrency(input.posts, 3, async (post) => ({
      imageData: post.imageUrl
        ? await resizeImage(post.imageUrl, 520, 510)
        : null,
      likeCount: post.likeCount,
    })),
  ]);

  return sharp(Buffer.from(buildSvg(input, avatarData, bannerData, postImages)))
    .png({ compressionLevel: 8 })
    .toBuffer();
}