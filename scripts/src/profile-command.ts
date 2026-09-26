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
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import type { Pool } from "pg";
import { renderProfileCard, type ProfileCardInput } from "./profile-card.js";
import {
  backfillProfileXpAwards,
  getProfileCounts,
  getProfilePostPage,
  getProfileSettings,
  getProfileXp,
  getProfileUserList,
  initializeProfileTables,
  profileDefaultBackground,
  profileImagePostChannelId,
  setProfileBackgroundColor,
  setProfileDisplayName,
  setProfileFollowingPrivacy,
  toggleProfileFollow,
  type ProfileListKind,
  type ProfilePostRow,
} from "./profile-store.js";

const profileCommandChannelId = "1546917390405869718";
const postsPerPage = 6;
const xpRequiredPerLevel = 900;
let profileFileSequence = 0;

type ProfileView = {
  ownerId: string;
  page: number;
  totalPages: number;
  totalPosts: number;
  followingCount: number;
  followerCount: number;
  card: ProfileCardInput;
};

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

function logProfileError(
  event: string,
  error: unknown,
  details: Record<string, string> = {},
) {
  const info =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          code?: unknown;
          status?: unknown;
          message?: unknown;
        })
      : {};
  const errorMessage =
    typeof info.message === "string"
      ? info.message
          .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[redacted connection]")
          .replace(/https?:\/\/\S+/gi, "[url]")
          .replace(/\b\d{17,20}\b/g, "[id]")
          .slice(0, 180)
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...details,
      errorName: typeof info.name === "string" ? info.name : "Error",
      ...(info.code !== undefined ? { errorCode: String(info.code) } : {}),
      ...(typeof info.status === "number" ? { errorStatus: info.status } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    })}\n`,
  );
}

function isProfileSnowflake(value: string | undefined): value is string {
  return Boolean(value && /^\d{17,20}$/.test(value));
}

function parsePage(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, 100_000) : 0;
}

async function resolvePostImage(
  channel: TextChannel,
  row: ProfilePostRow,
): Promise<string | null> {
  const imageNames = parseImageNames(row.images);
  if (imageNames.length === 0) return null;

  try {
    const message = await channel.messages.fetch({
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
    return imageUrl && !imageUrl.startsWith("attachment://") ? imageUrl : null;
  } catch {
    // A post may have been deleted outside the bot; show an empty tile for it.
    return null;
  }
}

async function loadProfileView(
  client: Client,
  pool: Pool,
  guildId: string,
  ownerId: string,
  requestedPage: number,
): Promise<ProfileView> {
  await backfillProfileXpAwards(pool, guildId, ownerId);
  const [settings, counts, totalXp, guild, fetchedUser] = await Promise.all([
    getProfileSettings(pool, guildId, ownerId),
    getProfileCounts(pool, guildId, ownerId),
    getProfileXp(pool, guildId, ownerId),
    client.guilds.fetch(guildId),
    client.users.fetch(ownerId),
  ]);
  const user = await fetchedUser.fetch(true);
  const member = await guild.members.fetch(ownerId).catch(() => null);
  const totalPages = Math.max(1, Math.ceil(counts.totalPosts / postsPerPage));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  const pageRows = await getProfilePostPage(pool, ownerId, page, postsPerPage);

  let postChannel: TextChannel | null = null;
  if (pageRows.rows.length > 0) {
    const fetchedChannel = await client.channels.fetch(profileImagePostChannelId);
    if (!fetchedChannel || fetchedChannel.type !== ChannelType.GuildText) {
      throw new Error("The configured image-post channel is unavailable.");
    }
    postChannel = fetchedChannel;
  }

  const posts = await Promise.all(
    pageRows.rows.map(async (row) => ({
      imageUrl: postChannel ? await resolvePostImage(postChannel, row) : null,
      likeCount: row.like_count,
    })),
  );

  const level = Math.floor(totalXp / xpRequiredPerLevel) + 1;
  const nextLevelXp = level * xpRequiredPerLevel;
  const displayName =
    settings.display_name?.trim() ||
    member?.displayName ||
    user.globalName ||
    user.username;

  return {
    ownerId,
    page,
    totalPages,
    totalPosts: counts.totalPosts,
    followingCount: counts.followingCount,
    followerCount: counts.followerCount,
    card: {
      displayName,
      avatarUrl: user.displayAvatarURL({ extension: "png", size: 512 }),
      bannerUrl: user.bannerURL({ extension: "png", size: 1024 }) ?? null,
      backgroundColor: settings.background_color || profileDefaultBackground,
      totalPosts: counts.totalPosts,
      followingCount: counts.followingCount,
      followerCount: counts.followerCount,
      currentXp: totalXp,
      level,
      nextLevelXp,
      posts,
    },
  };
}

function buildProfileButtons(view: ProfileView) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (view.totalPosts > postsPerPage) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`profile:page:${view.ownerId}:${Math.max(0, view.page - 1)}`)
          .setEmoji("⬅️")
          .setLabel("السابق")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(view.page === 0),
        new ButtonBuilder()
          .setCustomId(
            `profile:page:${view.ownerId}:${Math.min(view.totalPages - 1, view.page + 1)}`,
          )
          .setEmoji("➡️")
          .setLabel("التالي")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(view.page >= view.totalPages - 1),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:following:${view.ownerId}`)
        .setLabel(`Following · ${view.followingCount}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`profile:followers:${view.ownerId}`)
        .setLabel(`Followers · ${view.followerCount}`)
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:follow:${view.ownerId}:${view.page}`)
        .setLabel("Follow")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`profile:settings:${view.ownerId}:${view.page}`)
        .setEmoji("⚙️")
        .setLabel("الإعدادات")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return rows;
}

function buildProfileContainer(view: ProfileView, imageUrl: string) {
  const container = new ContainerBuilder()
    .setAccentColor(0x45454c)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems({ media: { url: imageUrl } }),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    );
  for (const row of buildProfileButtons(view)) {
    container.addActionRowComponents(row);
  }
  return container;
}

function createProfileFileName(ownerId: string) {
  profileFileSequence += 1;
  return `profile-${ownerId}-${Date.now()}-${profileFileSequence}.png`;
}

async function sendProfileMessage(
  commandMessage: Message,
  client: Client,
  pool: Pool,
  ownerId = commandMessage.author.id,
) {
  if (!commandMessage.guildId) {
    throw new Error("Profile command must be used in a server.");
  }
  const view = await loadProfileView(
    client,
    pool,
    commandMessage.guildId,
    ownerId,
    0,
  );
  const image = await renderProfileCard(view.card);
  const fileName = createProfileFileName(view.ownerId);

  await commandMessage.reply({
    components: [
      buildProfileContainer(view, `attachment://${fileName}`),
    ],
    flags: MessageFlags.IsComponentsV2,
    files: [new AttachmentBuilder(image, { name: fileName })],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

async function fetchProfilePublicMessage(
  client: Client,
  guildId: string,
  messageId: string,
) {
  const channel = await client.channels.fetch(profileCommandChannelId);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.guildId !== guildId
  ) {
    return null;
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message || message.author.id !== client.user?.id) return null;
  return message;
}

async function replaceProfileImage(
  client: Client,
  message: Message,
  view: ProfileView,
  image: Buffer,
) {
  const fileName = createProfileFileName(view.ownerId);
  const currentMessage = await message.fetch(true);
  const existingAttachments = [...currentMessage.attachments.values()].map(
    (attachment) => ({ id: attachment.id }),
  );
  let uploadedMessage = await currentMessage.edit({
    files: [new AttachmentBuilder(image, { name: fileName })],
    ...(existingAttachments.length > 0
      ? { attachments: existingAttachments }
      : {}),
  });

  const findUploadedAttachment = (candidate: Message) =>
    candidate.attachments.find((attachment) => attachment.name === fileName) ??
    [...candidate.attachments.values()].find(
      (attachment) =>
        !existingAttachments.some((existing) => existing.id === attachment.id),
    );
  let newAttachment = findUploadedAttachment(uploadedMessage);
  if (!newAttachment) {
    uploadedMessage = await uploadedMessage.fetch(true);
    newAttachment = findUploadedAttachment(uploadedMessage);
  }
  if (!newAttachment) {
    const channel = await client.channels.fetch(profileCommandChannelId);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.id !== message.channelId
    ) {
      throw new Error("The profile channel is unavailable for message recovery.");
    }

    await channel.send({
      components: [buildProfileContainer(view, `attachment://${fileName}`)],
      flags: MessageFlags.IsComponentsV2,
      files: [new AttachmentBuilder(image, { name: fileName })],
      allowedMentions: { parse: [] },
    });
    await message.delete().catch((error: unknown) => {
      logProfileError("profile_old_message_cleanup_failed", error, {
        channelId: message.channelId,
      });
    });
    return;
  }

  await uploadedMessage.edit({
    components: [buildProfileContainer(view, newAttachment.url)],
    attachments: [{ id: newAttachment.id }],
  });
}

async function refreshProfileMessage(
  client: Client,
  pool: Pool,
  message: Message,
  guildId: string,
  ownerId: string,
  requestedPage: number,
) {
  const view = await loadProfileView(
    client,
    pool,
    guildId,
    ownerId,
    requestedPage,
  );
  const image = await renderProfileCard(view.card);
  await replaceProfileImage(client, message, view, image);
}

function makeProfileSettingsMenu(
  ownerId: string,
  profileMessageId: string,
  page: number,
  followingPrivate: boolean,
) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      `profile:setting:${ownerId}:${profileMessageId}:${page}`,
    )
    .setPlaceholder("اختر إعداداً")
    .addOptions(
      {
        label: followingPrivate
          ? "إظهار قائمة Following للآخرين"
          : "إخفاء قائمة Following عن الآخرين",
        description: "تغيير من يستطيع رؤية قائمة الحسابات التي تتابعها",
        value: "privacy",
      },
      {
        label: "تغيير اسم العرض",
        description: "اسم يظهر في ملفك فقط، دون تغيير اسم Discord",
        value: "name",
      },
      {
        label: "تغيير لون الخلفية",
        description: "اكتب اسم لون أو رمز HEX",
        value: "color",
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function makeProfileNameModal(
  ownerId: string,
  profileMessageId: string,
  page: number,
) {
  const input = new TextInputBuilder()
    .setCustomId("profile_display_name")
    .setLabel("اسم العرض في الملف الشخصي")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32);
  return new ModalBuilder()
    .setCustomId(
      `profile:edit:name:${ownerId}:${profileMessageId}:${page}`,
    )
    .setTitle("تغيير اسم الملف الشخصي")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function makeProfileColorModal(
  ownerId: string,
  profileMessageId: string,
  page: number,
) {
  const input = new TextInputBuilder()
    .setCustomId("profile_background_color")
    .setLabel("اسم اللون أو رمز HEX")
    .setPlaceholder("أحمر، أزرق، بنفسجي، أو #3498DB")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(24);
  return new ModalBuilder()
    .setCustomId(
      `profile:edit:color:${ownerId}:${profileMessageId}:${page}`,
    )
    .setTitle("تغيير لون الخلفية")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function normalizeBackgroundColor(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ");
  const palette: Record<string, string> = {
    red: "#D84F61",
    blue: "#397BD1",
    green: "#32A36B",
    yellow: "#D6A931",
    purple: "#8255BB",
    violet: "#8255BB",
    orange: "#D58137",
    pink: "#D75795",
    black: "#17171A",
    white: "#E6E6E9",
    gray: "#65656B",
    grey: "#65656B",
    cyan: "#22A9BA",
    teal: "#238E8D",
    brown: "#8A5F44",
    احمر: "#D84F61",
    ازرق: "#397BD1",
    اخضر: "#32A36B",
    اصفر: "#D6A931",
    بنفسجي: "#8255BB",
    برتقالي: "#D58137",
    وردي: "#D75795",
    اسود: "#17171A",
    ابيض: "#E6E6E9",
    رمادي: "#65656B",
    سماوي: "#22A9BA",
    بني: "#8A5F44",
  };
  const namedColor = palette[normalized];
  if (namedColor) return namedColor;

  const hex = normalized.startsWith("#") ? normalized : `#${normalized}`;
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

async function replyPrivately(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  content: string,
) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } else {
    await interaction.reply({
      content,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

function isProfilePublicButton(
  client: Client,
  interaction: ButtonInteraction,
) {
  return (
    interaction.channelId === profileCommandChannelId &&
    interaction.guildId !== null &&
    interaction.message.author.id === client.user?.id
  );
}

async function handleProfileButton(
  client: Client,
  pool: Pool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, ownerId, value] = interaction.customId.split(":");
  if (prefix !== "profile" || !action || !isProfileSnowflake(ownerId)) return;
  if (!isProfilePublicButton(client, interaction)) {
    await replyPrivately(interaction, "هذا الملف الشخصي لم يعد متاحاً.");
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyPrivately(interaction, "يجب استخدام هذا الخيار داخل السيرفر.");
    return;
  }

  if (action === "page") {
    await interaction.deferUpdate();
    await refreshProfileMessage(
      client,
      pool,
      interaction.message,
      guildId,
      ownerId,
      parsePage(value),
    );
    return;
  }

  if (action === "follow") {
    if (ownerId === interaction.user.id) {
      await replyPrivately(interaction, "لا يمكنك متابعة ملفك الشخصي.");
      return;
    }
    await interaction.deferUpdate();
    const isFollowing = await toggleProfileFollow(
      pool,
      guildId,
      interaction.user.id,
      ownerId,
    );
    await refreshProfileMessage(
      client,
      pool,
      interaction.message,
      guildId,
      ownerId,
      parsePage(value),
    );
    await interaction.followUp({
      content: isFollowing
        ? `أصبحت تتابع <@${ownerId}>. اضغط Follow مرة أخرى لإلغاء المتابعة.`
        : `ألغيت متابعة <@${ownerId}>.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "following" || action === "followers") {
    await interaction.deferReply({ ephemeral: true });
    const kind = action as ProfileListKind;
    const settings = await getProfileSettings(pool, guildId, ownerId);
    if (
      kind === "following" &&
      settings.following_private &&
      interaction.user.id !== ownerId
    ) {
      await interaction.editReply("قائمة Following مخفية من صاحب الملف الشخصي.");
      return;
    }

    const list = await getProfileUserList(pool, guildId, ownerId, kind);
    if (list.totalCount === 0) {
      await interaction.editReply(
        kind === "following"
          ? "هذا الحساب لا يتابع أحداً حالياً."
          : "هذا الحساب ليس لديه متابعون بعد.",
      );
      return;
    }

    const names = list.userIds.map((userId) => `<@${userId}>`);
    const extraCount = list.totalCount - names.length;
    const description = [
      names.join("\n"),
      extraCount > 0 ? `و${extraCount} حساباً آخر` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const embed = new EmbedBuilder()
      .setColor(0x39393d)
      .setTitle(
        kind === "following"
          ? `Following · ${list.totalCount}`
          : `Followers · ${list.totalCount}`,
      )
      .setDescription(description);
    await interaction.editReply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "settings") {
    if (interaction.user.id !== ownerId) {
      await replyPrivately(
        interaction,
        "إعدادات الملف الشخصي متاحة لصاحبه فقط.",
      );
      return;
    }
    const settings = await getProfileSettings(pool, guildId, ownerId);
    await interaction.reply({
      content: "إعدادات الملف الشخصي",
      components: [
        makeProfileSettingsMenu(
          ownerId,
          interaction.message.id,
          parsePage(value),
          settings.following_private,
        ),
      ],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleProfileSelect(
  client: Client,
  pool: Pool,
  interaction: StringSelectMenuInteraction,
) {
  const [prefix, action, ownerId, profileMessageId, pageValue] =
    interaction.customId.split(":");
  if (
    prefix !== "profile" ||
    action !== "setting" ||
    !isProfileSnowflake(ownerId) ||
    !isProfileSnowflake(profileMessageId)
  ) {
    return;
  }

  if (
    interaction.channelId !== profileCommandChannelId ||
    !interaction.guildId ||
    interaction.user.id !== ownerId ||
    interaction.message.author.id !== client.user?.id
  ) {
    await replyPrivately(
      interaction,
      "هذه الإعدادات غير متاحة لهذا الحساب أو لم تعد صالحة.",
    );
    return;
  }
  const selected = interaction.values[0];
  if (selected === "privacy") {
    await interaction.deferUpdate();
    const profileMessage = await fetchProfilePublicMessage(
      client,
      interaction.guildId,
      profileMessageId,
    );
    if (!profileMessage) {
      await interaction.editReply({
        content: "تعذر العثور على رسالة الملف الشخصي.",
        components: [],
      });
      return;
    }
    const settings = await getProfileSettings(pool, interaction.guildId, ownerId);
    const nextPrivacy = !settings.following_private;
    await setProfileFollowingPrivacy(
      pool,
      interaction.guildId,
      ownerId,
      nextPrivacy,
    );
    await interaction.editReply({
      content: nextPrivacy
        ? "تم إخفاء قائمة Following عن بقية الأعضاء."
        : "أصبحت قائمة Following ظاهرة لبقية الأعضاء.",
      components: [],
    });
    return;
  }

  if (selected === "name") {
    await interaction.showModal(
      makeProfileNameModal(
        ownerId,
        profileMessageId,
        parsePage(pageValue),
      ),
    );
  } else if (selected === "color") {
    await interaction.showModal(
      makeProfileColorModal(
        ownerId,
        profileMessageId,
        parsePage(pageValue),
      ),
    );
  }
}

async function handleProfileModal(
  client: Client,
  pool: Pool,
  interaction: ModalSubmitInteraction,
) {
  const [prefix, action, setting, ownerId, profileMessageId, pageValue] =
    interaction.customId.split(":");
  if (
    prefix !== "profile" ||
    action !== "edit" ||
    !["name", "color"].includes(setting ?? "") ||
    !isProfileSnowflake(ownerId) ||
    !isProfileSnowflake(profileMessageId)
  ) {
    return;
  }

  if (
    interaction.channelId !== profileCommandChannelId ||
    !interaction.guildId ||
    interaction.user.id !== ownerId
  ) {
    await replyPrivately(
      interaction,
      "لا يمكنك تعديل إعدادات ملف شخصي لا تملكه.",
    );
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const profileMessage = await fetchProfilePublicMessage(
    client,
    interaction.guildId,
    profileMessageId,
  );
  if (!profileMessage) {
    await interaction.editReply("تعذر العثور على رسالة الملف الشخصي.");
    return;
  }

  if (setting === "name") {
    const name = interaction.fields
      .getTextInputValue("profile_display_name")
      .trim();
    if (Array.from(name).length > 32) {
      await interaction.editReply("يجب أن يكون الاسم أقصر من 33 حرفاً.");
      return;
    }
    await setProfileDisplayName(
      pool,
      interaction.guildId,
      ownerId,
      name || null,
    );
    await refreshProfileMessage(
      client,
      pool,
      profileMessage,
      interaction.guildId,
      ownerId,
      parsePage(pageValue),
    );
    await interaction.editReply(
      name
        ? "تم تحديث اسم العرض في ملفك الشخصي."
        : "تمت إعادة اسم العرض إلى اسمك في السيرفر.",
    );
    return;
  }

  const color = normalizeBackgroundColor(
    interaction.fields.getTextInputValue("profile_background_color"),
  );
  if (!color) {
    await interaction.editReply(
      "لم أتعرف على اللون. جرّب اسماً مثل أحمر أو أزرق أو بنفسجي، أو اكتب رمزاً مثل #3498DB.",
    );
    return;
  }
  await setProfileBackgroundColor(pool, interaction.guildId, ownerId, color);
  await refreshProfileMessage(
    client,
    pool,
    profileMessage,
    interaction.guildId,
    ownerId,
    parsePage(pageValue),
  );
  await interaction.editReply(`تم تغيير لون خلفية الملف إلى ${color}.`);
}

export function attachProfileCommand(client: Client, pool: Pool) {
  const onMessage = (message: Message) => {
    if (
      !message.inGuild() ||
      message.author.bot ||
      message.channelId !== profileCommandChannelId
    ) {
      return;
    }

    const command = /^بروفايل(?:\s+<@!?(\d{17,20})>)?$/.exec(
      message.content.trim(),
    );
    if (!command) return;

    const targetId = command[1] ?? message.author.id;
    if (command[1] && !message.mentions.users.has(targetId)) return;

    void sendProfileMessage(message, client, pool, targetId).catch(
      async (error: unknown) => {
        logProfileError("profile_image_generation_failed", error, {
          userId: targetId,
          channelId: message.channelId,
        });
        await message
          .reply({
            content: "تعذر إنشاء الملف الشخصي حالياً. حاول مرة أخرى بعد قليل.",
            allowedMentions: { repliedUser: false },
          })
          .catch(() => null);
      },
    );
  };

  const onInteraction = (interaction: Interaction) => {
    let action: Promise<void> | null = null;
    let eventName = "profile_interaction_failed";

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("profile:")
    ) {
      action = handleProfileButton(client, pool, interaction);
      eventName = "profile_button_failed";
    } else if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("profile:")
    ) {
      action = handleProfileSelect(client, pool, interaction);
      eventName = "profile_settings_select_failed";
    } else if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("profile:")
    ) {
      action = handleProfileModal(client, pool, interaction);
      eventName = "profile_settings_modal_failed";
    }

    if (!action) return;
    void action.catch(async (error: unknown) => {
      const customId =
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()
          ? interaction.customId
          : "";
      logProfileError(eventName, error, {
        channelId: interaction.channelId ?? "unknown",
        interactionType: interaction.isButton()
          ? "button"
          : interaction.isStringSelectMenu()
            ? "select"
            : "modal",
        action: customId.split(":")[1] ?? "unknown",
      });
      if (
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()
      ) {
        await replyPrivately(
          interaction,
          "تعذر تنفيذ هذا الخيار حالياً. حاول مرة أخرى.",
        ).catch(() => null);
      }
    });
  };

  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, onInteraction);
  return () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.InteractionCreate, onInteraction);
  };
}

export { initializeProfileTables };