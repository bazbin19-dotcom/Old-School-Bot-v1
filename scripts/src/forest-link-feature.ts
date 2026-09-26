import { readFile } from "node:fs/promises";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  Events,
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export const forestLinkChannelId = "1546780104124932116";

const treeImageName = "forest-tree.png";
const forestGifName = "forest-focus-loop.gif";
const treeImageUrl = new URL("../../attached_assets/forest-tree-sticker.png", import.meta.url);
const forestGifUrl = new URL("../../attached_assets/forest-focus-loop.gif", import.meta.url);

type ForestSubmissionRow = QueryResultRow & {
  source_message_id: string;
  guild_id: string;
  channel_id: string;
  owner_id: string;
  room_code: string;
  tree_name: string | null;
  duration_minutes: number | null;
  dm_message_id: string | null;
  public_message_id: string | null;
  state: "pending" | "published";
  created_at: Date | string;
};

const imageBuffers = new Map<string, Promise<Buffer>>();
const submissionQueues = new Map<string, Promise<void>>();

function getImageBuffer(fileName: string) {
  let pending = imageBuffers.get(fileName);
  if (!pending) {
    pending = readFile(fileName === treeImageName ? treeImageUrl : forestGifUrl);
    imageBuffers.set(fileName, pending);
  }
  return pending;
}

export async function initializeForestLinkTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_forest_link_submissions (
      source_message_id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      owner_id text NOT NULL,
      room_code text NOT NULL,
      tree_name text,
      duration_minutes integer,
      dm_message_id text,
      public_message_id text,
      state text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CHECK (state IN ('pending', 'published')),
      CHECK (duration_minutes IS NULL OR duration_minutes > 0)
    )
  `);
}

function cleanCandidateUrl(value: string) {
  return value.replace(/[),.;!?]+$/g, "").replace(/^<|>$/g, "");
}

export function parseForestJoinLink(content: string) {
  const candidates = content.match(/https?:\/\/[^\s<>]+/g) ?? [];
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(cleanCandidateUrl(candidate));
    } catch {
      continue;
    }
    if (
      !["forestapp.cc", "www.forestapp.cc"].includes(url.hostname.toLowerCase()) ||
      url.pathname.replace(/\/+$/, "") !== "/join-room"
    ) {
      continue;
    }
    const roomCode = url.searchParams.get("token")?.trim();
    if (!roomCode || !/^[a-zA-Z0-9_-]{4,32}$/.test(roomCode)) continue;
    const joinUrl = new URL("https://www.forestapp.cc/join-room");
    joinUrl.searchParams.set("token", roomCode);
    return { roomCode, joinUrl: joinUrl.toString() };
  }
  return null;
}

function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

export function parseForestTextDetails(content: string) {
  const text = normalizeDigits(
    content.replace(/https?:\/\/[^\s<>]+/g, " ").replace(/<@!?[0-9]+>/g, " "),
  );
  const durationMatch = text.match(
    /(\d{1,3})\s*(?:-\s*)?(?:minutes?|mins?|دقيقة|دقائق|دقيقه|دقايق)(?=$|[\s,.;!?])/i,
  );
  const candidateDuration = durationMatch ? Number(durationMatch[1]) : null;
  const durationMinutes =
    candidateDuration && candidateDuration <= 999 ? candidateDuration : null;

  const arabicTreeMatch = text.match(
    /(?:نوع\s+الشجرة|الشجرة)\s*[:：-]?\s*([^\n,،;.!?]+)/u,
  );
  const englishTreeMatch = text.match(
    /\bplant\s+(?:a\s+)?\d{1,3}\s*-?\s*minutes?\s+(.+?)(?=\s+(?:with\s+(?:me|us)|you\s+can|also\s+tap|tap\s+on)\b|[.!?\n]|$)/i,
  );
  const treeName = (
    arabicTreeMatch?.[1]
      ?.replace(/\s*(?:مدة الدراسة|المدة|مدة|كود الغرفة).*$/u, "")
      .replace(/\s*[⏳⌛].*$/u, "")
      .replace(/[،,;:：| -]+$/u, "")
      .trim() ??
    englishTreeMatch?.[1]?.trim() ??
    ""
  ).slice(0, 60);

  return {
    treeName: treeName || null,
    durationMinutes,
  };
}

function buildPrivatePrompt(
  sourceMessageId: string,
  roomCode: string,
  treeName: string | null,
  durationMinutes: number | null,
) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`forest:details:${sourceMessageId}`)
      .setLabel("إكمال التفاصيل")
      .setEmoji("🌱")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`forest:skip:${sourceMessageId}`)
      .setLabel("عدم ذكرها")
      .setEmoji("➖")
      .setStyle(ButtonStyle.Secondary),
  );
  return new ContainerBuilder()
    .setAccentColor(0x57a663)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 🌳 تجهيز بطاقة Forest",
          `تم استخراج كود الغرفة: **${roomCode}**`,
          `الشجرة: **${treeName || "غير مذكور"}**`,
          `المدة: **${durationMinutes ? `${durationMinutes} دقيقة` : "غير مذكور"}**`,
          "",
          "استخرجت المعلومات المتاحة من نص الرابط. يمكنك إكمال الحقول الناقصة أو اختيار «عدم ذكرها».",
          "إذا تركت حقلاً ناقصاً فارغاً فسيظهر «غير مذكور».",
        ].join("\n"),
      ),
    )
    .addActionRowComponents(buttons);
}

function buildPrivateDoneMessage(publicMessageUrl: string, skipped: boolean) {
  const content = [
    "## ✅ تم نشر بطاقة Forest",
    skipped
      ? "تم استخدام المعلومات المستخرجة؛ وأي حقل ناقص سيظهر «غير مذكور»."
      : "تم إدراج التفاصيل المتاحة، وستظهر الحقول الفارغة كـ «غير مذكور».",
    `[فتح البطاقة في القناة](${publicMessageUrl})`,
  ].join("\n");
  return new ContainerBuilder()
    .setAccentColor(0x57a663)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

function makeForestDetailsModal(
  sourceMessageId: string,
  needsTree: boolean,
  needsDuration: boolean,
) {
  const rows: ActionRowBuilder<TextInputBuilder>[] = [];
  if (needsTree) {
    const tree = new TextInputBuilder()
      .setCustomId("forest_tree_name")
      .setLabel("نوع الشجرة")
      .setPlaceholder("مثال: أرز")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(60)
      .setRequired(false);
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(tree));
  }
  if (needsDuration) {
    const duration = new TextInputBuilder()
      .setCustomId("forest_duration")
      .setLabel("مدة الدراسة بالدقائق")
      .setPlaceholder("مثال: 120")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(8)
      .setRequired(false);
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(duration),
    );
  }
  return new ModalBuilder()
    .setCustomId(`forest:details_submit:${sourceMessageId}`)
    .setTitle("تفاصيل جلسة Forest")
    .addComponents(...rows);
}

function normalizeDuration(value: string) {
  const westernDigits = normalizeDigits(value.trim());
  if (!westernDigits) return null;
  if (!/^\d{1,4}$/.test(westernDigits)) return undefined;
  const minutes = Number(westernDigits);
  return minutes >= 1 && minutes <= 999 ? minutes : undefined;
}

async function getSubmission(pool: Pool, sourceMessageId: string) {
  const result = await pool.query<ForestSubmissionRow>(
    `SELECT source_message_id, guild_id, channel_id, owner_id, room_code,
            tree_name, duration_minutes, dm_message_id, public_message_id,
            state, created_at
     FROM discord_forest_link_submissions
     WHERE source_message_id = $1`,
    [sourceMessageId],
  );
  return result.rows[0] ?? null;
}

async function withSubmissionQueue<T>(
  sourceMessageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = submissionQueues.get(sourceMessageId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  submissionQueues.set(sourceMessageId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (submissionQueues.get(sourceMessageId) === current) {
      submissionQueues.delete(sourceMessageId);
    }
  }
}

async function fetchSubmissionDmMessage(
  client: Client,
  submission: ForestSubmissionRow,
) {
  if (!submission.dm_message_id) return null;
  const user = await client.users.fetch(submission.owner_id);
  const dm = await user.createDM();
  return dm.messages.fetch(submission.dm_message_id).catch(() => null);
}

async function deleteForestSourceMessage(
  channel: TextChannel,
  sourceMessageId: string,
) {
  const source = await channel.messages.fetch(sourceMessageId).catch(() => null);
  if (!source) return;
  await source.delete().catch((error: unknown) => {
    logForestError("forest_source_message_delete_failed", error);
  });
}

function buildForestCard(
  submission: ForestSubmissionRow,
  authorId: string,
  createdAt: Date,
) {
  const tree = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `🌲 **الشجرة:** ${submission.tree_name || "غير مذكور"}`,
          `⏳ **المدة:** ${
            submission.duration_minutes
              ? `${submission.duration_minutes} دقيقة`
              : "غير مذكور"
          }`,
          `🔑 **كود الغرفة:** \`${submission.room_code}\``,
        ].join("\n"),
      ),
    )
    .setThumbnailAccessory(
      new ThumbnailBuilder().setURL(`attachment://${treeImageName}`),
    );
  const joinUrl = new URL("https://www.forestapp.cc/join-room");
  joinUrl.searchParams.set("token", submission.room_code);
  const joinButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setURL(joinUrl.toString())
    .setLabel("انضمام للغابة")
    .setEmoji("↗️");

  return new ContainerBuilder()
    .setAccentColor(0x57a663)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🌳 <@${authorId}> يدعوكم لزراعة غابة!`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems({
        media: { url: `attachment://${forestGifName}` },
      }),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addSectionComponents(tree)
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `تمنّى لكم جلسة تركيز مثمرة • Forest • <t:${Math.floor(
          createdAt.getTime() / 1000,
        )}:R>`,
      ),
    );
}

async function publishForestCard(
  client: Client,
  pool: Pool,
  sourceMessageId: string,
  userId: string,
  treeName: string | null,
  durationMinutes: number | null,
) {
  return withSubmissionQueue(sourceMessageId, async () => {
    const submission = await getSubmission(pool, sourceMessageId);
    if (!submission || submission.owner_id !== userId) {
      throw new Error("Forest link submission is unavailable.");
    }
    if (submission.state === "published" && submission.public_message_id) {
      const channel = await client.channels.fetch(submission.channel_id);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error("The Forest channel is unavailable.");
      }
      const message = await channel.messages
        .fetch(submission.public_message_id)
        .catch(() => null);
      if (message) {
        await deleteForestSourceMessage(channel, sourceMessageId);
        return message;
      }
      throw new Error("The Forest card could not be found.");
    }

    const channel = await client.channels.fetch(submission.channel_id);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== submission.guild_id
    ) {
      throw new Error("The Forest channel is unavailable.");
    }
    const [gifBuffer, treeBuffer] = await Promise.all([
      getImageBuffer(forestGifName),
      getImageBuffer(treeImageName),
    ]);
    const createdAt =
      submission.created_at instanceof Date
        ? submission.created_at
        : new Date(submission.created_at);
    const card = await channel.send({
      components: [
        buildForestCard(
          {
            ...submission,
            tree_name: treeName,
            duration_minutes: durationMinutes,
          },
          userId,
          createdAt,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
      files: [
        new AttachmentBuilder(gifBuffer, { name: forestGifName }),
        new AttachmentBuilder(treeBuffer, { name: treeImageName }),
      ],
      allowedMentions: { parse: [] },
    });
    try {
      await pool.query(
        `UPDATE discord_forest_link_submissions
         SET tree_name = $2, duration_minutes = $3,
             public_message_id = $4, state = 'published',
             completed_at = now()
         WHERE source_message_id = $1`,
        [sourceMessageId, treeName, durationMinutes, card.id],
      );
    } catch (error) {
      await card.delete().catch(() => undefined);
      throw error;
    }
    await deleteForestSourceMessage(channel, sourceMessageId);
    return card;
  });
}

async function finishPrivatePrompt(
  client: Client,
  submission: ForestSubmissionRow,
  publicMessage: Message,
  skipped: boolean,
) {
  const dmMessage = await fetchSubmissionDmMessage(client, submission);
  if (!dmMessage) return;
  await dmMessage.edit({
    components: [buildPrivateDoneMessage(publicMessage.url, skipped)],
    allowedMentions: { parse: [] },
  });
}

async function handleForestButton(
  client: Client,
  pool: Pool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, sourceMessageId] = interaction.customId.split(":");
  if (prefix !== "forest" || !action || !sourceMessageId) return;
  if (interaction.guildId) {
    await interaction.reply({
      content: "تُدار تفاصيل رابط Forest في الرسالة الخاصة التي أرسلها لك البوت.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const submission = await getSubmission(pool, sourceMessageId);
  if (
    !submission ||
    submission.owner_id !== interaction.user.id ||
    submission.state !== "pending" ||
    submission.dm_message_id !== interaction.message.id
  ) {
    await interaction.reply({
      content: "هذا الطلب غير متاح أو تمت معالجته مسبقاً.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "details") {
    await interaction.showModal(
      makeForestDetailsModal(
        sourceMessageId,
        !submission.tree_name,
        submission.duration_minutes === null,
      ),
    );
    return;
  }
  if (action !== "skip") return;

  await interaction.deferUpdate();
  const publicMessage = await publishForestCard(
    client,
    pool,
    sourceMessageId,
    interaction.user.id,
    submission.tree_name,
    submission.duration_minutes,
  );
  await finishPrivatePrompt(client, submission, publicMessage, true);
}

async function handleForestModal(
  client: Client,
  pool: Pool,
  interaction: ModalSubmitInteraction,
) {
  const [prefix, action, sourceMessageId] = interaction.customId.split(":");
  if (
    prefix !== "forest" ||
    action !== "details_submit" ||
    !sourceMessageId
  ) {
    return;
  }
  if (interaction.guildId) {
    await interaction.reply({
      content: "أرسل تفاصيل الجلسة من الرسالة الخاصة التي أرسلها لك البوت.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const submission = await getSubmission(pool, sourceMessageId);
  if (
    !submission ||
    submission.owner_id !== interaction.user.id ||
    submission.state !== "pending"
  ) {
    await interaction.reply({
      content: "هذا الطلب غير متاح أو تمت معالجته مسبقاً.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  const treeName =
    submission.tree_name ??
    (interaction.fields.getTextInputValue("forest_tree_name").trim() || null);
  if (treeName && Array.from(treeName).length > 60) {
    await interaction.reply({
      content: "يجب ألا يتجاوز اسم الشجرة 60 حرفاً.",
      allowedMentions: { parse: [] },
    });
    return;
  }
  const rawDuration =
    submission.duration_minutes === null
      ? interaction.fields.getTextInputValue("forest_duration").trim()
      : "";
  const parsedDuration = normalizeDuration(rawDuration);
  if (parsedDuration === undefined) {
    await interaction.reply({
      content: "اكتب المدة كرقم دقائق من 1 إلى 999، أو اتركها فارغة.",
      allowedMentions: { parse: [] },
    });
    return;
  }
  const durationMinutes = submission.duration_minutes ?? parsedDuration;

  await interaction.deferReply();
  const publicMessage = await publishForestCard(
    client,
    pool,
    sourceMessageId,
    interaction.user.id,
    treeName,
    durationMinutes,
  );
  await finishPrivatePrompt(client, submission, publicMessage, false);
  await interaction.editReply("تم نشر بطاقة Forest في القناة.");
}

function logForestError(event: string, error: unknown) {
  const info =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown })
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      channelId: forestLinkChannelId,
      errorName: typeof info.name === "string" ? info.name : "Error",
      ...(info.code !== undefined ? { errorCode: String(info.code) } : {}),
    })}\n`,
  );
}

async function handleForestInteraction(
  client: Client,
  pool: Pool,
  interaction: Interaction,
) {
  try {
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("forest:")
    ) {
      await handleForestButton(client, pool, interaction);
    } else if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("forest:")
    ) {
      await handleForestModal(client, pool, interaction);
    }
  } catch (error) {
    logForestError("forest_interaction_failed", error);
    if (interaction.isButton() || interaction.isModalSubmit()) {
      const payload = {
        content: "تعذر تجهيز بطاقة Forest الآن. جرّب مرة أخرى بعد قليل.",
        allowedMentions: { parse: [] },
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => undefined);
      } else {
        await interaction.reply(payload).catch(() => undefined);
      }
    }
  }
}

async function handleForestMessage(
  client: Client,
  pool: Pool,
  message: Message,
) {
  if (
    !message.inGuild() ||
    message.author.bot ||
    message.channelId !== forestLinkChannelId
  ) {
    return;
  }
  const link = parseForestJoinLink(message.content);
  if (!link) return;

  const channel = await client.channels.fetch(forestLinkChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const botMember = channel.guild.members.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const requiredPermissions = [
    [PermissionFlagsBits.SendMessages, "إرسال الرسائل"],
    [PermissionFlagsBits.AttachFiles, "إرفاق الصور"],
    [PermissionFlagsBits.ManageMessages, "حذف الرسالة الأصلية"],
  ] as const;
  const missingPermissions = requiredPermissions
    .filter(([permission]) => !permissions?.has(permission))
    .map(([, name]) => name);
  if (missingPermissions.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        event: "forest_channel_permissions_missing",
        timestamp: new Date().toISOString(),
        channelId: forestLinkChannelId,
        missingPermissions,
      })}\n`,
    );
    if (permissions?.has(PermissionFlagsBits.SendMessages)) {
      await message.reply({
        content: `لا أستطيع تجهيز البطاقة قبل منحي صلاحيات: ${missingPermissions.join("، ")}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    return;
  }

  const details = parseForestTextDetails(message.content);
  const inserted = await pool.query(
    `INSERT INTO discord_forest_link_submissions
       (source_message_id, guild_id, channel_id, owner_id, room_code,
        tree_name, duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_message_id) DO NOTHING
     RETURNING source_message_id`,
    [
      message.id,
      message.guildId,
      message.channelId,
      message.author.id,
      link.roomCode,
      details.treeName,
      details.durationMinutes,
    ],
  );
  if (inserted.rowCount !== 1) return;

  if (details.treeName && details.durationMinutes) {
    await publishForestCard(
      client,
      pool,
      message.id,
      message.author.id,
      details.treeName,
      details.durationMinutes,
    );
    return;
  }

  let dmMessage: Message | null = null;
  try {
    dmMessage = await message.author.send({
      components: [
        buildPrivatePrompt(
          message.id,
          link.roomCode,
          details.treeName,
          details.durationMinutes,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    await pool.query(
      `UPDATE discord_forest_link_submissions
       SET dm_message_id = $2
       WHERE source_message_id = $1`,
      [message.id, dmMessage.id],
    );
  } catch (error) {
    if (dmMessage) {
      await dmMessage.delete().catch(() => undefined);
    }
    await pool
      .query(
        "DELETE FROM discord_forest_link_submissions WHERE source_message_id = $1",
        [message.id],
      )
      .catch(() => undefined);
    logForestError("forest_private_prompt_failed", error);
    await message
      .reply({
        content:
          "تعذر إرسال تفاصيل Forest في الخاص. فعّل الرسائل الخاصة من أعضاء السيرفر ثم أعد إرسال الرابط؛ أبقيت رسالتك كما هي.",
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => undefined);
    return;
  }

}

async function validateForestChannel(client: Client) {
  const channel = await client.channels.fetch(forestLinkChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("The configured Forest link channel is unavailable.");
  }
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "forest_link_channel_ready",
      timestamp: new Date().toISOString(),
      channelId: forestLinkChannelId,
    })}\n`,
  );
}

export function attachForestLinkFeature(client: Client, pool: Pool) {
  const onMessage = (message: Message) => {
    void handleForestMessage(client, pool, message).catch((error: unknown) => {
      logForestError("forest_link_message_failed", error);
      if (!message.author.bot && message.channelId === forestLinkChannelId) {
        void message
          .reply({
            content: "تعذر تجهيز رابط Forest الآن؛ أبقيت رسالتك كما هي.",
            allowedMentions: { parse: [], repliedUser: false },
          })
          .catch(() => undefined);
      }
    });
  };
  const onInteraction = (interaction: Interaction) => {
    void handleForestInteraction(client, pool, interaction);
  };
  const onReady = () => {
    void validateForestChannel(client).catch((error: unknown) => {
      logForestError("forest_link_channel_validation_failed", error);
    });
  };

  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, onInteraction);
  client.once(Events.ClientReady, onReady);

  return () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.InteractionCreate, onInteraction);
    client.off(Events.ClientReady, onReady);
  };
}