import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import type { Pool as PgPool, QueryResultRow } from "pg";
import {
  makeAuctionNoticeEmbed,
  makeAuctionResultEmbed,
  makeAuctionSetupPanel,
  makeAuctionStartedEmbed,
  type AuctionPanelValues,
} from "./auction-messages.js";
import {
  formatAuctionAmount,
  parseAuctionAmount,
  parseAuctionDurationMs,
} from "./auction-parsing.js";

const auctionGuildId = "1313568118198632520";
const auctionChannelId = "1553713559501021305";
const auctionStarterRoleId = "1553725198782701598";
const auctionMaintenanceIntervalMs = 5_000;
const auctionSetupExpiryMs = 7 * 24 * 60 * 60 * 1_000;
const privateThreadArchiveMinutes = 10_080;

type AuctionStatus = "setup" | "active" | "completed" | "cancelled";

type AuctionRow = QueryResultRow &
  AuctionPanelValues & {
    id: string;
    guild_id: string;
    channel_id: string;
    setup_thread_id: string;
    setup_message_id: string | null;
    creator_id: string;
    started_at: Date | null;
    completed_at: Date | null;
    start_message_id: string | null;
    result_message_id: string | null;
    created_at: Date;
  };

type AuctionField = "duration" | "price" | "item";

let maintenanceTimer: NodeJS.Timeout | undefined;
let maintenanceRunning = false;
let auctionChannelReady = false;
const setupQueues = new Map<string, Promise<void>>();
const privateThreadQueues = new Map<string, Promise<ThreadChannel>>();

function logAuctionError(
  event: string,
  error: unknown,
  details: Record<string, string> = {},
) {
  const info =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown })
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...details,
      errorName: typeof info.name === "string" ? info.name : "Error",
      ...(info.code !== undefined ? { errorCode: String(info.code) } : {}),
    })}\n`,
  );
}

function logAuctionInfo(event: string, details: Record<string, string> = {}) {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })}\n`,
  );
}

function isUnknownChannel(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "10003",
  );
}

function auctionRowSelect() {
  return `id, guild_id, channel_id, setup_thread_id, setup_message_id,
          creator_id, status, duration_ms, starting_price, item_name,
          current_bid, highest_bidder_id, started_at, ends_at, completed_at,
          start_message_id, result_message_id, created_at`;
}

export async function initializeAuctionTables(pool: PgPool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_auctions (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      setup_thread_id text NOT NULL,
      setup_message_id text,
      creator_id text NOT NULL,
      status text NOT NULL
        CHECK (status IN ('setup', 'active', 'completed', 'cancelled')),
      duration_ms bigint,
      starting_price numeric(24, 6),
      item_name text,
      started_at timestamptz,
      ends_at timestamptz,
      current_bid numeric(24, 6),
      highest_bidder_id text,
      completed_at timestamptz,
      start_message_id text,
      result_message_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS discord_auctions_one_open_per_channel_idx
      ON discord_auctions (channel_id)
      WHERE status IN ('setup', 'active')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_auctions_due_idx
      ON discord_auctions (ends_at)
      WHERE status = 'active'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_auction_private_threads (
      auction_id text NOT NULL
        REFERENCES discord_auctions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      thread_id text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (auction_id, user_id)
    )
  `);
}

async function getAuctionTextChannel(client: Client) {
  const channel = await client.channels.fetch(auctionChannelId);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.guildId !== auctionGuildId
  ) {
    throw new Error("The configured auction channel is unavailable.");
  }
  return channel;
}

async function validateAuctionChannel(client: Client) {
  const channel = await getAuctionTextChannel(client);
  const botMember =
    channel.guild.members.me ?? (await channel.guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
    [PermissionFlagsBits.CreatePrivateThreads, "Create Private Threads"],
    [PermissionFlagsBits.ManageThreads, "Manage Threads"],
  ];
  const missingPermissions = requiredPermissions
    .filter(([permission]) => !permissions?.has(permission))
    .map(([, label]) => label);
  if (missingPermissions.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event: "auction_channel_permissions_missing",
        timestamp: new Date().toISOString(),
        guildId: channel.guildId,
        channelId: channel.id,
        missingPermissions,
      })}\n`,
    );
    return false;
  }

  logAuctionInfo("auction_channel_ready", {
    guildId: channel.guildId,
    channelId: channel.id,
    starterRoleId: auctionStarterRoleId,
  });
  return true;
}

async function withSetupQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = setupQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  setupQueues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (setupQueues.get(key) === current) setupQueues.delete(key);
  }
}

async function createPrivateThread(
  channel: TextChannel,
  userId: string,
  name: string,
  reason: string,
) {
  const thread = await channel.threads.create({
    name: name.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: privateThreadArchiveMinutes,
    reason,
  });
  try {
    await thread.members.add(userId);
    return thread;
  } catch (error) {
    await thread.delete().catch(() => undefined);
    throw error;
  }
}

async function getOrCreatePrivateThread(
  client: Client,
  pool: PgPool,
  auction: AuctionRow,
  userId: string,
): Promise<ThreadChannel> {
  const key = `${auction.id}:${userId}`;
  const pending = privateThreadQueues.get(key);
  if (pending) return pending;

  const current = (async () => {
    const existing = await pool.query<{ thread_id: string }>(
      `SELECT thread_id
       FROM discord_auction_private_threads
       WHERE auction_id = $1 AND user_id = $2`,
      [auction.id, userId],
    );
    const existingThreadId = existing.rows[0]?.thread_id;
    if (existingThreadId) {
      const fetched = await client.channels.fetch(existingThreadId).catch((error: unknown) => {
        if (isUnknownChannel(error)) return null;
        throw error;
      });
      if (fetched?.isThread()) {
        if (fetched.archived) await fetched.setArchived(false);
        await fetched.members.add(userId);
        return fetched;
      }
      await pool.query(
        `DELETE FROM discord_auction_private_threads
         WHERE auction_id = $1 AND user_id = $2`,
        [auction.id, userId],
      );
    }

    const parent = await getAuctionTextChannel(client);
    const thread = await createPrivateThread(
      parent,
      userId,
      `مزايدة خاصة - ${userId}`,
      "Create a private auction feedback thread",
    );
    try {
      await pool.query(
        `INSERT INTO discord_auction_private_threads
           (auction_id, user_id, thread_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (auction_id, user_id)
         DO UPDATE SET thread_id = EXCLUDED.thread_id`,
        [auction.id, userId, thread.id],
      );
    } catch (error) {
      await thread.delete().catch(() => undefined);
      throw error;
    }
    return thread;
  })();

  privateThreadQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (privateThreadQueues.get(key) === current) {
      privateThreadQueues.delete(key);
    }
  }
}

async function sendPrivateAuctionNotice(
  client: Client,
  pool: PgPool,
  auction: AuctionRow,
  user: User,
  title: string,
  description: string,
) {
  try {
    const thread = await getOrCreatePrivateThread(
      client,
      pool,
      auction,
      user.id,
    );
    await thread.send({
      embeds: [makeAuctionNoticeEmbed(title, description)],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    logAuctionError("auction_private_thread_notice_failed", error, {
      auctionId: auction.id,
      userId: user.id,
    });
    try {
      await user.send({
        embeds: [makeAuctionNoticeEmbed(title, description)],
        allowedMentions: { parse: [] },
      });
      return true;
    } catch (dmError) {
      logAuctionError("auction_dm_fallback_failed", dmError, {
        auctionId: auction.id,
        userId: user.id,
      });
      return false;
    }
  }
}

async function sendSetupConflictNotice(
  client: Client,
  pool: PgPool,
  auction: AuctionRow,
  user: User,
) {
  if (auction.status === "setup" && auction.creator_id === user.id) {
    const thread = await client.channels.fetch(auction.setup_thread_id);
    if (thread?.isThread()) {
      if (thread.archived) await thread.setArchived(false);
      await thread.send({
        embeds: [
          makeAuctionNoticeEmbed(
            "إعداد المزاد مفتوح",
            "أكمل إعداد المزاد من الأزرار الموجودة في هذه المحادثة الخاصة.",
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }
  }
  await sendPrivateAuctionNotice(
    client,
    pool,
    auction,
    user,
    "يوجد مزاد آخر",
    "لا يمكن إعداد مزاد جديد أثناء وجود مزاد نشط أو إعداد مفتوح في هذه القناة.",
  );
}

async function createAuctionSetup(
  client: Client,
  pool: PgPool,
  message: Message,
) {
  await withSetupQueue(message.channelId, async () => {
    await pool.query(
      `UPDATE discord_auctions
       SET status = 'cancelled', updated_at = now()
       WHERE channel_id = $1
         AND status = 'setup'
         AND created_at < now() - ($2::bigint * interval '1 millisecond')`,
      [auctionChannelId, auctionSetupExpiryMs],
    );
    const existing = await pool.query<AuctionRow>(
      `SELECT ${auctionRowSelect()}
       FROM discord_auctions
       WHERE channel_id = $1 AND status IN ('setup', 'active')
       LIMIT 1`,
      [auctionChannelId],
    );
    const openAuction = existing.rows[0];
    if (openAuction) {
      await sendSetupConflictNotice(
        client,
        pool,
        openAuction,
        message.author,
      );
      return;
    }

    const channel = await getAuctionTextChannel(client);
    const auctionId = randomUUID();
    const thread = await createPrivateThread(
      channel,
      message.author.id,
      `إعداد مزاد - ${message.author.username}`,
      "Create a private auction setup thread",
    );
    try {
      await pool.query(
        `INSERT INTO discord_auctions
           (id, guild_id, channel_id, setup_thread_id, creator_id, status)
         VALUES ($1, $2, $3, $4, $5, 'setup')`,
        [auctionId, auctionGuildId, auctionChannelId, thread.id, message.author.id],
      );
      const auction = await pool.query<AuctionRow>(
        `SELECT ${auctionRowSelect()} FROM discord_auctions WHERE id = $1`,
        [auctionId],
      );
      const row = auction.rows[0];
      if (!row) throw new Error("The auction setup row was not created.");
      const setupMessage = await thread.send({
        components: [makeAuctionSetupPanel(auctionId, row)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
      await pool.query(
        `UPDATE discord_auctions
         SET setup_message_id = $2, updated_at = now()
         WHERE id = $1`,
        [auctionId, setupMessage.id],
      );
      logAuctionInfo("auction_setup_created", {
        auctionId,
        creatorId: message.author.id,
        threadId: thread.id,
      });
    } catch (error) {
      await pool.query(
        `DELETE FROM discord_auctions WHERE id = $1`,
        [auctionId],
      ).catch(() => undefined);
      await thread.delete().catch(() => undefined);
      throw error;
    }
  });
}

function makeAuctionFieldModal(field: AuctionField, auctionId: string) {
  const input = new TextInputBuilder()
    .setCustomId("auction_value")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  if (field === "duration") {
    input
      .setLabel("مدة المزاد")
      .setPlaceholder("مثال: 5 دقائق، 30 دقيقة، يوم، يومين")
      .setMaxLength(40);
  } else if (field === "price") {
    input
      .setLabel("سعر البدء")
      .setPlaceholder("مثال: 1000")
      .setMaxLength(40);
  } else {
    input
      .setLabel("العنصر")
      .setPlaceholder("اكتب اسم العنصر")
      .setMaxLength(100);
  }

  const title =
    field === "duration"
      ? "تحديد مدة المزاد"
      : field === "price"
        ? "تحديد سعر البدء"
        : "تحديد العنصر";

  return new ModalBuilder()
    .setCustomId(`auction:submit:${field}:${auctionId}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

async function replyPrivately(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
) {
  const payload = {
    content,
    ephemeral: true,
    allowedMentions: { parse: [] as const },
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function getAuctionForSetupInteraction(
  pool: PgPool,
  auctionId: string,
  userId: string,
) {
  const result = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()} FROM discord_auctions WHERE id = $1`,
    [auctionId],
  );
  const auction = result.rows[0];
  if (!auction || auction.guild_id !== auctionGuildId) return null;
  if (auction.creator_id !== userId) return null;
  return auction;
}

async function handleAuctionButton(
  pool: PgPool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, field, auctionId] = interaction.customId.split(":");
  if (
    prefix !== "auction" ||
    action !== "field" ||
    !auctionId ||
    !["duration", "price", "item"].includes(field ?? "")
  ) {
    return;
  }

  const auction = await getAuctionForSetupInteraction(
    pool,
    auctionId,
    interaction.user.id,
  );
  if (
    !auction ||
    auction.status !== "setup" ||
    interaction.channelId !== auction.setup_thread_id ||
    interaction.message.id !== auction.setup_message_id ||
    interaction.message.author.id !== interaction.client.user?.id
  ) {
    await replyPrivately(
      interaction,
      "هذا الإعداد غير متاح لك أو لم يعد موجوداً.",
    );
    return;
  }

  await interaction.showModal(
    makeAuctionFieldModal(field as AuctionField, auctionId),
  );
}

async function saveAuctionField(
  pool: PgPool,
  auctionId: string,
  userId: string,
  field: AuctionField,
  value: string | number,
): Promise<
  | { kind: "saved"; auction: AuctionRow; started: boolean }
  | { kind: "unavailable" }
> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const selected = await connection.query<AuctionRow>(
      `SELECT ${auctionRowSelect()}
       FROM discord_auctions
       WHERE id = $1
       FOR UPDATE`,
      [auctionId],
    );
    const auction = selected.rows[0];
    if (
      !auction ||
      auction.creator_id !== userId ||
      auction.guild_id !== auctionGuildId ||
      auction.status !== "setup"
    ) {
      await connection.query("COMMIT");
      return { kind: "unavailable" };
    }

    const column =
      field === "duration"
        ? "duration_ms"
        : field === "price"
          ? "starting_price"
          : "item_name";
    const cast = field === "duration" ? "::bigint" : field === "price" ? "::numeric" : "";
    await connection.query(
      `UPDATE discord_auctions
       SET ${column} = $2${cast}, updated_at = now()
       WHERE id = $1`,
      [auctionId, value],
    );
    let updatedResult = await connection.query<AuctionRow>(
      `SELECT ${auctionRowSelect()}
       FROM discord_auctions
       WHERE id = $1`,
      [auctionId],
    );
    let updatedAuction = updatedResult.rows[0];
    if (!updatedAuction) throw new Error("Auction setup disappeared while saving.");

    let started = false;
    if (
      updatedAuction.duration_ms !== null &&
      updatedAuction.starting_price !== null &&
      updatedAuction.item_name !== null
    ) {
      const activated = await connection.query<AuctionRow>(
        `UPDATE discord_auctions
         SET status = 'active',
             started_at = now(),
             ends_at = now() +
               duration_ms::double precision * interval '1 millisecond',
             updated_at = now()
         WHERE id = $1 AND status = 'setup'
         RETURNING ${auctionRowSelect()}`,
        [auctionId],
      );
      if (activated.rows[0]) {
        updatedAuction = activated.rows[0];
        started = true;
      }
    }

    await connection.query("COMMIT");
    return { kind: "saved", auction: updatedAuction, started };
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function refreshAuctionSetupPanel(
  client: Client,
  pool: PgPool,
  auctionId: string,
) {
  const result = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()} FROM discord_auctions WHERE id = $1`,
    [auctionId],
  );
  const auction = result.rows[0];
  if (!auction?.setup_message_id) return;
  const thread = await client.channels.fetch(auction.setup_thread_id);
  if (!thread?.isThread()) return;
  if (thread.archived) await thread.setArchived(false);
  const setupMessage = await thread.messages.fetch(auction.setup_message_id);
  await setupMessage.edit({
    components: [makeAuctionSetupPanel(auctionId, auction)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function handleAuctionModal(
  client: Client,
  pool: PgPool,
  interaction: ModalSubmitInteraction,
) {
  const [prefix, action, fieldValue, auctionId] = interaction.customId.split(":");
  if (
    prefix !== "auction" ||
    action !== "submit" ||
    !auctionId ||
    !["duration", "price", "item"].includes(fieldValue ?? "")
  ) {
    return;
  }
  const field = fieldValue as AuctionField;
  const auction = await getAuctionForSetupInteraction(
    pool,
    auctionId,
    interaction.user.id,
  );
  if (
    !auction ||
    auction.status !== "setup" ||
    interaction.channelId !== auction.setup_thread_id
  ) {
    await replyPrivately(
      interaction,
      "هذا الإعداد غير متاح لك أو لم يعد موجوداً.",
    );
    return;
  }

  const rawValue = interaction.fields.getTextInputValue("auction_value").trim();
  let value: string | number;
  if (field === "duration") {
    const durationMs = parseAuctionDurationMs(rawValue);
    if (durationMs === null) {
      await replyPrivately(
        interaction,
        "اكتب مدة صحيحة، مثل: 5 دقائق، 30 دقيقة، يوم، أو يومين.",
      );
      return;
    }
    value = durationMs;
  } else if (field === "price") {
    const amount = parseAuctionAmount(rawValue);
    if (amount === null) {
      await replyPrivately(
        interaction,
        "اكتب سعراً موجباً بالأرقام، مثل: 1000.",
      );
      return;
    }
    value = amount;
  } else {
    if (!rawValue) {
      await replyPrivately(interaction, "اكتب اسم العنصر قبل الحفظ.");
      return;
    }
    value = rawValue.slice(0, 100);
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await saveAuctionField(
    pool,
    auctionId,
    interaction.user.id,
    field,
    value,
  );
  if (result.kind === "unavailable") {
    await interaction.editReply("هذا الإعداد لم يعد متاحاً.");
    return;
  }

  await refreshAuctionSetupPanel(client, pool, auctionId).catch((error: unknown) => {
    logAuctionError("auction_setup_panel_refresh_failed", error, { auctionId });
  });
  if (result.started) {
    void runAuctionMaintenance(client, pool);
    await interaction.editReply(
      "تم حفظ الإعدادات وبدأ المزاد. سيظهر الإعلان في القناة.",
    );
  } else {
    await interaction.editReply("تم حفظ الإعداد.");
  }
}

async function deliverBidRejection(
  client: Client,
  pool: PgPool,
  auction: AuctionRow,
  message: Message,
  reason: string,
) {
  await sendPrivateAuctionNotice(
    client,
    pool,
    auction,
    message.author,
    "لم تُقبل المزايدة",
    reason,
  );
  await message.delete().catch((error: unknown) => {
    logAuctionError("auction_invalid_bid_delete_failed", error, {
      auctionId: auction.id,
      messageId: message.id,
      userId: message.author.id,
    });
  });
}

async function handleBidMessage(
  client: Client,
  pool: PgPool,
  message: Message,
  amount: string,
) {
  const connection = await pool.connect();
  let auctionToNotify: AuctionRow | null = null;
  let rejection: string | null = null;
  let expired = false;
  try {
    await connection.query("BEGIN");
    const selected = await connection.query<AuctionRow>(
      `SELECT ${auctionRowSelect()}
       FROM discord_auctions
       WHERE guild_id = $1
         AND channel_id = $2
         AND status = 'active'
       FOR UPDATE`,
      [auctionGuildId, auctionChannelId],
    );
    const auction = selected.rows[0];
    if (!auction) {
      await connection.query("COMMIT");
      return;
    }
    if (!auction.ends_at || auction.ends_at.getTime() <= Date.now()) {
      await connection.query(
        `UPDATE discord_auctions
         SET status = 'completed', completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [auction.id],
      );
      auctionToNotify = { ...auction, status: "completed" };
      rejection = "انتهى وقت المزاد، لذلك لا يمكن قبول مزايدات جديدة.";
      expired = true;
      await connection.query("COMMIT");
    } else {
      const comparison = await connection.query<{
        not_above_start: boolean;
        not_above_current: boolean;
      }>(
        `SELECT
           $1::numeric <= $2::numeric AS not_above_start,
           $3::numeric IS NOT NULL AND $1::numeric <= $3::numeric
             AS not_above_current`,
        [amount, auction.starting_price, auction.current_bid],
      );
      const checks = comparison.rows[0];
      if (checks?.not_above_start) {
        auctionToNotify = auction;
        rejection = `يجب أن تكون المزايدة أعلى من سعر البدء (${formatAuctionAmount(auction.starting_price)}).`;
        await connection.query("COMMIT");
      } else if (checks?.not_above_current) {
        auctionToNotify = auction;
        rejection = `يجب أن تتجاوز آخر مزايدة (${formatAuctionAmount(auction.current_bid)}).`;
        await connection.query("COMMIT");
      } else {
        await connection.query(
          `UPDATE discord_auctions
           SET current_bid = $2::numeric,
               highest_bidder_id = $3,
               updated_at = now()
           WHERE id = $1 AND status = 'active'`,
          [auction.id, amount, message.author.id],
        );
        await connection.query("COMMIT");
        logAuctionInfo("auction_bid_accepted", {
          auctionId: auction.id,
          userId: message.author.id,
          messageId: message.id,
        });
      }
    }
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }

  if (auctionToNotify && rejection) {
    await deliverBidRejection(
      client,
      pool,
      auctionToNotify,
      message,
      rejection,
    );
    if (expired) void runAuctionMaintenance(client, pool);
  }
}

async function handleAuctionMessage(
  client: Client,
  pool: PgPool,
  message: Message,
) {
  if (
    !message.inGuild() ||
    message.author.bot ||
    message.webhookId ||
    message.guildId !== auctionGuildId ||
    message.channelId !== auctionChannelId
  ) {
    return;
  }

  const text = message.content.trim();
  if (text === "مزاد") {
    const member =
      message.member ??
      (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member?.roles.cache.has(auctionStarterRoleId)) return;
    if (!auctionChannelReady) {
      await message.author
        .send({
          content:
            "إعداد المزاد غير متاح حالياً لأن صلاحيات البوت في القناة غير مكتملة.",
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
      return;
    }
    try {
      await createAuctionSetup(client, pool, message);
    } catch (error) {
      logAuctionError("auction_setup_creation_failed", error, {
        channelId: message.channelId,
        userId: message.author.id,
      });
      await message.author
        .send({
          content:
            "تعذر فتح إعداد المزاد في خيط خاص. لم أرسل تفاصيل الخطأ في القناة العامة.",
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
    }
    return;
  }

  if (!auctionChannelReady) return;
  const amount = parseAuctionAmount(text);
  if (amount === null) return;
  await handleBidMessage(client, pool, message, amount);
}

async function completeExpiredAuctions(pool: PgPool) {
  await pool.query(`
    WITH expired AS (
      SELECT id
      FROM discord_auctions
      WHERE status = 'active' AND ends_at <= now()
      ORDER BY ends_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE discord_auctions AS auction
    SET status = 'completed',
        completed_at = COALESCE(auction.completed_at, now()),
        updated_at = now()
    FROM expired
    WHERE auction.id = expired.id
  `);
  await pool.query(
    `UPDATE discord_auctions
     SET status = 'cancelled', updated_at = now()
     WHERE status = 'setup'
       AND created_at < now() - ($1::bigint * interval '1 millisecond')`,
    [auctionSetupExpiryMs],
  );
}

async function sendPendingAuctionAnnouncements(
  client: Client,
  pool: PgPool,
) {
  const pending = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()}
     FROM discord_auctions
     WHERE (status = 'active' AND start_message_id IS NULL)
        OR (status = 'completed'
            AND (start_message_id IS NULL OR result_message_id IS NULL))
     ORDER BY started_at NULLS FIRST, created_at`,
  );
  for (const auction of pending.rows) {
    try {
      const channel = await getAuctionTextChannel(client);
      let startMessageId = auction.start_message_id;
      if (!startMessageId && auction.ends_at && auction.starting_price && auction.item_name) {
        const startMessage = await channel.send({
          embeds: [
            makeAuctionStartedEmbed({
              item_name: auction.item_name,
              starting_price: auction.starting_price,
              ends_at: auction.ends_at,
            }),
          ],
          allowedMentions: { parse: [] },
        });
        startMessageId = startMessage.id;
        await pool.query(
          `UPDATE discord_auctions
           SET start_message_id = $2, updated_at = now()
           WHERE id = $1 AND start_message_id IS NULL`,
          [auction.id, startMessageId],
        );
      }

      if (auction.status === "completed" && !auction.result_message_id) {
        if (!startMessageId) continue;
        const resultMessage = await channel.send({
          embeds: [
            makeAuctionResultEmbed({
              item_name: auction.item_name ?? "عنصر المزاد",
              starting_price: auction.starting_price ?? "0",
              current_bid: auction.current_bid,
              highest_bidder_id: auction.highest_bidder_id,
              completed_at: auction.completed_at,
            }),
          ],
          allowedMentions: {
            parse: [],
            users: auction.highest_bidder_id
              ? [auction.highest_bidder_id]
              : [],
          },
        });
        await pool.query(
          `UPDATE discord_auctions
           SET result_message_id = $2, updated_at = now()
           WHERE id = $1 AND result_message_id IS NULL`,
          [auction.id, resultMessage.id],
        );
      }
    } catch (error) {
      logAuctionError("auction_announcement_delivery_failed", error, {
        auctionId: auction.id,
        status: auction.status,
      });
    }
  }
}

async function runAuctionMaintenance(client: Client, pool: PgPool) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await completeExpiredAuctions(pool);
    await sendPendingAuctionAnnouncements(client, pool);
  } catch (error) {
    logAuctionError("auction_maintenance_failed", error);
  } finally {
    maintenanceRunning = false;
  }
}

async function handleAuctionInteraction(
  client: Client,
  pool: PgPool,
  interaction: Interaction,
) {
  try {
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("auction:")
    ) {
      await handleAuctionButton(pool, interaction);
    } else if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("auction:")
    ) {
      await handleAuctionModal(client, pool, interaction);
    }
  } catch (error) {
    logAuctionError("auction_interaction_failed", error);
    if (interaction.isButton() || interaction.isModalSubmit()) {
      await replyPrivately(
        interaction,
        "تعذر حفظ إعداد المزاد حالياً. حاول مرة أخرى.",
      ).catch(() => undefined);
    }
  }
}

export function attachAuctionFeature(client: Client, pool: PgPool) {
  const onMessage = (message: Message) => {
    void handleAuctionMessage(client, pool, message).catch((error: unknown) => {
      logAuctionError("auction_message_handler_failed", error, {
        channelId: message.channelId,
        guildId: message.guildId ?? "none",
        userId: message.author.id,
      });
    });
  };
  const onInteraction = (interaction: Interaction) => {
    void handleAuctionInteraction(client, pool, interaction);
  };
  const onReady = () => {
    void validateAuctionChannel(client)
      .then((ready) => {
        auctionChannelReady = ready;
        if (!ready) return;
        void runAuctionMaintenance(client, pool);
        maintenanceTimer = setInterval(() => {
          void runAuctionMaintenance(client, pool);
        }, auctionMaintenanceIntervalMs);
        maintenanceTimer.unref();
      })
      .catch((error: unknown) => {
        auctionChannelReady = false;
        logAuctionError("auction_channel_validation_failed", error, {
          channelId: auctionChannelId,
        });
      });
  };

  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, onInteraction);
  client.once(Events.ClientReady, onReady);

  return () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.InteractionCreate, onInteraction);
    client.off(Events.ClientReady, onReady);
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }
  };
}