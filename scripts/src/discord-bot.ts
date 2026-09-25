import {
  ActionRowBuilder,
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
  type Attachment,
  type ButtonInteraction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import { Pool, type QueryResultRow } from "pg";

function requireEnvironmentValue(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const token = requireEnvironmentValue("DISCORD_BOT_TOKEN");
const channelId = requireEnvironmentValue("DISCORD_CHANNEL_ID");
const databaseUrl = requireEnvironmentValue("DATABASE_URL");
const retrySourceMessageId = process.env.DISCORD_RETRY_SOURCE_MESSAGE_ID;
const maxUploadBytes = 8 * 1024 * 1024;
const maxCaptionLength = 2_000;
const legacySeparator = "────────────────────────────────";

const pool = new Pool({ connectionString: databaseUrl });
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

type DownloadedImage = {
  attachment: AttachmentBuilder;
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

  const container = new ContainerBuilder()
    .addSectionComponents(header)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        images.map((image) => ({ media: { url: image.url } })),
      ),
    )
    .addSeparatorComponents(
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
  const images = post.images.map((fileName, index) => {
    const attachment = message.attachments.find((item) => item.name === fileName);
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
) {
  const attachments = [...message.attachments.keys()].map((id) => ({ id }));

  if (!message.flags.has(MessageFlags.IsComponentsV2)) {
    await message.edit({
      embeds: buildLegacyEmbeds(post, images),
      components: [buildPostButtons(messageId, likeCount, commentsLocked)],
      attachments,
    });
    return;
  }

  await message.edit({
    components: [
      buildPostContainer(post, images, messageId, likeCount, commentsLocked),
    ],
    flags: MessageFlags.IsComponentsV2,
    attachments,
  });
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

async function replyPrivately(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
) {
  const deferredEphemeralReply =
    interaction.isModalSubmit() ||
    (interaction.isButton() &&
      ["settings", "toggle_comments", "request_delete"].includes(
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
  if ((deleted.rowCount ?? 0) === 0) {
    await pool.query(
      `INSERT INTO discord_image_post_likes (message_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [post.message_id, interaction.user.id],
    );
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
}

async function handleButton(interaction: ButtonInteraction) {
  const [prefix, action, messageId] = interaction.customId.split(":");
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

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  const [prefix, action, messageId] = interaction.customId.split(":");
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
      content: `**${interaction.user.username}**: ${comment}`,
      allowedMentions: { parse: [] },
    });
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
    attachment: new AttachmentBuilder(buffer, { name: fileName }),
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

async function handleImageMessage(message: Message) {
  if (
    message.author.bot ||
    message.channelId !== channelId ||
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
    writeLog("warn", "channel_permissions_missing", { channelId });
    return;
  }

  const existingPost = await getPost(message.id);
  if (existingPost) {
    const { message: replacement, images: existingImages } =
      await fetchPostMessage(existingPost);
    const likeCount = await getLikeCount(existingPost.message_id);
    await editPostCard(
      replacement,
      existingPost,
      existingImages,
      existingPost.message_id,
      likeCount,
      existingPost.comments_locked,
    );
    await message.delete();
    writeLog("info", "image_post_recovered", {
      channelId,
      postMessageId: existingPost.message_id,
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
  let postImages: Array<{ fileName: string; url: string }> = [];

  try {
    const downloadedImages = await Promise.all(
      images.map((image, index) =>
        downloadImage(image, safeFileName(message.id, index, image.name)),
      ),
    );
    postPresentation = {
      author_name: message.member?.displayName ?? message.author.username,
      author_avatar_url: message.author.displayAvatarURL({ extension: "png", size: 128 }),
      caption: message.content.slice(0, maxCaptionLength),
    };
    postImages = downloadedImages.map(({ fileName }) => ({
        fileName,
        url: `attachment://${fileName}`,
      }));

    stage = "send_embed";
    const createdMessage = await message.channel.send({
      components: [
        buildPostContainer(postPresentation, postImages, message.id, 0, false, false),
      ],
      flags: MessageFlags.IsComponentsV2,
      files: downloadedImages.map((image) => image.attachment),
      allowedMentions: { parse: [] },
    });
    sentMessage = createdMessage;
    postImages = postImages.map(({ fileName }) => {
      const attachment = createdMessage.attachments.find(
        (item) => item.name === fileName,
      );
      if (!attachment) {
        throw new Error("An uploaded image attachment could not be found.");
      }
      return { fileName, url: attachment.url };
    });
    stage = "save_post";
    const storedImageNames = postImages.map(({ fileName }) => fileName);

    await pool.query(
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
    postSaved = true;

    stage = "add_buttons";
    await editPostCard(sentMessage, postPresentation, postImages, sentMessage.id, 0, false);

    stage = "delete_original";
    await message.delete();
    writeLog("info", "image_post_created", {
      channelId,
      postMessageId: sentMessage.id,
      sourceMessageId: message.id,
      imageCount: downloadedImages.length,
    });
  } catch (error) {
    if (sentMessage && postSaved && stage === "add_buttons" && postPresentation) {
      const retryMessage = sentMessage;
      const likeCount = await getLikeCount(sentMessage.id).catch(() => 0);
      await editPostCard(
        retryMessage,
        postPresentation,
        postImages,
        retryMessage.id,
        likeCount,
        false,
      ).catch(() => null);
    }

    if (error instanceof UserFacingError) {
      writeLog("warn", "image_post_not_completed", {
        channelId,
        sourceMessageId: message.id,
        stage,
      });
      await sendMessageNotice(message, error.userMessage);
    } else {
      writeLog("error", "image_post_failed", {
        channelId,
        sourceMessageId: message.id,
        stage,
        postMessageId: sentMessage?.id ?? "none",
        postSaved,
        ...safeErrorDetails(error),
      });
      await sendMessageNotice(
        message,
        sentMessage
          ? "أنشأت نسخة الـEmbed لكن لم يكتمل التحويل؛ أبقيت الرسالة الأصلية ولم أحذف نسخة الـEmbed."
          : "تعذر تحويل الصورة؛ أبقيت الرسالة الأصلية كما هي.",
      );
    }
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

async function validateConfiguredChannel() {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    writeLog("error", "configured_channel_unavailable", { channelId });
    return;
  }

  const member = channel.guild.members.me;
  const permissions = member ? channel.permissionsFor(member) : null;
  const requiredPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
  ];
  const missing = permissions
    ? requiredPermissions
        .filter(([permission]) => !permissions.has(permission))
        .map(([, name]) => name)
    : requiredPermissions.map(([, name]) => name);

  if (missing.length > 0) {
    writeLog("warn", "channel_permissions_missing", {
      channelId,
      permissions: missing.join(", "),
    });
  } else {
    writeLog("info", "channel_ready", { channelId });
  }

  const commentPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.CreatePublicThreads, "Create Public Threads"],
    [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
  ];
  const missingCommentPermissions = permissions
    ? commentPermissions
        .filter(([permission]) => !permissions.has(permission))
        .map(([, name]) => name)
    : commentPermissions.map(([, name]) => name);
  if (missingCommentPermissions.length > 0) {
    writeLog("warn", "comment_permissions_missing", {
      channelId,
      permissions: missingCommentPermissions.join(", "),
    });
  }
}

client.on(Events.MessageCreate, (message) => {
  void handleImageMessage(message).catch((error: unknown) => {
    writeLog("error", "message_handler_failed", {
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  const action = interaction.isButton()
    ? handleButton(interaction)
    : interaction.isModalSubmit()
      ? handleModalSubmit(interaction)
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
    }
  });
});

client.once(Events.ClientReady, (readyClient) => {
  writeLog("info", "discord_bot_ready", {
    bot: readyClient.user.tag,
    channelId,
    retryConfigured: Boolean(retrySourceMessageId),
  });
  void validateConfiguredChannel().catch((error: unknown) => {
    writeLog("error", "channel_validation_failed", safeErrorDetails(error));
  });
  void retryConfiguredSourceMessage().catch((error: unknown) => {
    writeLog("error", "retry_source_failed", {
      sourceMessageId: retrySourceMessageId ?? "none",
      ...safeErrorDetails(error),
    });
  });
});

client.on(Events.Error, (error) => {
  writeLog("error", "discord_client_error", safeErrorDetails(error));
});

async function shutdown(signal: string) {
  writeLog("info", "shutdown_started", { signal });
  client.destroy();
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  await initializeDatabase();
  await client.login(token);
}

void main().catch(async (error: unknown) => {
  writeLog("error", "startup_failed", safeErrorDetails(error));
  client.destroy();
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});