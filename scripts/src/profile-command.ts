import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  Events,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import sharp from "sharp";
import type { Pool } from "pg";

const profileCommandChannelId = "1546917390405869718";
const imagePostChannelId = "1546491043334201374";
const profileWidth = 1590;
const profileHeight = 1800;
const thumbnailLimit = 6;
const maxRemoteImageBytes = 8 * 1024 * 1024;
const allowedImageHosts = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

type ProfilePostRow = {
  message_id: string;
  images: string[] | string;
  like_count: number;
  total_posts: number;
  total_likes: number;
};

type ProfilePost = {
  imageUrl: string;
  likeCount: number;
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

function displayText(value: string, maxCharacters: number) {
  const normalized = value.trim();
  const characters = Array.from(normalized);
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters - 1).join("")}…`
    : normalized;
}

function parseImageNames(images: string[] | string) {
  if (Array.isArray(images)) return images;
  try {
    const parsed: unknown = JSON.parse(images);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

function getMediaGalleryUrls(components: readonly unknown[]) {
  const urls: string[] = [];
  const visit = (component: unknown) => {
    if (!component || typeof component !== "object") return;
    const candidate = component as {
      toJSON?: () => unknown;
      components?: unknown[];
    };
    const serialized =
      typeof candidate.toJSON === "function" ? candidate.toJSON() : component;
    if (!serialized || typeof serialized !== "object") return;

    const data = serialized as {
      type?: number;
      components?: unknown[];
      items?: Array<{ media?: { url?: string } }>;
    };
    if (data.type === 12 && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (typeof item.media?.url === "string") urls.push(item.media.url);
      }
    }
    if (Array.isArray(data.components)) data.components.forEach(visit);
  };

  components.forEach(visit);
  return urls;
}

async function getProfilePosts(
  client: Client,
  pool: Pool,
  userId: string,
): Promise<{ posts: ProfilePost[]; totalPosts: number; totalLikes: number }> {
  const result = await pool.query<ProfilePostRow>(
    `WITH post_likes AS (
       SELECT p.message_id,
              p.images,
              p.created_at,
              COUNT(l.user_id)::int AS like_count
       FROM discord_image_posts p
       LEFT JOIN discord_image_post_likes l ON l.message_id = p.message_id
       WHERE p.author_id = $1 AND p.channel_id = $2
       GROUP BY p.message_id
     )
     SELECT message_id,
            images,
            like_count,
            COUNT(*) OVER()::int AS total_posts,
            SUM(like_count) OVER()::int AS total_likes
     FROM post_likes
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, imagePostChannelId, thumbnailLimit],
  );

  const totalPosts = result.rows[0]?.total_posts ?? 0;
  const totalLikes = result.rows[0]?.total_likes ?? 0;
  if (result.rows.length === 0) {
    return { posts: [], totalPosts, totalLikes };
  }

  const channel = await client.channels.fetch(imagePostChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("The configured image-post channel is unavailable.");
  }

  const posts: ProfilePost[] = [];
  for (const row of result.rows) {
    const imageNames = parseImageNames(row.images);
    if (imageNames.length === 0) continue;

    try {
      const message = await (channel as TextChannel).messages.fetch({
        message: row.message_id,
        force: true,
      });
      const attachmentList = [...message.attachments.values()];
      const attachment =
        message.attachments.find((item) => item.name === imageNames[0]) ??
        attachmentList[0];
      const galleryUrl = getMediaGalleryUrls(message.components)[0];
      const embeddedImageUrl = message.embeds[0]?.image?.url;
      const imageUrl = attachment?.url ?? galleryUrl ?? embeddedImageUrl;
      if (imageUrl && !imageUrl.startsWith("attachment://")) {
        posts.push({ imageUrl, likeCount: row.like_count });
      }
    } catch {
      // A post may have been deleted outside the bot; leave its tile empty.
    }
  }

  return { posts, totalPosts, totalLikes };
}

async function fetchDiscordImage(url: string) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || !allowedImageHosts.has(parsedUrl.hostname)) {
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

export function buildProfileSvg(
  displayName: string,
  username: string,
  avatarData: string,
  bannerData: string | null,
  totalPosts: number,
  totalLikes: number,
  postImages: Array<{ imageData: string | null; likeCount: number }>,
) {
  const tileWidth = 390;
  const tileHeight = 382;
  const xPositions = [178, 600, 1022];
  const yPositions = [924, 1336];
  const tiles = Array.from({ length: thumbnailLimit }, (_, index) => {
    const x = xPositions[index % 3];
    const y = yPositions[Math.floor(index / 3)];
    const post = postImages[index];
    const clipId = `post-tile-${index}`;

    if (!post?.imageData) {
      return `<g>
        <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="36" fill="#252527"/>
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

  const clipPaths = Array.from({ length: thumbnailLimit }, (_, index) => {
    const x = xPositions[index % 3];
    const y = yPositions[Math.floor(index / 3)];
    return `<clipPath id="post-tile-${index}">
      <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="36"/>
    </clipPath>`;
  }).join("");

  const safeDisplayName = escapeXml(displayText(displayName, 34) || "Discord Member");
  const safeUsername = escapeXml(displayText(`@${username}`, 36));
  const bannerLayer = bannerData
    ? `<image x="34" y="34" width="1522" height="508" href="${bannerData}"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#banner-clip)"/>`
    : `<rect x="34" y="34" width="1522" height="508" rx="62" fill="url(#banner-fallback)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${profileWidth}" height="${profileHeight}" viewBox="0 0 ${profileWidth} ${profileHeight}">
    <defs>
      <linearGradient id="page-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a3a3d"/>
        <stop offset=".48" stop-color="#202023"/>
        <stop offset="1" stop-color="#09090a"/>
      </linearGradient>
      <linearGradient id="banner-fallback" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#303034"/>
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
      <linearGradient id="stats-panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b2b2e"/>
        <stop offset="1" stop-color="#18181a"/>
      </linearGradient>
      <clipPath id="name-clip"><rect x="578" y="566" width="690" height="82"/></clipPath>
      <clipPath id="banner-clip"><rect x="34" y="34" width="1522" height="508" rx="62"/></clipPath>
      <clipPath id="avatar-clip"><circle cx="292" cy="500" r="210"/></clipPath>
      ${clipPaths}
    </defs>
    <rect width="${profileWidth}" height="${profileHeight}" fill="url(#page-bg)"/>
    <rect x="34" y="34" width="1522" height="508" rx="62" fill="#080809"/>
    ${bannerLayer}
    <rect x="34" y="34" width="1522" height="508" rx="62" fill="url(#banner-shade)" clip-path="url(#banner-clip)"/>

    <rect x="535" y="546" width="1021" height="190" rx="42" fill="#2b2b2e"/>
    <text x="587" y="628" fill="#ffffff" font-family="Arial, sans-serif" font-size="58"
      font-weight="700" clip-path="url(#name-clip)">${safeDisplayName}</text>
    <text x="590" y="686" fill="#b5b5bb" font-family="Arial, sans-serif" font-size="25">${safeUsername}</text>
    <rect x="1290" y="578" width="218" height="48" rx="24" fill="#37373b"/>
    <text x="1399" y="610" text-anchor="middle" fill="#d4d4d8"
      font-family="Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2">PROFILE</text>

    <circle cx="292" cy="500" r="222" fill="#414144"/>
    <image x="82" y="290" width="420" height="420" href="${avatarData}"
      preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>

    <rect x="34" y="755" width="1522" height="1017" rx="46" fill="url(#stats-panel)"/>
    <text x="520" y="842" text-anchor="middle" fill="#ffd33d"
      font-family="Arial, sans-serif" font-size="66" font-weight="700">${totalPosts}</text>
    <text x="520" y="894" text-anchor="middle" fill="#a6a6ac"
      font-family="Arial, sans-serif" font-size="34">Posts</text>
    <text x="1090" y="842" text-anchor="middle" fill="#43cce5"
      font-family="Arial, sans-serif" font-size="66" font-weight="700">${totalLikes}</text>
    <text x="1090" y="894" text-anchor="middle" fill="#a6a6ac"
      font-family="Arial, sans-serif" font-size="34">Likes received</text>
    ${tiles}
  </svg>`;
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

async function renderProfile(
  client: Client,
  pool: Pool,
  message: Message,
) {
  const user = await message.author.fetch(true);
  const displayName =
    message.member?.displayName ?? user.globalName ?? user.username;
  const avatarUrl = user.displayAvatarURL({ extension: "png", size: 512 });
  const bannerUrl = user.bannerURL({ extension: "png", size: 1024 }) ?? null;
  const profilePosts = await getProfilePosts(client, pool, user.id);

  const [avatarData, bannerData, postData] = await Promise.all([
    resizeImage(avatarUrl, 600, 600),
    bannerUrl ? resizeImage(bannerUrl, 1600, 540) : Promise.resolve(null),
    mapWithConcurrency(profilePosts.posts, 3, async (post) => ({
      imageData: await resizeImage(post.imageUrl, 520, 510),
      likeCount: post.likeCount,
    })),
  ]);

  const svg = buildProfileSvg(
    displayName,
    user.username,
    avatarData,
    bannerData,
    profilePosts.totalPosts,
    profilePosts.totalLikes,
    postData,
  );
  return sharp(Buffer.from(svg), { density: 96 })
    .png({ compressionLevel: 8 })
    .toBuffer();
}

function logProfileError(error: unknown, message: Message) {
  const details =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown })
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event: "profile_image_generation_failed",
      timestamp: new Date().toISOString(),
      userId: message.author.id,
      channelId: message.channelId,
      errorName: typeof details.name === "string" ? details.name : "Error",
      ...(details.code !== undefined
        ? { errorCode: String(details.code) }
        : {}),
    })}\n`,
  );
}

export function attachProfileCommand(client: Client, pool: Pool) {
  const onMessage = (message: Message) => {
    if (
      !message.inGuild() ||
      message.author.bot ||
      message.channelId !== profileCommandChannelId ||
      message.content.trim() !== "بروفايل"
    ) {
      return;
    }

    void renderProfile(client, pool, message)
      .then(async (image) => {
        const fileName = `profile-${message.author.id}.png`;
        const embed = new EmbedBuilder()
          .setColor(0x29292c)
          .setTitle(`الملف الشخصي · ${message.member?.displayName ?? message.author.username}`)
          .setImage(`attachment://${fileName}`);

        await message.reply({
          embeds: [embed],
          files: [new AttachmentBuilder(image, { name: fileName })],
          allowedMentions: { repliedUser: false },
        });
      })
      .catch(async (error: unknown) => {
        logProfileError(error, message);
        await message
          .reply({
            content: "تعذر إنشاء الملف الشخصي حالياً. حاول مرة أخرى بعد قليل.",
            allowedMentions: { repliedUser: false },
          })
          .catch(() => null);
      });
  };

  client.on(Events.MessageCreate, onMessage);
  return () => client.off(Events.MessageCreate, onMessage);
}