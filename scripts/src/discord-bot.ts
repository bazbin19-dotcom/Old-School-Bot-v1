import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type Attachment,
  type ButtonInteraction,
  type Guild,
  type Message,
  type ModalSubmitInteraction,
  type ThreadChannel,
  type UserSelectMenuInteraction,
} from "discord.js";
import { Pool, type QueryResultRow } from "pg";
import {
  attachDailyPostRewards,
  initializeDailyPostRewardTables,
} from "./daily-post-rewards.js";
import {
  attachProfileCommand,
  initializeProfileTables,
} from "./profile-command.js";
import {
  attachTaskListFeature,
  initializeTaskListTables,
} from "./task-list-feature.js";
import {
  attachForestLinkFeature,
  initializeForestLinkTables,
} from "./forest-link-feature.js";
import {
  attachAuctionFeature,
  initializeAuctionTables,
} from "./auction-feature.js";
import {
  profileImagePostChannelId,
  profileXpPerPost,
} from "./profile-store.js";

function requireEnvironmentValue(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const token = requireEnvironmentValue("DISCORD_BOT_TOKEN");
const channelId = requireEnvironmentValue("DISCORD_CHANNEL_ID");
const imagePostChannelIds = new Set([channelId, "1498730522803703848"]);
const formattedMessageChannelIds = [
  "1546491155406135296",
  "1553714914567135312",
] as const;
const whisperChannelIds = [
  "1546492836592222279",
  "1553713879442526209",
] as const;
const databaseUrl = requireEnvironmentValue("DATABASE_URL");
const retrySourceMessageId = process.env.DISCORD_RETRY_SOURCE_MESSAGE_ID;
const maxUploadBytes = 8 * 1024 * 1024;
const maxCaptionLength = 2_000;
const legacySeparator = "────────────────────────────────";
const commentInactivityMs = 5 * 60_000;
const commentRemovalRetryMs = 60_000;
const botActivityMessages = [
  "⚔️ Old School",
  "🎖️ The Best",
  "🎯 OS Server",
  "💞 I Love OS",
] as const;
const additionalAllowedGuildIds = new Set(["1313568118198632520"]);
const botStreamingActivityName = "Old School";
const botStreamingUrl = "https://twitch.tv/Old_School";

const pool = new Pool({ connectionString: databaseUrl });
let stopDailyPostRewards = () => {};
let stopProfileCommand = () => {};
let stopTaskListFeature = () => {};
let stopForestLinkFeature = () => {};
let stopAuctionFeature = () => {};
let botActivityTimer: NodeJS.Timeout | undefined;
let allowedGuildId: string | undefined;
const commentMemberRemovalTimers = new Map<string, NodeJS.Timeout>();
const commentMemberQueues = new Map<string, Promise<void>>();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

type ImagePostRow = QueryResultRow & {
  message_id: string;
  source_message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  caption: string;
  images: string[] | string;
  comments_locked: boolean;
  thread_id: string | null;
};

type ImagePost = {
  message_id: string;
  source_message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  caption: string;
  images: string[];
  comments_locked: boolean;
  thread_id: string | null;
};

type ThreadCommentActivityRow = QueryResultRow & {
  post_message_id: string;
  guild_id: string;
  thread_id: string;
  user_id: string;
  last_comment_at: Date;
};

type WhisperMode = "anonymous" | "identified";

type WhisperMessageRow = QueryResultRow & {
  whisper_id: string;
  channel_id: string;
  message_id: string | null;
  recipient_id: string;
  sender_name: string | null;
  body: string;
  anonymous: boolean;
  created_at: Date;
  opened_at: Date | null;
};

type DownloadedImage = {
  buffer: Buffer;
  fileName: string;
};

class UserFacingError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "UserFacingError";
  }
}

function writeLog(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, string | number | boolean> = {},
) {
  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

function safeErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const errorMessage =
    typeof candidate.message === "string"
      ? candidate.message
          .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[redacted connection]")
          .replace(/https?:\/\/\S+/gi, "[url]")
          .replace(/\b\d{17,20}\b/g, "[id]")
          .slice(0, 180)
      : undefined;

  return {
    errorName: typeof candidate.name === "string" ? candidate.name : "Error",
    ...(typeof candidate.code === "string" || typeof candidate.code === "number"
      ? { errorCode: String(candidate.code) }
      : {}),
    ...(typeof candidate.status === "number" ? { errorStatus: candidate.status } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_image_posts (
      message_id text PRIMARY KEY,
      source_message_id text NOT NULL UNIQUE,
      channel_id text NOT NULL,
      author_id text NOT NULL,
      author_name text NOT NULL,
      author_avatar_url text,
      caption text NOT NULL DEFAULT '',
      images jsonb NOT NULL,
      comments_locked boolean NOT NULL DEFAULT false,
      thread_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_image_post_likes (
      message_id text NOT NULL REFERENCES discord_image_posts(message_id) ON DELETE CASCADE,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_image_thread_comment_activity (
      post_message_id text NOT NULL REFERENCES discord_image_posts(message_id) ON DELETE CASCADE,
      guild_id text NOT NULL,
      thread_id text NOT NULL,
      user_id text NOT NULL,
      last_comment_at timestamptz NOT NULL,
      PRIMARY KEY (thread_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_whisper_messages (
      whisper_id text PRIMARY KEY,
      channel_id text NOT NULL,
      message_id text,
      recipient_id text NOT NULL,
      sender_name text,
      body text NOT NULL,
      anonymous boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      retention_started_at timestamptz NOT NULL DEFAULT now(),
      opened_at timestamptz
    )
  `);
  await pool.query(`
    ALTER TABLE discord_whisper_messages
    ADD COLUMN IF NOT EXISTS retention_started_at timestamptz NOT NULL DEFAULT now()
  `);
  await pool.query(`
    ALTER TABLE discord_whisper_messages
    ADD COLUMN IF NOT EXISTS opened_at timestamptz
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_whisper_panels (
      channel_id text PRIMARY KEY,
      message_id text NOT NULL
    )
  `);
}

function normalizePost(row: ImagePostRow): ImagePost {
  const images =
    typeof row.images === "string" ? (JSON.parse(row.images) as string[]) : row.images;
  return { ...row, images };
}

async function getPost(messageId: string): Promise<ImagePost | null> {
  const result = await pool.query<ImagePostRow>(
    `SELECT message_id, source_message_id, channel_id, author_id, author_name,
            author_avatar_url, caption, images, comments_locked, thread_id
     FROM discord_image_posts
     WHERE message_id = $1 OR source_message_id = $1`,
    [messageId],
  );
  return result.rows[0] ? normalizePost(result.rows[0]) : null;
}

async function getLikeCount(messageId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM discord_image_post_likes
     WHERE message_id = $1`,
    [messageId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function userHasLiked(messageId: string, userId: string): Promise<boolean> {
  const result = await pool.query<{ liked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM discord_image_post_likes
       WHERE message_id = $1 AND user_id = $2
     ) AS liked`,
    [messageId, userId],
  );
  return result.rows[0]?.liked ?? false;
}

function buildPostContainer(
  post: Pick<ImagePost, "author_name" | "author_avatar_url" | "caption">,
  images: Array<{ fileName: string; url: string }>,
  messageId: string,
  likeCount: number,
  commentsLocked: boolean,
  includeButtons = true,
) {
  const caption = post.caption.trim();
  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      caption ? `**${post.author_name}**\n${caption}` : `**${post.author_name}**`,
    ),
  );

  if (post.author_avatar_url) {
    header.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(post.author_avatar_url),
    );
  }

  const container = new ContainerBuilder().addSectionComponents(header);

  if (images.length > 0) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        images.map((image) => ({ media: { url: image.url } })),
      ),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  if (includeButtons) {
    container.addActionRowComponents(
      buildPostButtons(messageId, likeCount, commentsLocked),
    );
  }

  return container;
}

function buildPostButtons(
  messageId: string,
  likeCount: number,
  commentsLocked: boolean,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`post:like:${messageId}`)
      .setLabel(`Like · ${likeCount}`)
      .setEmoji("❤️")
      .setStyle(likeCount > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`post:comment:${messageId}`)
      .setLabel("تعليق")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(commentsLocked),
    new ButtonBuilder()
      .setCustomId(`post:settings:${messageId}`)
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildLegacyEmbeds(
  post: Pick<ImagePost, "author_name" | "author_avatar_url" | "caption">,
  images: Array<{ fileName: string; url: string }>,
) {
  return images.map((image, index) => {
    const embed = new EmbedBuilder()
      .setColor(0x30323a)
      .setImage(image.url);

    if (index === 0) {
      embed
        .setAuthor({
          name: post.author_name,
          ...(post.author_avatar_url ? { iconURL: post.author_avatar_url } : {}),
        })
        .setDescription(post.caption.trim() || "\u200b");
    }

    if (index === images.length - 1) {
      embed.setFooter({ text: legacySeparator });
    }

    return embed;
  });
}
function canManagePost(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  post: ImagePost,
) {
  return (
    interaction.user.id === post.author_id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true
  );
}

function isPostMessage(
  interaction: ButtonInteraction,
  post: ImagePost,
  allowEphemeralActionMessage = false,
) {
  return (
    interaction.channelId === post.channel_id &&
    (allowEphemeralActionMessage || interaction.message.id === post.message_id)
  );
}

async function fetchPostMessage(post: ImagePost) {
  const channel = await client.channels.fetch(post.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Configured post channel is unavailable.");
  }
  const message = await channel.messages.fetch(post.message_id);
  const mediaGalleryUrls = getMediaGalleryUrls(message.components);
  const availableAttachments = [...message.attachments.values()];
  const images = post.images.map((fileName, index) => {
    const attachment =
      message.attachments.find((item) => item.name === fileName) ??
      availableAttachments[index];
    const recoveredUrl =
      mediaGalleryUrls[index] ?? message.embeds[index]?.image?.url;
    const url =
      attachment?.url ??
      (recoveredUrl && !recoveredUrl.startsWith("attachment://")
        ? recoveredUrl
        : null);
    if (!url) throw new Error("A post image attachment could not be found.");
    return { fileName, url };
  });
  return { channel, message, images };
}

function getMediaGalleryUrls(components: readonly unknown[]): string[] {
  const urls: string[] = [];

  const visit = (component: unknown) => {
    if (!component || typeof component !== "object") return;
    const candidate = component as {
      toJSON?: () => unknown;
      type?: number;
      components?: unknown[];
      items?: Array<{ media?: { url?: string } }>;
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

async function editPostCard(
  message: Message,
  post: ImagePost | Pick<ImagePost, "author_name" | "author_avatar_url" | "caption">,
  images: Array<{ fileName: string; url: string }>,
  messageId: string,
  likeCount: number,
  commentsLocked: boolean,
  forceComponentsV2 = false,
): Promise<Message> {
  const attachments = [...message.attachments.keys()].map((id) => ({ id }));
  const attachmentOptions = attachments.length > 0 ? { attachments } : {};

  if (!forceComponentsV2 && !message.flags.has(MessageFlags.IsComponentsV2)) {
    return message.edit({
      embeds: buildLegacyEmbeds(post, images),
      components: [buildPostButtons(messageId, likeCount, commentsLocked)],
      ...attachmentOptions,
    });
  }

  return message.edit({
    ...(forceComponentsV2 ? { embeds: [] } : {}),
    components: [
      buildPostContainer(post, images, messageId, likeCount, commentsLocked),
    ],
    flags: MessageFlags.IsComponentsV2,
    ...attachmentOptions,
  });
}

async function ensureUploadedImages(message: Message, expectedCount: number) {
  let uploadedMessage = message;
  const responseAttachmentCount = uploadedMessage.attachments.size;
  if (uploadedMessage.attachments.size < expectedCount) {
    const channel = await client.channels.fetch(message.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error("The uploaded image post could not be re-fetched.");
    }
    uploadedMessage = await channel.messages.fetch({
      message: message.id,
      force: true,
    });
  }

  if (uploadedMessage.attachments.size < expectedCount) {
    const galleryUrls = getMediaGalleryUrls(uploadedMessage.components);
    const embedUrls = uploadedMessage.embeds
      .map((embed) => embed.image?.url)
      .filter((url): url is string => Boolean(url));
    const mediaUrls =
      galleryUrls.length >= expectedCount ? galleryUrls : embedUrls;
    const mediaResponses = await Promise.all(
      mediaUrls.slice(0, expectedCount).map((url) =>
        url.startsWith("attachment://")
          ? Promise.resolve(null)
          : fetch(url, {
              method: "HEAD",
              signal: AbortSignal.timeout(10_000),
            }).catch(() => null),
      ),
    );
    const mediaUrlsAreReachable =
      mediaUrls.length >= expectedCount &&
      mediaResponses.length === expectedCount &&
      mediaResponses.every((response) => response?.ok === true);
    const firstMediaUrl = mediaUrls[0];
    let mediaHost = "missing";
    if (firstMediaUrl?.startsWith("attachment://")) {
      mediaHost = "attachment-reference";
    } else if (firstMediaUrl) {
      try {
        mediaHost = new URL(firstMediaUrl).host;
      } catch {
        mediaHost = "invalid";
      }
    }
    writeLog(
      mediaUrlsAreReachable ? "info" : "error",
      mediaUrlsAreReachable
        ? "image_upload_metadata_fallback_verified"
        : "image_upload_metadata_check_failed",
      {
        channelId,
        expected: expectedCount,
        responseAttachments: responseAttachmentCount,
        refetchedAttachments: uploadedMessage.attachments.size,
        mediaHost,
        mediaStatus: mediaResponses[0]?.status ?? "unavailable",
      },
    );
    if (mediaUrlsAreReachable) return uploadedMessage;
    throw new Error("Discord did not retain the uploaded image files.");
  }
  return uploadedMessage;
}

function getUploadedImageReferences(
  message: Message,
  downloadedImages: DownloadedImage[],
) {
  const uploadedAttachments = [...message.attachments.values()];
  const galleryUrls = getMediaGalleryUrls(message.components);
  const embedUrls = message.embeds
    .map((embed) => embed.image?.url)
    .filter((url): url is string => Boolean(url));
  const fallbackUrls = galleryUrls.length >= downloadedImages.length
    ? galleryUrls
    : embedUrls;
  const images = downloadedImages.map(({ fileName }, index) => {
    const attachment =
      message.attachments.find((item) => item.name === fileName) ??
      uploadedAttachments[index];
    const url = attachment?.url ?? fallbackUrls[index];
    if (!url || url.startsWith("attachment://")) {
      throw new Error("Discord did not return a usable URL for an uploaded image.");
    }
    return {
      fileName: attachment?.name ?? fileName,
      url,
    };
  });
  return images;
}

async function updatePostCaption(post: ImagePost, caption: string) {
  const updatedPost = { ...post, caption };
  const { message, images } = await fetchPostMessage(updatedPost);
  await pool.query(
    `UPDATE discord_image_posts SET caption = $2 WHERE message_id = $1`,
    [post.message_id, caption],
  );
  const likeCount = await getLikeCount(post.message_id);
  await editPostCard(
    message,
    updatedPost,
    images,
    post.message_id,
    likeCount,
    post.comments_locked,
  );
}

function makeCaptionModal(post: ImagePost) {
  const input = new TextInputBuilder()
    .setCustomId("caption")
    .setLabel("النص الذي يظهر فوق الصورة")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(maxCaptionLength)
    .setValue(post.caption.slice(0, maxCaptionLength));

  return new ModalBuilder()
    .setCustomId(`post:caption_submit:${post.message_id}`)
    .setTitle("تعديل كتابة المنشور")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function makeCommentModal(messageId: string) {
  const input = new TextInputBuilder()
    .setCustomId("comment")
    .setLabel("اكتب تعليقك")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1_500);

  return new ModalBuilder()
    .setCustomId(`post:comment_submit:${messageId}`)
    .setTitle("التعليق على الصورة")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function isWhisperMode(value: string | undefined): value is WhisperMode {
  return value === "anonymous" || value === "identified";
}

function isWhisperChannelId(
  channelId: string | null,
): channelId is (typeof whisperChannelIds)[number] {
  return whisperChannelIds.some((allowedChannelId) => allowedChannelId === channelId);
}

function buildWhisperPanelButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("whisper:send")
      .setLabel("إرسال همسة")
      .setEmoji("✉️")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildWhisperPanelContainer() {
  return new ContainerBuilder()
    .setAccentColor(0x7658d6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 💬 قسم الهمسة",
          "أرسل رسالة خاصة إلى أي عضو في السيرفر.",
          "",
          "🕵️ **همسة مجهولة:** لا تظهر هوية المرسل للمستلم.",
          "👤 **همسة معلومة:** يظهر اسم المرسل للمستلم فقط.",
          "",
          "محتوى الهمسة لا يظهر في القناة، ولا يستطيع فتحه إلا المستلم المحدد.",
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("اضغط «إرسال همسة» للبدء."),
    )
    .addActionRowComponents(buildWhisperPanelButtons());
}

function buildWhisperPanelPayload() {
  return {
    embeds: [],
    components: [buildWhisperPanelContainer()],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [] as const },
  };
}

function buildWhisperModeButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("whisper:mode:anonymous")
      .setLabel("إرسال من مجهول")
      .setEmoji("🕵️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("whisper:mode:identified")
      .setLabel("إرسال باسمي")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildWhisperRecipientSelect(mode: WhisperMode) {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`whisper:recipient:${mode}`)
      .setPlaceholder("اختر مستلم الهمسة")
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function makeWhisperModal(mode: WhisperMode, recipientId: string) {
  const input = new TextInputBuilder()
    .setCustomId("body")
    .setLabel("اكتب نص الهمسة")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1_500);

  return new ModalBuilder()
    .setCustomId(`whisper:submit:${mode}:${recipientId}`)
    .setTitle(mode === "anonymous" ? "إرسال همسة مجهولة" : "إرسال همسة معلومة")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function buildWhisperCardEmbed(mode: WhisperMode) {
  return new EmbedBuilder()
    .setColor(mode === "anonymous" ? 0x252a34 : 0x7658d6)
    .setTitle(mode === "anonymous" ? "🕵️ همسة مجهولة" : "💬 همسة خاصة")
    .setDescription(
      [
        "🔒 **رسالة مقفلة**",
        "اضغط الزر لفتحها إذا كنت المستلم.",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
      ].join("\n"),
    )
    .setFooter({ text: "محتوى الهمسة لا يظهر إلا للمستلم" })
    .setTimestamp();
}

function buildWhisperCardContent(recipientId: string, expiresAt: Date) {
  const expiryTimestamp = Math.floor(expiresAt.getTime() / 1000);
  return `<@${recipientId}>\n⏳ تنتهي الهمسة <t:${expiryTimestamp}:R>`;
}

function buildWhisperOpenButton(whisperId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`whisper:open:${whisperId}`)
      .setLabel("فتح الهمسة")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildPrivateWhisperEmbed(whisper: WhisperMessageRow) {
  const embed = new EmbedBuilder()
    .setColor(whisper.anonymous ? 0x252a34 : 0x7658d6)
    .setTitle(whisper.anonymous ? "🕵️ همسة مجهولة" : "💬 همسة خاصة")
    .setDescription(`**${whisper.body}**`)
    .setTimestamp(whisper.created_at);

  if (!whisper.anonymous && whisper.sender_name) {
    embed.addFields({ name: "المرسل", value: whisper.sender_name });
  }

  return embed;
}

async function getWhisper(whisperId: string) {
  const result = await pool.query<WhisperMessageRow>(
    `SELECT whisper_id, channel_id, message_id, recipient_id, sender_name,
            body, anonymous, created_at, opened_at
     FROM discord_whisper_messages
     WHERE whisper_id = $1`,
    [whisperId],
  );
  return result.rows[0] ?? null;
}

function hasDiscordErrorCode(error: unknown, expectedCode: number) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === expectedCode || code === String(expectedCode);
}

function isUnknownDiscordMessage(error: unknown) {
  return hasDiscordErrorCode(error, 10008);
}

let whisperExpirationCleanupRunning = false;
let whisperExpirationCleanupTimer: NodeJS.Timeout | undefined;

async function cleanupExpiredWhispers() {
  if (whisperExpirationCleanupRunning) return;
  whisperExpirationCleanupRunning = true;

  try {
    const expiredWhispers = await pool.query<{
      whisper_id: string;
      channel_id: string;
      message_id: string | null;
    }>(
      `SELECT whisper_id, channel_id, message_id
       FROM discord_whisper_messages
       WHERE (opened_at IS NULL AND retention_started_at <= now() - interval '48 hours')
          OR (opened_at IS NOT NULL AND opened_at <= now() - interval '24 hours')
       ORDER BY created_at
       LIMIT 100`,
    );

    let deletedCount = 0;
    for (const whisper of expiredWhispers.rows) {
      try {
        await pool.query(
          `UPDATE discord_whisper_messages
           SET body = ''
           WHERE whisper_id = $1
             AND (
               (opened_at IS NULL AND retention_started_at <= now() - interval '48 hours')
               OR (opened_at IS NOT NULL AND opened_at <= now() - interval '24 hours')
             )`,
          [whisper.whisper_id],
        );

        if (whisper.message_id) {
          const channel = await client.channels.fetch(whisper.channel_id);
          if (!channel || channel.type !== ChannelType.GuildText) {
            throw new Error("Expired whisper channel is unavailable.");
          }

          const message = await channel.messages
            .fetch(whisper.message_id)
            .catch((error: unknown) => {
              if (isUnknownDiscordMessage(error)) return null;
              throw error;
            });
          if (message) await message.delete();
        }

        const deleted = await pool.query(
          `DELETE FROM discord_whisper_messages
           WHERE whisper_id = $1
             AND (
               (opened_at IS NULL AND created_at <= now() - interval '48 hours')
               OR (opened_at IS NOT NULL AND opened_at <= now() - interval '24 hours')
             )`,
          [whisper.whisper_id],
        );
        deletedCount += deleted.rowCount ?? 0;
      } catch (error) {
        writeLog("warn", "whisper_expiration_cleanup_item_failed", {
          channelId: whisper.channel_id,
          ...safeErrorDetails(error),
        });
      }
    }

    if (deletedCount > 0) {
      writeLog("info", "expired_whispers_deleted", { count: deletedCount });
    }
  } catch (error) {
    writeLog("error", "whisper_expiration_cleanup_failed", safeErrorDetails(error));
  } finally {
    whisperExpirationCleanupRunning = false;
  }
}

function startWhisperExpirationCleanup() {
  if (whisperExpirationCleanupTimer) return;
  void cleanupExpiredWhispers();
  whisperExpirationCleanupTimer = setInterval(
    () => void cleanupExpiredWhispers(),
    60_000,
  );
  whisperExpirationCleanupTimer.unref();
}

async function replyPrivately(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
) {
  const deferredEphemeralReply =
    interaction.isModalSubmit() ||
    (interaction.isButton() &&
      ["settings", "toggle_comments", "request_delete", "open"].includes(
        interaction.customId.split(":")[1] ?? "",
      ));

  if (interaction.deferred && deferredEphemeralReply) {
    await interaction.editReply({ content, components: [] });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

async function showSettings(interaction: ButtonInteraction, post: ImagePost) {
  if (!canManagePost(interaction, post)) {
    await interaction.editReply(
      "يمكن لصاحب المنشور أو مشرف السيرفر إدارة هذا المنشور فقط.",
    );
    return;
  }

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`post:edit_caption:${post.message_id}`)
      .setLabel("تعديل النص")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`post:toggle_comments:${post.message_id}`)
      .setLabel(post.comments_locked ? "فتح التعليقات" : "قفل التعليقات")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`post:request_delete:${post.message_id}`)
      .setLabel("حذف المنشور")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({
    content: "إعدادات هذا المنشور:",
    components: [controls],
  });
}

async function notifyPostAuthorOfLike(
  interaction: ButtonInteraction,
  post: ImagePost,
  message: Message,
  images: Array<{ fileName: string; url: string }>,
  likeCount: number,
) {
  try {
    const author = await client.users.fetch(post.author_id);
    const embed = new EmbedBuilder()
      .setColor(0xe8798f)
      .setTitle("إعجاب جديد على صورتك")
      .setURL(message.url)
      .setAuthor({
        name: interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setDescription("أعجب هذا الشخص بالصورة التي نشرتها.")
      .addFields({
        name: "إجمالي الإعجابات",
        value: String(likeCount),
        inline: true,
      })
      .setFooter({ text: "اضغط على العنوان لفتح المنشور" })
      .setTimestamp();

    if (images[0]) embed.setImage(images[0].url);
    await author.send({ embeds: [embed] });
  } catch (error) {
    writeLog("warn", "like_notification_failed", safeErrorDetails(error));
  }
}

async function toggleLike(interaction: ButtonInteraction, post: ImagePost) {
  const alreadyLiked = await userHasLiked(post.message_id, interaction.user.id);
  if (alreadyLiked && interaction.component.style !== ButtonStyle.Danger) {
    const [likeCount, { message, images }] = await Promise.all([
      getLikeCount(post.message_id),
      fetchPostMessage(post),
    ]);
    await editPostCard(
      message,
      post,
      images,
      post.message_id,
      likeCount,
      post.comments_locked,
    );
    await interaction.followUp({
      content: "تمت مزامنة حالة الإعجاب. اضغط مرة أخرى إذا أردت إزالة إعجابك.",
      ephemeral: true,
    });
    return;
  }

  const deleted = await pool.query(
    `DELETE FROM discord_image_post_likes
     WHERE message_id = $1 AND user_id = $2`,
    [post.message_id, interaction.user.id],
  );
  let newLike = false;
  if ((deleted.rowCount ?? 0) === 0) {
    const inserted = await pool.query(
      `INSERT INTO discord_image_post_likes (message_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [post.message_id, interaction.user.id],
    );
    newLike = (inserted.rowCount ?? 0) > 0;
  }

  const likeCount = await getLikeCount(post.message_id);
  const { message, images } = await fetchPostMessage(post);
  await editPostCard(
    message,
    post,
    images,
    post.message_id,
    likeCount,
    post.comments_locked,
  );
  if (newLike) {
    await notifyPostAuthorOfLike(interaction, post, message, images, likeCount);
  }
}

async function handleWhisperButton(
  interaction: ButtonInteraction,
  action: string | undefined,
  value: string | undefined,
) {
  const channelId = interaction.channelId;
  if (!isWhisperChannelId(channelId)) {
    await replyPrivately(interaction, "هذا الزر غير متاح هنا.");
    return;
  }

  if (action === "send") {
    const panel = await pool.query<{ message_id: string }>(
      `SELECT message_id
       FROM discord_whisper_panels
       WHERE channel_id = $1`,
      [channelId],
    );
    if (panel.rows[0]?.message_id !== interaction.message.id) {
      await replyPrivately(interaction, "لوحة الهمسات لم تعد متاحة.");
      return;
    }

    await interaction.reply({
      content: "اختر طريقة إرسال الهمسة:",
      components: [buildWhisperModeButtons()],
      ephemeral: true,
    });
    return;
  }

  if (action === "mode") {
    if (!isWhisperMode(value)) {
      await interaction.update({
        content: "تعذر اختيار طريقة الإرسال. أعد المحاولة من لوحة الهمسات.",
        components: [],
      });
      return;
    }

    await interaction.update({
      content:
        value === "anonymous"
          ? "اختر الشخص الذي تريد إرسال الهمسة إليه. لن نُظهر هويتك للمستلم."
          : "اختر الشخص الذي تريد إرسال الهمسة إليه. سيظهر اسمك للمستلم فقط.",
      components: [buildWhisperRecipientSelect(value)],
    });
    return;
  }

  if (action === "open" && value) {
    await interaction.deferReply({ ephemeral: true });
    const whisper = await getWhisper(value);
    if (
      !whisper ||
      whisper.channel_id !== channelId ||
      whisper.message_id !== interaction.message.id
    ) {
      await interaction.editReply("هذه الهمسة لم تعد متاحة.");
      return;
    }

    if (interaction.user.id !== whisper.recipient_id) {
      await interaction.editReply("هذه الهمسة مخصصة للمستلم المحدد فقط.");
      return;
    }

    const openedResult = await pool.query<WhisperMessageRow>(
      `UPDATE discord_whisper_messages
       SET opened_at = COALESCE(opened_at, now())
       WHERE whisper_id = $1
         AND channel_id = $2
         AND message_id = $3
         AND recipient_id = $4
         AND body <> ''
         AND (
           (opened_at IS NULL AND retention_started_at > now() - interval '48 hours')
           OR (opened_at IS NOT NULL AND opened_at > now() - interval '24 hours')
         )
       RETURNING whisper_id, channel_id, message_id, recipient_id, sender_name,
                 body, anonymous, created_at, opened_at`,
      [
        whisper.whisper_id,
        channelId,
        interaction.message.id,
        interaction.user.id,
      ],
    );
    const openedWhisper = openedResult.rows[0];
    if (!openedWhisper?.opened_at) {
      await interaction.editReply("انتهت مدة الهمسة ولم تعد متاحة.");
      return;
    }

    const expiryTimestamp = Math.floor(
      (openedWhisper.opened_at.getTime() + 24 * 60 * 60 * 1000) / 1000,
    );
    try {
      await interaction.message.edit({
        content: buildWhisperCardContent(
          openedWhisper.recipient_id,
          new Date(expiryTimestamp * 1000),
        ),
        embeds: [buildWhisperCardEmbed(openedWhisper.anonymous ? "anonymous" : "identified")],
        components: [buildWhisperOpenButton(openedWhisper.whisper_id)],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      writeLog("warn", "whisper_card_countdown_update_failed", {
        channelId,
        ...safeErrorDetails(error),
      });
    }

    await interaction.editReply({
      content: `محتوى الهمسة الخاصة بك:\n⏳ تُحذف تلقائياً <t:${expiryTimestamp}:R>.`,
      embeds: [buildPrivateWhisperEmbed(openedWhisper)],
      allowedMentions: { parse: [] },
    });
  }
}

async function handleWhisperRecipientSelect(
  interaction: UserSelectMenuInteraction,
) {
  const [prefix, action, mode] = interaction.customId.split(":");
  const recipientId = interaction.values[0];
  const channelId = interaction.channelId;
  if (
    prefix !== "whisper" ||
    action !== "recipient" ||
    !isWhisperMode(mode) ||
    !isWhisperChannelId(channelId) ||
    !interaction.guildId ||
    !recipientId
  ) {
    await interaction.reply({
      content: "تعذر تحديد مستلم الهمسة. أعد المحاولة من لوحة الهمسات.",
      ephemeral: true,
    });
    return;
  }

  await interaction.showModal(makeWhisperModal(mode, recipientId));
}

async function handleWhisperSubmit(
  interaction: ModalSubmitInteraction,
  mode: string | undefined,
  recipientId: string | undefined,
) {
  await interaction.deferReply({ ephemeral: true });
  const channelId = interaction.channelId;
  if (
    !isWhisperMode(mode) ||
    !recipientId ||
    !isWhisperChannelId(channelId) ||
    !interaction.guildId
  ) {
    await interaction.editReply("تعذر إرسال الهمسة. ابدأ من لوحة الهمسات وحاول مرة أخرى.");
    return;
  }

  const body = interaction.fields.getTextInputValue("body").trim();
  if (!body) {
    await interaction.editReply("اكتب نص الهمسة قبل الإرسال.");
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.guildId !== interaction.guildId
  ) {
    await interaction.editReply("قناة الهمسات غير متاحة حالياً.");
    return;
  }

  if (getWhisperChannelMissingPermissions(channel).length > 0) {
    await interaction.editReply("البوت لا يملك الصلاحيات اللازمة لإرسال الهمسة.");
    return;
  }

  const recipient = await channel.guild.members.fetch(recipientId).catch(() => null);
  if (!recipient || recipient.user.bot) {
    await interaction.editReply("اختر عضواً موجوداً في السيرفر لاستلام الهمسة.");
    return;
  }

  let senderName: string | null = null;
  if (mode === "identified") {
    const sender = await channel.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    senderName =
      sender?.displayName ?? interaction.user.globalName ?? interaction.user.username;
  }
  const whisperId = interaction.id;

  let cardMessage: Message | null = null;
  try {
    const insertedWhisper = await pool.query<{ created_at: Date }>(
      `INSERT INTO discord_whisper_messages
         (whisper_id, channel_id, recipient_id, sender_name, body, anonymous)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [
        whisperId,
        channelId,
        recipientId,
        senderName,
        body,
        mode === "anonymous",
      ],
    );
    const createdAt = insertedWhisper.rows[0]?.created_at;
    if (!createdAt) throw new Error("The whisper creation time was not returned.");

    cardMessage = await channel.send({
      content: buildWhisperCardContent(
        recipientId,
        new Date(createdAt.getTime() + 48 * 60 * 60 * 1000),
      ),
      embeds: [buildWhisperCardEmbed(mode)],
      components: [buildWhisperOpenButton(whisperId)],
      allowedMentions: { parse: [], users: [recipientId] },
    });
    await pool.query(
      `UPDATE discord_whisper_messages
       SET message_id = $2
       WHERE whisper_id = $1`,
      [whisperId, cardMessage.id],
    );
  } catch (error) {
    if (cardMessage) {
      await cardMessage.delete().catch((cleanupError: unknown) => {
        writeLog("warn", "whisper_card_cleanup_failed", {
          channelId,
          ...safeErrorDetails(cleanupError),
        });
      });
    }
    await pool
      .query(`DELETE FROM discord_whisper_messages WHERE whisper_id = $1`, [whisperId])
      .catch(() => undefined);
    writeLog("error", "whisper_send_failed", {
      channelId,
      ...safeErrorDetails(error),
    });
    await interaction.editReply("تعذر إرسال الهمسة. لم يُنشر محتواها في القناة.");
    return;
  }

  let panelMoved = false;
  try {
    panelMoved = await queueWhisperPanelMove(channel);
  } catch (error) {
    writeLog("warn", "whisper_panel_move_failed", {
      channelId,
      ...safeErrorDetails(error),
    });
  }

  const successMessage =
    mode === "anonymous"
      ? `تم إرسال همستك المجهولة إلى ${recipient.displayName}.`
      : `تم إرسال همستك إلى ${recipient.displayName}. سيظهر اسمك له فقط.`;
  await interaction.editReply(
    panelMoved
      ? successMessage
      : `${successMessage}\nتعذر نقل لوحة الإرسال إلى أسفل القناة؛ تحقق من صلاحيات البوت.`,
  );
}

async function handleButton(interaction: ButtonInteraction) {
  const [prefix, action, messageId] = interaction.customId.split(":");
  if (prefix === "whisper") {
    await handleWhisperButton(interaction, action, messageId);
    return;
  }
  if (prefix !== "post" || !action || !messageId) return;

  if (action === "comment") {
    await interaction.showModal(makeCommentModal(messageId));
    return;
  }

  if (action === "like" || action === "confirm_delete") {
    await interaction.deferUpdate();
  } else if (
    action === "settings" ||
    action === "toggle_comments" ||
    action === "request_delete"
  ) {
    await interaction.deferReply({ ephemeral: true });
  }

  const post = await getPost(messageId);
  const actionIsOnEphemeralReply = [
    "edit_caption",
    "toggle_comments",
    "request_delete",
    "confirm_delete",
  ].includes(action);
  if (!post || !isPostMessage(interaction, post, actionIsOnEphemeralReply)) {
    if (
      interaction.deferred &&
      ["settings", "toggle_comments", "request_delete"].includes(action)
    ) {
      await interaction.editReply("هذا المنشور لم يعد متاحاً.");
      return;
    }
    await replyPrivately(interaction, "هذا المنشور لم يعد متاحاً.");
    return;
  }

  if (action === "like") {
    await toggleLike(interaction, post);
    return;
  }

  if (action === "settings") {
    await showSettings(interaction, post);
    return;
  }

  if (!canManagePost(interaction, post)) {
    await replyPrivately(interaction, "يمكن لصاحب المنشور أو مشرف السيرفر استخدام هذا الخيار فقط.");
    return;
  }

  if (action === "edit_caption") {
    await interaction.showModal(makeCaptionModal(post));
    return;
  }

  if (action === "toggle_comments") {
    const commentsLocked = !post.comments_locked;
    await pool.query(
      `UPDATE discord_image_posts SET comments_locked = $2 WHERE message_id = $1`,
      [post.message_id, commentsLocked],
    );
    const updatedPost = { ...post, comments_locked: commentsLocked };
    const likeCount = await getLikeCount(post.message_id);
    const { message, images } = await fetchPostMessage(updatedPost);
    await editPostCard(
      message,
      updatedPost,
      images,
      post.message_id,
      likeCount,
      commentsLocked,
    );
    await interaction.editReply(
      commentsLocked ? "تم قفل التعليقات." : "تم فتح التعليقات.",
    );
    return;
  }

  if (action === "request_delete") {
    const confirmation = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`post:confirm_delete:${post.message_id}`)
        .setLabel("نعم، احذف المنشور والنقاش")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({
      content: "سيُحذف منشور الصورة ونقاشه وجميع الإعجابات المسجلة. هل تريد المتابعة؟",
      components: [confirmation],
    });
    return;
  }

  if (action === "confirm_delete") {
    const { channel, message } = await fetchPostMessage(post);
    if (post.thread_id) {
      const thread = await channel.threads.fetch(post.thread_id).catch(() => null);
      if (thread) await thread.delete("Post deleted by its owner or a moderator").catch(() => null);
    }
    await message.delete();
    await pool.query(
      `DELETE FROM discord_image_posts WHERE message_id = $1`,
      [post.message_id],
    );
    await interaction.editReply({
      content: "تم حذف المنشور والنقاش.",
      components: [],
    });
  }
}

async function getOrCreateCommentThread(post: ImagePost) {
  const { channel, message } = await fetchPostMessage(post);
  let thread = post.thread_id
    ? await channel.threads.fetch(post.thread_id).catch(() => null)
    : null;

  if (thread?.archived) await thread.setArchived(false);
  if (!thread) {
    const threadName = `تعليقات ${post.author_name}`.slice(0, 100);
    thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1_440,
      reason: "Open a discussion for an image post",
    });
    await pool.query(
      `UPDATE discord_image_posts SET thread_id = $2 WHERE message_id = $1`,
      [post.message_id, thread.id],
    );
  }

  return thread;
}

function commentMemberKey(threadId: string, userId: string) {
  return `${threadId}:${userId}`;
}

async function withCommentMemberQueue<T>(
  threadId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = commentMemberKey(threadId, userId);
  const previous = commentMemberQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => gate,
    () => gate,
  );
  commentMemberQueues.set(key, queued);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (commentMemberQueues.get(key) === queued) {
      commentMemberQueues.delete(key);
    }
  }
}

function scheduleCommentMemberRemoval(
  activity: ThreadCommentActivityRow,
  delayOverrideMs?: number,
) {
  const key = commentMemberKey(activity.thread_id, activity.user_id);
  const previousTimer = commentMemberRemovalTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);

  const remainingMs =
    delayOverrideMs ??
    Math.max(
      0,
      activity.last_comment_at.getTime() + commentInactivityMs - Date.now(),
    );
  const timer = setTimeout(() => {
    if (commentMemberRemovalTimers.get(key) !== timer) return;
    commentMemberRemovalTimers.delete(key);
    void removeInactiveThreadCommenter(activity).catch(async (error: unknown) => {
      writeLog("warn", "image_comment_member_expulsion_failed", {
        guildId: activity.guild_id,
        channelId: activity.thread_id,
        userId: activity.user_id,
        ...safeErrorDetails(error),
      });
      try {
        const current = await pool.query<ThreadCommentActivityRow>(
          `SELECT post_message_id, guild_id, thread_id, user_id, last_comment_at
           FROM discord_image_thread_comment_activity
           WHERE thread_id = $1 AND user_id = $2`,
          [activity.thread_id, activity.user_id],
        );
        const latestActivity = current.rows[0];
        if (!latestActivity) return;
        const hasNewActivity =
          latestActivity.last_comment_at.getTime() !==
          activity.last_comment_at.getTime();
        scheduleCommentMemberRemoval(
          latestActivity,
          hasNewActivity ? undefined : commentRemovalRetryMs,
        );
      } catch (retryError) {
        writeLog("error", "image_comment_member_retry_schedule_failed", {
          guildId: activity.guild_id,
          channelId: activity.thread_id,
          userId: activity.user_id,
          ...safeErrorDetails(retryError),
        });
      }
    });
  }, remainingMs);
  timer.unref();
  commentMemberRemovalTimers.set(key, timer);
}

async function removeInactiveThreadCommenter(
  initialActivity: ThreadCommentActivityRow,
) {
  await withCommentMemberQueue(
    initialActivity.thread_id,
    initialActivity.user_id,
    async () => {
      const current = await pool.query<ThreadCommentActivityRow>(
        `SELECT post_message_id, guild_id, thread_id, user_id, last_comment_at
         FROM discord_image_thread_comment_activity
         WHERE thread_id = $1 AND user_id = $2`,
        [initialActivity.thread_id, initialActivity.user_id],
      );
      const activity = current.rows[0];
      if (!activity) return;

      const remainingMs =
        activity.last_comment_at.getTime() + commentInactivityMs - Date.now();
      if (remainingMs > 0) {
        scheduleCommentMemberRemoval(activity);
        return;
      }

      let thread;
      try {
        thread = await client.channels.fetch(activity.thread_id);
      } catch (error) {
        if (hasDiscordErrorCode(error, 10003)) {
          await pool.query(
            `DELETE FROM discord_image_thread_comment_activity
             WHERE post_message_id = $1
               AND thread_id = $2
               AND user_id = $3
               AND last_comment_at = $4`,
            [
              activity.post_message_id,
              activity.thread_id,
              activity.user_id,
              activity.last_comment_at,
            ],
          );
          return;
        }
        throw error;
      }

      if (!thread || !thread.isThread()) {
        await pool.query(
          `DELETE FROM discord_image_thread_comment_activity
           WHERE post_message_id = $1
             AND thread_id = $2
             AND user_id = $3
             AND last_comment_at = $4`,
          [
            activity.post_message_id,
            activity.thread_id,
            activity.user_id,
            activity.last_comment_at,
          ],
        );
        return;
      }

      const botMember = thread.guild.members.me ?? (await thread.guild.members.fetchMe());
      const permissions = thread.permissionsFor(botMember);
      if (!permissions?.has(PermissionFlagsBits.ManageThreads)) {
        throw new Error("The bot needs Manage Threads to remove inactive commenters.");
      }

      try {
        await thread.members.remove(activity.user_id);
      } catch (error) {
        if (!hasDiscordErrorCode(error, 10007)) throw error;
      }

      const deleted = await pool.query(
        `DELETE FROM discord_image_thread_comment_activity
         WHERE post_message_id = $1
           AND thread_id = $2
           AND user_id = $3
           AND last_comment_at = $4`,
        [
          activity.post_message_id,
          activity.thread_id,
          activity.user_id,
          activity.last_comment_at,
        ],
      );
      if ((deleted.rowCount ?? 0) > 0) {
        writeLog("info", "image_comment_member_removed", {
          guildId: activity.guild_id,
          channelId: activity.thread_id,
          postMessageId: activity.post_message_id,
          userId: activity.user_id,
        });
      }
    },
  );
}

async function recordThreadCommentActivity(
  postMessageId: string,
  thread: ThreadChannel,
  userId: string,
  activityAt: Date,
  addToThread: boolean,
) {
  return withCommentMemberQueue(thread.id, userId, async () => {
    const result = await pool.query<ThreadCommentActivityRow>(
      `INSERT INTO discord_image_thread_comment_activity
         (post_message_id, guild_id, thread_id, user_id, last_comment_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_id, user_id)
       DO UPDATE SET
         post_message_id = EXCLUDED.post_message_id,
         guild_id = EXCLUDED.guild_id,
         last_comment_at = GREATEST(
           discord_image_thread_comment_activity.last_comment_at,
           EXCLUDED.last_comment_at
         )
       RETURNING post_message_id, guild_id, thread_id, user_id, last_comment_at`,
      [postMessageId, thread.guild.id, thread.id, userId, activityAt],
    );
    const activity = result.rows[0];
    if (!activity) throw new Error("Could not record the image-thread comment.");

    let memberAdded = true;
    if (addToThread) {
      const botMember =
        thread.guild.members.me ?? (await thread.guild.members.fetchMe());
      if (
        !botMember ||
        !thread
          .permissionsFor(botMember)
          ?.has(PermissionFlagsBits.ManageThreads)
      ) {
        memberAdded = false;
      } else {
        try {
          await thread.members.add(userId);
        } catch (error) {
          memberAdded = false;
          writeLog("warn", "image_comment_member_add_failed", {
            guildId: thread.guild.id,
            channelId: thread.id,
            userId,
            ...safeErrorDetails(error),
          });
        }
      }
    }

    scheduleCommentMemberRemoval(activity);
    return memberAdded;
  });
}

async function handleImageThreadComment(message: Message) {
  if (message.author.bot || !message.guildId || !message.channel.isThread()) return;
  if (!message.channel.parentId) return;

  const post = await pool.query<{ message_id: string }>(
    `SELECT message_id
     FROM discord_image_posts
     WHERE thread_id = $1
       AND channel_id = $2`,
    [message.channel.id, message.channel.parentId],
  );
  const postMessageId = post.rows[0]?.message_id;
  if (!postMessageId) return;

  await recordThreadCommentActivity(
    postMessageId,
    message.channel,
    message.author.id,
    message.createdAt,
    false,
  );
}

async function restorePendingCommentMemberRemovals() {
  const pending = await pool.query<ThreadCommentActivityRow>(
    `SELECT post_message_id, guild_id, thread_id, user_id, last_comment_at
     FROM discord_image_thread_comment_activity`,
  );
  for (const activity of pending.rows) {
    scheduleCommentMemberRemoval(activity);
  }
  writeLog("info", "image_comment_member_cleanup_ready", {
    pendingCount: pending.rows.length,
  });
}

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  const [prefix, action, messageId, recipientId] = interaction.customId.split(":");
  if (prefix === "whisper" && action === "submit") {
    await handleWhisperSubmit(interaction, messageId, recipientId);
    return;
  }
  if (prefix !== "post" || !action || !messageId) return;
  if (action !== "caption_submit" && action !== "comment_submit") return;

  await interaction.deferReply({ ephemeral: true });
  const post = await getPost(messageId);
  if (!post || interaction.channelId !== post.channel_id) {
    await interaction.editReply("هذا المنشور لم يعد متاحاً.");
    return;
  }

  if (action === "caption_submit") {
    if (!canManagePost(interaction, post)) {
      await interaction.editReply(
        "يمكن لصاحب المنشور أو مشرف السيرفر تعديل النص فقط.",
      );
      return;
    }
    const caption = interaction.fields.getTextInputValue("caption");
    await updatePostCaption(post, caption);
    await interaction.editReply("تم تحديث كتابة المنشور.");
    return;
  }

  if (action === "comment_submit") {
    if (post.comments_locked) {
      await interaction.editReply("التعليقات مقفلة لهذا المنشور.");
      return;
    }
    const comment = interaction.fields.getTextInputValue("comment").trim();
    if (!comment) {
      await interaction.editReply("اكتب تعليقاً قبل الإرسال.");
      return;
    }

    const thread = await getOrCreateCommentThread(post);
    await thread.send({
      content: `<@${interaction.user.id}>: ${comment}`,
      allowedMentions: { parse: [], users: [interaction.user.id] },
    });
    let memberAdded = false;
    try {
      memberAdded = await recordThreadCommentActivity(
        post.message_id,
        thread,
        interaction.user.id,
        new Date(),
        true,
      );
    } catch (error) {
      writeLog("warn", "image_comment_activity_schedule_failed", {
        guildId: thread.guild.id,
        channelId: thread.id,
        postMessageId: post.message_id,
        userId: interaction.user.id,
        ...safeErrorDetails(error),
      });
      await interaction.editReply(
        "تم نشر تعليقك، لكن تعذر إعداد الخروج التلقائي من الثريد بعد خمس دقائق.",
      );
      return;
    }
    if (!memberAdded) {
      await interaction.editReply(
        "تم نشر تعليقك، لكن يحتاج البوت صلاحية إدارة الثريد حتى يضيفك مؤقتاً ثم يخرجك بعد خمس دقائق.",
      );
      return;
    }
    await interaction.editReply("تم نشر تعليقك في نقاش الصورة.");
  }
}

const supportedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isSupportedImage(attachment: Attachment) {
  const contentType = attachment.contentType?.split(";")[0].toLowerCase();
  const extensionMatches = /\.(jpe?g|png|gif|webp)$/i.test(attachment.name);
  return (
    (contentType !== null && contentType !== undefined && supportedImageTypes.has(contentType)) ||
    (!contentType && extensionMatches)
  );
}

function safeFileName(messageId: string, index: number, originalName: string) {
  const cleaned = originalName
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-70);
  return `${messageId}-${index + 1}-${cleaned || `image-${index + 1}.png`}`;
}

async function downloadImage(
  attachment: Attachment,
  fileName: string,
): Promise<DownloadedImage> {
  if (attachment.size > maxUploadBytes) {
    throw new UserFacingError("حجم الصورة أكبر من الحد المدعوم حالياً؛ أبقيت الرسالة الأصلية كما هي.");
  }

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error("Image download failed.");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxUploadBytes) {
    throw new UserFacingError("حجم الصورة أكبر من الحد المدعوم حالياً؛ أبقيت الرسالة الأصلية كما هي.");
  }

  const responseType = response.headers.get("content-type")?.split(";")[0].toLowerCase();
  if (responseType && !supportedImageTypes.has(responseType) && responseType !== "application/octet-stream") {
    throw new UserFacingError("تعذر التحقق من نوع الصورة؛ أبقيت الرسالة الأصلية كما هي.");
  }

  return {
    buffer,
    fileName,
  };
}

async function sendMessageNotice(message: Message, content: string) {
  await message
    .reply({
      content,
      allowedMentions: { repliedUser: false },
    })
    .catch(() => null);
}

function hasRequiredChannelPermissions(channel: TextChannel) {
  const member = channel.guild.members.me;
  if (!member) return false;
  const permissions = channel.permissionsFor(member);
  if (!permissions) return false;
  return permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageMessages,
  ]);
}

function getFormattedMessageChannelMissingPermissions(channel: TextChannel) {
  const requiredPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
  ];
  const member = channel.guild.members.me;
  const permissions = member ? channel.permissionsFor(member) : null;
  return permissions
    ? requiredPermissions
        .filter(([permission]) => !permissions.has(permission))
        .map(([, name]) => name)
    : requiredPermissions.map(([, name]) => name);
}

async function handleImageMessage(message: Message) {
  if (
    message.author.bot ||
    !imagePostChannelIds.has(message.channelId) ||
    !message.inGuild() ||
    message.channel.type !== ChannelType.GuildText ||
    message.attachments.size === 0
  ) {
    return;
  }

  const attachments = [...message.attachments.values()];
  const images = attachments.filter(isSupportedImage);

  if (images.length === 0 || images.length !== attachments.length || images.length > 10) {
    return;
  }

  const declaredTotalSize = images.reduce((total, image) => total + image.size, 0);
  if (declaredTotalSize > maxUploadBytes) {
    await sendMessageNotice(
      message,
      "حجم الصور يتجاوز الحد المدعوم حالياً؛ أبقيت الرسالة الأصلية كما هي.",
    );
    return;
  }

  if (!hasRequiredChannelPermissions(message.channel)) {
    writeLog("warn", "channel_permissions_missing", {
      channelId: message.channelId,
    });
    return;
  }

  const existingPost = await getPost(message.id);
  if (existingPost) {
    const { message: replacement, images: existingImages } =
      await fetchPostMessage(existingPost);
    const likeCount = await getLikeCount(existingPost.message_id);
    const recoveredMessage = await editPostCard(
      replacement,
      existingPost,
      existingImages,
      existingPost.message_id,
      likeCount,
      existingPost.comments_locked,
    );
    await ensureUploadedImages(recoveredMessage, existingImages.length);
    await message.delete();
    writeLog("info", "image_post_recovered", {
      channelId: message.channelId,
      postMessageId: recoveredMessage.id,
      sourceMessageId: message.id,
    });
    return;
  }

  let sentMessage: Message | null = null;
  let postSaved = false;
  let stage = "download_images";
  let postPresentation: Pick<
    ImagePost,
    "author_name" | "author_avatar_url" | "caption"
  > | null = null;
  let downloadedImages: DownloadedImage[] = [];
  let postImages: Array<{ fileName: string; url: string }> = [];

  try {
    downloadedImages = await Promise.all(
      images.map((image, index) =>
        downloadImage(image, safeFileName(message.id, index, image.name)),
      ),
    );
    postPresentation = {
      author_name: message.member?.displayName ?? message.author.username,
      author_avatar_url: message.author.displayAvatarURL({ extension: "png", size: 128 }),
      caption: message.content.slice(0, maxCaptionLength),
    };

    stage = "send_embed";
    const attachmentReferences = downloadedImages.map(({ fileName }) => ({
      fileName,
      url: `attachment://${fileName}`,
    }));
    const createdMessage = await message.channel.send({
      components: [
        buildPostContainer(
          postPresentation,
          attachmentReferences,
          message.id,
          0,
          false,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
      files: downloadedImages.map(
        ({ buffer, fileName }) => new AttachmentBuilder(buffer, { name: fileName }),
      ),
      allowedMentions: { parse: [] },
    });
    sentMessage = createdMessage;
    sentMessage = await ensureUploadedImages(
      sentMessage,
      downloadedImages.length,
    );
    postImages = getUploadedImageReferences(sentMessage, downloadedImages);
    stage = "save_post";
    const storedImageNames = postImages.map(({ fileName }) => fileName);

    if (!message.guildId) {
      throw new Error("Image posts must belong to a server.");
    }
    const databaseClient = await pool.connect();
    try {
      await databaseClient.query("BEGIN");
      await databaseClient.query(
        `INSERT INTO discord_image_posts
           (message_id, source_message_id, channel_id, author_id, author_name,
            author_avatar_url, caption, images)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          sentMessage.id,
          message.id,
          message.channelId,
          message.author.id,
          postPresentation.author_name,
          postPresentation.author_avatar_url,
          postPresentation.caption,
          JSON.stringify(storedImageNames),
        ],
      );
      if (message.channelId === profileImagePostChannelId) {
        await databaseClient.query(
          `INSERT INTO discord_profile_xp_awards
             (guild_id, message_id, user_id, xp_amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (guild_id, message_id) DO NOTHING`,
          [
            message.guildId,
            sentMessage.id,
            message.author.id,
            profileXpPerPost,
          ],
        );
      }
      await databaseClient.query("COMMIT");
    } catch (error) {
      await databaseClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      databaseClient.release();
    }
    postSaved = true;

    stage = "delete_original";
    await message.delete();
    writeLog("info", "image_post_created", {
      channelId: message.channelId,
      postMessageId: sentMessage.id,
      sourceMessageId: message.id,
      imageCount: downloadedImages.length,
    });
  } catch (error) {
    if (sentMessage && !postSaved) {
      await sentMessage.delete().catch((cleanupError: unknown) => {
        writeLog("warn", "incomplete_post_card_cleanup_failed", {
          channelId: message.channelId,
          ...safeErrorDetails(cleanupError),
        });
      });
    }

    if (error instanceof UserFacingError) {
      writeLog("warn", "image_post_not_completed", {
        channelId: message.channelId,
        sourceMessageId: message.id,
        stage,
      });
      await sendMessageNotice(message, error.userMessage);
    } else {
      writeLog("error", "image_post_failed", {
        channelId: message.channelId,
        sourceMessageId: message.id,
        stage,
        postMessageId: sentMessage?.id ?? "none",
        postSaved,
        ...safeErrorDetails(error),
      });
      await sendMessageNotice(
        message,
        stage === "delete_original"
          ? "تم إنشاء البطاقة التفاعلية، لكن تعذر حذف الرسالة الأصلية."
          : "تعذر إكمال البطاقة التفاعلية؛ أبقيت الرسالة الأصلية كما هي.",
      );
    }
  }
}

async function handleFormattedTextMessage(message: Message) {
  if (
    message.author.bot ||
    !formattedMessageChannelIds.some(
      (formattedChannelId) => formattedChannelId === message.channelId,
    ) ||
    !message.inGuild() ||
    message.channel.type !== ChannelType.GuildText ||
    message.attachments.size > 0 ||
    !message.content.trim()
  ) {
    return;
  }

  const channel = message.channel;
  if (getFormattedMessageChannelMissingPermissions(channel).length > 0) return;

  const authorName = message.member?.displayName ?? message.author.username;
  const avatarUrl = message.author.displayAvatarURL({ extension: "png", size: 256 });
  const embed = new EmbedBuilder()
    .setColor(0xe8798f)
    .setAuthor({ name: authorName, iconURL: avatarUrl })
    .setDescription(message.content)
    .setThumbnail(avatarUrl)
    .setFooter({ text: "رسالة نصية" })
    .setTimestamp(message.createdAt);

  let replacementMessage: Message;
  try {
    replacementMessage = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    writeLog("error", "formatted_message_send_failed", {
      channelId: message.channelId,
      sourceMessageId: message.id,
      ...safeErrorDetails(error),
    });
    return;
  }

  try {
    await message.delete();
    writeLog("info", "formatted_message_created", {
      channelId: message.channelId,
      sourceMessageId: message.id,
      replacementMessageId: replacementMessage.id,
    });
  } catch (error) {
    const originalStillExists = await channel.messages
      .fetch(message.id)
      .then(() => true)
      .catch(() => false);
    if (originalStillExists) {
      await replacementMessage.delete().catch((cleanupError: unknown) => {
        writeLog("warn", "formatted_message_cleanup_failed", {
          channelId: message.channelId,
          replacementMessageId: replacementMessage.id,
          ...safeErrorDetails(cleanupError),
        });
      });
    }
    writeLog("error", "formatted_message_delete_failed", {
      channelId: message.channelId,
      sourceMessageId: message.id,
      replacementMessageId: replacementMessage.id,
      ...safeErrorDetails(error),
    });
  }
}

async function retryConfiguredSourceMessage() {
  if (!retrySourceMessageId) return;
  writeLog("info", "retry_attempt_started", {
    channelId,
    sourceMessageId: retrySourceMessageId,
  });
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    writeLog("error", "retry_channel_unavailable", { channelId });
    return;
  }

  const sourceMessage = await channel.messages
    .fetch(retrySourceMessageId)
    .catch(() => null);
  if (!sourceMessage) {
    writeLog("warn", "retry_source_message_unavailable", {
      channelId,
      sourceMessageId: retrySourceMessageId,
    });
    return;
  }

  await handleImageMessage(sourceMessage);
  const post = await getPost(retrySourceMessageId);
  const remainingSource = await channel.messages
    .fetch(retrySourceMessageId)
    .then(() => true)
    .catch(() => false);
  writeLog("info", "retry_attempt_finished", {
    channelId,
    sourceMessageId: retrySourceMessageId,
    postFound: Boolean(post),
    sourceMessageRemains: remainingSource,
  });
}

async function recoverPendingImagePosts() {
  for (const imageChannelId of imagePostChannelIds) {
    const pendingPosts = await pool.query<ImagePostRow>(
      `SELECT message_id, source_message_id, channel_id, author_id, author_name,
              author_avatar_url, caption, images, comments_locked, thread_id
       FROM discord_image_posts
       WHERE channel_id = $1
         AND created_at >= now() - interval '1 day'
       ORDER BY created_at DESC
       LIMIT 25`,
      [imageChannelId],
    );
    const channel = await client.channels.fetch(imageChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) continue;

    for (const row of pendingPosts.rows) {
      const sourceMessage = await channel.messages
        .fetch(row.source_message_id)
        .catch(() => null);
      if (!sourceMessage) continue;

      writeLog("info", "pending_image_post_recovery_started", {
        channelId: imageChannelId,
        postMessageId: row.message_id,
        sourceMessageId: row.source_message_id,
      });
      await handleImageMessage(sourceMessage);
    }
  }
}

async function validateImagePostChannels() {
  const requiredPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
  ];
  const commentPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.CreatePublicThreads, "Create Public Threads"],
    [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
    [PermissionFlagsBits.ManageThreads, "Manage Threads"],
  ];

  for (const imageChannelId of imagePostChannelIds) {
    const isPrimaryChannel = imageChannelId === channelId;
    try {
      const channel = await client.channels.fetch(imageChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        writeLog(
          "error",
          isPrimaryChannel
            ? "configured_channel_unavailable"
            : "image_post_channel_unavailable",
          { channelId: imageChannelId },
        );
        continue;
      }

      if (isPrimaryChannel) {
        allowedGuildId = channel.guildId;
      } else {
        additionalAllowedGuildIds.add(channel.guildId);
      }

      const member = channel.guild.members.me;
      const permissions = member ? channel.permissionsFor(member) : null;
      const missingPermissions = permissions
        ? requiredPermissions
            .filter(([permission]) => !permissions.has(permission))
            .map(([, name]) => name)
        : requiredPermissions.map(([, name]) => name);

      if (missingPermissions.length > 0) {
        writeLog(
          "warn",
          isPrimaryChannel
            ? "channel_permissions_missing"
            : "image_post_channel_permissions_missing",
          {
            channelId: imageChannelId,
            permissions: missingPermissions.join(", "),
          },
        );
      } else {
        writeLog(
          "info",
          isPrimaryChannel ? "channel_ready" : "image_post_channel_ready",
          { channelId: imageChannelId },
        );
      }

      const missingCommentPermissions = permissions
        ? commentPermissions
            .filter(([permission]) => !permissions.has(permission))
            .map(([, name]) => name)
        : commentPermissions.map(([, name]) => name);
      if (missingCommentPermissions.length > 0) {
        writeLog(
          "warn",
          isPrimaryChannel
            ? "comment_permissions_missing"
            : "image_post_channel_comment_permissions_missing",
          {
            channelId: imageChannelId,
            permissions: missingCommentPermissions.join(", "),
          },
        );
      }
    } catch (error: unknown) {
      writeLog(
        "error",
        isPrimaryChannel
          ? "channel_validation_failed"
          : "image_post_channel_validation_failed",
        {
          channelId: imageChannelId,
          ...safeErrorDetails(error),
        },
      );
    }
  }
}

async function leaveUnauthorizedGuild(guild: Guild) {
  if (
    !allowedGuildId ||
    guild.id === allowedGuildId ||
    additionalAllowedGuildIds.has(guild.id)
  ) {
    return;
  }

  writeLog("warn", "unauthorized_guild_detected", { guildId: guild.id });
  try {
    await guild.leave();
    writeLog("info", "unauthorized_guild_left", { guildId: guild.id });
  } catch (error: unknown) {
    writeLog("error", "unauthorized_guild_leave_failed", {
      guildId: guild.id,
      ...safeErrorDetails(error),
    });
  }
}

async function leaveUnauthorizedGuilds() {
  if (!allowedGuildId) {
    writeLog("error", "allowed_guild_unresolved", { channelId });
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    await leaveUnauthorizedGuild(guild);
  }
}

async function validateFormattedMessageChannels() {
  for (const formattedChannelId of formattedMessageChannelIds) {
    try {
      const channel = await client.channels.fetch(formattedChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        writeLog("error", "formatted_message_channel_unavailable", {
          channelId: formattedChannelId,
        });
        continue;
      }

      const missingPermissions =
        getFormattedMessageChannelMissingPermissions(channel);
      if (missingPermissions.length > 0) {
        writeLog("warn", "formatted_message_channel_permissions_missing", {
          channelId: formattedChannelId,
          permissions: missingPermissions.join(", "),
        });
      } else {
        writeLog("info", "formatted_message_channel_ready", {
          channelId: formattedChannelId,
        });
      }
    } catch (error: unknown) {
      writeLog("error", "formatted_message_channel_validation_failed", {
        channelId: formattedChannelId,
        ...safeErrorDetails(error),
      });
    }
  }
}

function getWhisperChannelMissingPermissions(channel: TextChannel) {
  const requiredPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
  ];
  const member = channel.guild.members.me;
  const permissions = member ? channel.permissionsFor(member) : null;
  return permissions
    ? requiredPermissions
        .filter(([permission]) => !permissions.has(permission))
        .map(([, name]) => name)
    : requiredPermissions.map(([, name]) => name);
}

async function ensureWhisperPanel(channelId: string) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      writeLog("error", "whisper_channel_unavailable", { channelId });
      return;
    }

    const missingPermissions = getWhisperChannelMissingPermissions(channel);
    if (missingPermissions.length > 0) {
      writeLog("warn", "whisper_channel_permissions_missing", {
        channelId,
        permissions: missingPermissions.join(", "),
      });
      return;
    }

    const storedPanel = await pool.query<{ message_id: string }>(
      `SELECT message_id
       FROM discord_whisper_panels
       WHERE channel_id = $1`,
      [channelId],
    );
    const previousMessageId = storedPanel.rows[0]?.message_id;
    const previousPanel = previousMessageId
      ? await channel.messages.fetch(previousMessageId).catch(() => null)
      : null;

    const panelPayload = buildWhisperPanelPayload();

    if (previousPanel) {
      await previousPanel.edit(panelPayload);
      writeLog("info", "whisper_panel_ready", {
        channelId,
        messageId: previousPanel.id,
        reused: true,
      });
      return;
    }

    const newPanel = await channel.send(panelPayload);
    try {
      await pool.query(
        `INSERT INTO discord_whisper_panels (channel_id, message_id)
         VALUES ($1, $2)
         ON CONFLICT (channel_id)
         DO UPDATE SET message_id = EXCLUDED.message_id`,
        [channelId, newPanel.id],
      );
    } catch (error) {
      await newPanel.delete().catch(() => undefined);
      throw error;
    }

    writeLog("info", "whisper_panel_ready", {
      channelId,
      messageId: newPanel.id,
      reused: false,
    });
  } catch (error: unknown) {
    writeLog("error", "whisper_panel_setup_failed", {
      channelId,
      ...safeErrorDetails(error),
    });
  }
}

async function ensureWhisperPanels() {
  await Promise.all(whisperChannelIds.map((channelId) => ensureWhisperPanel(channelId)));
}

let whisperPanelMoveQueue: Promise<void> = Promise.resolve();

async function moveWhisperPanelToBottom(channel: TextChannel): Promise<boolean> {
  const channelId = channel.id;
  const storedPanel = await pool.query<{ message_id: string }>(
    `SELECT message_id
     FROM discord_whisper_panels
     WHERE channel_id = $1`,
    [channelId],
  );
  const previousMessageId = storedPanel.rows[0]?.message_id;
  const previousPanel = previousMessageId
    ? await channel.messages.fetch(previousMessageId).catch(() => null)
    : null;

  const newPanel = await channel.send(buildWhisperPanelPayload());
  try {
    await pool.query(
      `INSERT INTO discord_whisper_panels (channel_id, message_id)
       VALUES ($1, $2)
       ON CONFLICT (channel_id)
       DO UPDATE SET message_id = EXCLUDED.message_id`,
      [channelId, newPanel.id],
    );
  } catch (error) {
    await newPanel.delete().catch((cleanupError: unknown) => {
      writeLog("warn", "whisper_panel_replacement_cleanup_failed", {
        channelId,
        ...safeErrorDetails(cleanupError),
      });
    });
    throw error;
  }

  if (previousPanel) {
    try {
      await previousPanel.delete();
    } catch (error) {
      let restoredPreviousPanel = false;
      try {
        await pool.query(
          `UPDATE discord_whisper_panels
           SET message_id = $2
           WHERE channel_id = $1`,
          [channelId, previousPanel.id],
        );
        restoredPreviousPanel = true;
      } catch (restoreError) {
        writeLog("error", "whisper_panel_reference_restore_failed", {
          channelId,
          ...safeErrorDetails(restoreError),
        });
      }

      if (restoredPreviousPanel) {
        await newPanel.delete().catch((cleanupError: unknown) => {
          writeLog("warn", "whisper_panel_replacement_cleanup_failed", {
            channelId,
            ...safeErrorDetails(cleanupError),
          });
        });
      }

      writeLog("warn", "whisper_panel_old_message_delete_failed", {
        channelId,
        ...safeErrorDetails(error),
      });
      return false;
    }
  }

  writeLog("info", "whisper_panel_moved_to_bottom", {
    channelId,
    messageId: newPanel.id,
    replacedMessageId: previousMessageId ?? "none",
  });
  return true;
}

function queueWhisperPanelMove(channel: TextChannel): Promise<boolean> {
  const currentMove = whisperPanelMoveQueue.then(() =>
    moveWhisperPanelToBottom(channel),
  );
  whisperPanelMoveQueue = currentMove.then(
    () => undefined,
    () => undefined,
  );
  return currentMove;
}

client.on(Events.MessageCreate, (message) => {
  void handleImageMessage(message).catch((error: unknown) => {
    writeLog("error", "message_handler_failed", {
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.MessageCreate, (message) => {
  void handleImageThreadComment(message).catch((error: unknown) => {
    writeLog("error", "image_thread_comment_activity_failed", {
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.MessageCreate, (message) => {
  void handleFormattedTextMessage(message).catch((error: unknown) => {
    writeLog("error", "formatted_message_handler_failed", {
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  const action = interaction.isButton()
    ? handleButton(interaction)
    : interaction.isModalSubmit()
      ? handleModalSubmit(interaction)
      : interaction.isUserSelectMenu()
        ? handleWhisperRecipientSelect(interaction)
      : Promise.resolve();
  void action.catch(async (error: unknown) => {
    const interactionDetails: Record<string, string> = interaction.isButton()
      ? {
          interactionType: "button",
          action: interaction.customId.split(":")[1] ?? "unknown",
        }
      : interaction.isModalSubmit()
        ? {
            interactionType: "modal",
            action: interaction.customId.split(":")[1] ?? "unknown",
          }
        : { interactionType: "other" };
    writeLog("error", "interaction_failed", {
      ...interactionDetails,
      ...safeErrorDetails(error),
    });
    if (interaction.isButton() || interaction.isModalSubmit()) {
      await replyPrivately(interaction, "تعذر تنفيذ هذا الخيار حالياً. حاول مرة أخرى.");
    } else if (
      interaction.isUserSelectMenu() &&
      !interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.reply({
        content: "تعذر تنفيذ هذا الخيار حالياً. حاول مرة أخرى.",
        ephemeral: true,
      });
    }
  });
});

client.once(Events.ClientReady, (readyClient) => {
  writeLog("info", "discord_bot_ready", {
    bot: readyClient.user.tag,
    channelId,
    retryConfigured: Boolean(retrySourceMessageId),
  });
  let activityIndex = 0;
  const updateBotActivity = () => {
    readyClient.user.setPresence({
      activities: [
        {
          name: "Custom Status",
          type: ActivityType.Custom,
          state: botActivityMessages[activityIndex],
        },
        {
          name: botStreamingActivityName,
          type: ActivityType.Streaming,
          url: botStreamingUrl,
        },
      ],
      status: "online",
    });
    activityIndex = (activityIndex + 1) % botActivityMessages.length;
  };
  updateBotActivity();
  botActivityTimer = setInterval(updateBotActivity, 5_000);
  void validateImagePostChannels()
    .then(() => leaveUnauthorizedGuilds())
    .catch((error: unknown) => {
      writeLog("error", "channel_validation_failed", safeErrorDetails(error));
    });
  void validateFormattedMessageChannels();
  void ensureWhisperPanels();
  startWhisperExpirationCleanup();
  void retryConfiguredSourceMessage().catch((error: unknown) => {
    writeLog("error", "retry_source_failed", {
      sourceMessageId: retrySourceMessageId ?? "none",
      ...safeErrorDetails(error),
    });
  });
  void recoverPendingImagePosts().catch((error: unknown) => {
    writeLog("error", "pending_image_post_recovery_failed", safeErrorDetails(error));
  });
  void restorePendingCommentMemberRemovals().catch((error: unknown) => {
    writeLog("error", "image_comment_member_cleanup_restore_failed", {
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.Error, (error) => {
  writeLog("error", "discord_client_error", safeErrorDetails(error));
});

client.on(Events.GuildCreate, (guild) => {
  void leaveUnauthorizedGuild(guild);
});

async function shutdown(signal: string) {
  writeLog("info", "shutdown_started", { signal });
  stopDailyPostRewards();
  stopProfileCommand();
  stopTaskListFeature();
  stopForestLinkFeature();
  stopAuctionFeature();
  if (botActivityTimer) {
    clearInterval(botActivityTimer);
    botActivityTimer = undefined;
  }
  if (whisperExpirationCleanupTimer) {
    clearInterval(whisperExpirationCleanupTimer);
    whisperExpirationCleanupTimer = undefined;
  }
  for (const timer of commentMemberRemovalTimers.values()) {
    clearTimeout(timer);
  }
  commentMemberRemovalTimers.clear();
  client.destroy();
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  await initializeDatabase();
  await initializeDailyPostRewardTables(pool);
  await initializeProfileTables(pool);
  await initializeTaskListTables(pool);
  await initializeForestLinkTables(pool);
  await initializeAuctionTables(pool);
  stopDailyPostRewards = attachDailyPostRewards(client, pool);
  stopProfileCommand = attachProfileCommand(client, pool);
  stopTaskListFeature = attachTaskListFeature(client, pool);
  stopForestLinkFeature = attachForestLinkFeature(client, pool);
  stopAuctionFeature = attachAuctionFeature(client, pool);
  await client.login(token);
}

void main().catch(async (error: unknown) => {
  writeLog("error", "startup_failed", safeErrorDetails(error));
  stopDailyPostRewards();
  stopProfileCommand();
  stopTaskListFeature();
  stopForestLinkFeature();
  stopAuctionFeature();
  if (botActivityTimer) {
    clearInterval(botActivityTimer);
    botActivityTimer = undefined;
  }
  client.destroy();
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});