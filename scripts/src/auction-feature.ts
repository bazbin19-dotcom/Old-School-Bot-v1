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
  type Guild,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import { Pool as PgPool, type QueryResultRow } from "pg";
import {
  makeAuctionBidButton,
  makeAuctionOpenButton,
  makeAuctionResultEmbed,
  makeAuctionSetupPanel,
  makeAuctionStartedEmbed,
  type AuctionPanelValues,
} from "./auction-messages.js";
import {
  formatAuctionAmount,
  formatAuctionDuration,
  parseAuctionAmount,
  parseAuctionDurationMs,
} from "./auction-parsing.js";

const auctionGuildId = "1313568118198632520";
const auctionChannelId = "1553713559501021305";
const auctionStarterRoleId = "1553725198782701598";
const auctionMaintenanceIntervalMs = 5_000;
const auctionSetupExpiryMs = 7 * 24 * 60 * 60 * 1_000;

type AuctionStatus = "setup" | "active" | "completed" | "cancelled";
type AuctionField = "duration" | "price" | "item";

type AuctionRow = QueryResultRow &
  AuctionPanelValues & {
    id: string;
    guild_id: string;
    channel_id: string;
    setup_channel_id: string;
    setup_message_id: string | null;
    setup_ephemeral_message_id: string | null;
    setup_session_id: string | null;
    setup_launcher_expires_at: Date | null;
    setup_launcher_deleted: boolean;
    creator_id: string;
    started_at: Date | null;
    completed_at: Date | null;
    start_message_id: string | null;
    result_message_id: string | null;
    bid_button_configured: boolean;
    bid_button_disabled: boolean;
    setup_launcher_disabled: boolean;
    created_at: Date;
  };

type BidRow = QueryResultRow & {
  id: string;
  auction_id: string;
  user_id: string;
  amount: string;
};

let maintenanceTimer: NodeJS.Timeout | undefined;
let maintenanceRunning = false;
let auctionChannelReady = false;
const setupQueues = new Map<string, Promise<void>>();

function logAuctionError(
  event: string,
  error: unknown,
  details: Record<string, string> = {},
) {
  const info =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown; message?: unknown })
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...details,
      errorName: typeof info.name === "string" ? info.name : "Error",
      ...(info.code !== undefined ? { errorCode: String(info.code) } : {}),
      ...(typeof info.message === "string"
        ? { errorMessage: info.message.slice(0, 240) }
        : {}),
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

function auctionRowSelect() {
  return `id, guild_id, channel_id, setup_channel_id, setup_message_id,
          setup_ephemeral_message_id, setup_session_id,
          setup_launcher_expires_at, setup_launcher_deleted,
          creator_id, status,
          duration_ms, starting_price, item_name, current_bid,
          highest_bidder_id, started_at, ends_at, completed_at,
          start_message_id, result_message_id, bid_button_configured,
          bid_button_disabled, setup_launcher_disabled, created_at`;
}

export async function initializeAuctionTables(pool: PgPool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_auctions (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      setup_channel_id text NOT NULL,
      setup_message_id text,
      setup_ephemeral_message_id text,
      setup_session_id text,
      setup_launcher_expires_at timestamptz,
      setup_launcher_deleted boolean NOT NULL DEFAULT false,
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
      bid_button_configured boolean NOT NULL DEFAULT false,
      bid_button_disabled boolean NOT NULL DEFAULT false,
      setup_launcher_disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    DO $auction_migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'discord_auctions'
          AND column_name = 'setup_thread_id'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'discord_auctions'
          AND column_name = 'setup_channel_id'
      ) THEN
        ALTER TABLE discord_auctions
          RENAME COLUMN setup_thread_id TO setup_channel_id;
        UPDATE discord_auctions
        SET status = 'cancelled', setup_message_id = NULL, updated_at = now()
        WHERE status = 'setup';
      END IF;
    END
    $auction_migration$
  `);
  await pool.query(`
    ALTER TABLE discord_auctions
      ADD COLUMN IF NOT EXISTS setup_channel_id text
  `);
  await pool.query(`
    ALTER TABLE discord_auctions
      ADD COLUMN IF NOT EXISTS setup_ephemeral_message_id text,
      ADD COLUMN IF NOT EXISTS setup_session_id text,
      ADD COLUMN IF NOT EXISTS setup_launcher_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS setup_launcher_deleted boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS bid_button_configured boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS bid_button_disabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS setup_launcher_disabled boolean NOT NULL DEFAULT false
  `);
  await pool.query(`
    UPDATE discord_auctions
    SET setup_channel_id = channel_id
    WHERE setup_channel_id IS NULL OR setup_channel_id <> channel_id
  `);
  await pool.query(`
    UPDATE discord_auctions
    SET setup_launcher_expires_at = created_at + interval '1 minute'
    WHERE setup_message_id IS NOT NULL
      AND setup_launcher_expires_at IS NULL
      AND NOT setup_launcher_deleted
  `);
  await pool.query(`
    ALTER TABLE discord_auctions
      ALTER COLUMN setup_channel_id SET NOT NULL
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
    CREATE TABLE IF NOT EXISTS discord_auction_bids (
      id bigserial PRIMARY KEY,
      auction_id text NOT NULL
        REFERENCES discord_auctions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      amount numeric(24, 6) NOT NULL,
      public_message_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_auction_bids_pending_idx
      ON discord_auction_bids (created_at, id)
      WHERE public_message_id IS NULL
  `);
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

function isUnknownDiscordMessage(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "10008",
  );
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
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
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

async function memberHasStarterRole(guild: Guild | null, userId: string) {
  if (!guild || guild.id !== auctionGuildId) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(member?.roles.cache.has(auctionStarterRoleId));
}

async function sendAuctionSetupLauncher(
  pool: PgPool,
  channel: TextChannel,
  auctionId: string,
  creatorId: string,
) {
  let launcherMessage: Message | null = null;
  try {
    launcherMessage = await channel.send({
      content: "اضغط «إعداد المزاد» خلال دقيقة لفتح لوحة الإعداد التي لا يراها سواك.",
      components: [makeAuctionOpenButton(auctionId)],
      allowedMentions: { parse: [] },
    });
    const stored = await pool.query<{ id: string }>(
      `UPDATE discord_auctions
       SET setup_message_id = $2,
           setup_launcher_expires_at = now() + interval '1 minute',
           setup_launcher_deleted = false,
           setup_launcher_disabled = false,
           updated_at = now()
       WHERE id = $1 AND status = 'setup' AND creator_id = $3
       RETURNING id`,
      [auctionId, launcherMessage.id, creatorId],
    );
    if (!stored.rows[0]) {
      await launcherMessage.delete().catch(() => undefined);
      return false;
    }
    logAuctionInfo("auction_setup_launcher_created", {
      auctionId,
      creatorId,
      messageId: launcherMessage.id,
    });
    return true;
  } catch (error) {
    await launcherMessage?.delete().catch(() => undefined);
    throw error;
  }
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
         AND created_at < now() - ($2::double precision * interval '1 millisecond')`,
      [auctionChannelId, auctionSetupExpiryMs],
    );
    const existing = await pool.query<{
      id: string;
      status: AuctionStatus;
      creator_id: string;
      setup_message_id: string | null;
      setup_launcher_expires_at: Date | null;
      setup_launcher_deleted: boolean;
    }>(
      `SELECT id, status, creator_id, setup_message_id,
              setup_launcher_expires_at, setup_launcher_deleted
       FROM discord_auctions
       WHERE channel_id = $1 AND status IN ('setup', 'active')
       LIMIT 1`,
      [auctionChannelId],
    );
    const current = existing.rows[0];
    if (current) {
      const launcherExpired =
        current.setup_launcher_deleted ||
        !current.setup_message_id ||
        !current.setup_launcher_expires_at ||
        current.setup_launcher_expires_at.getTime() <= Date.now();
      if (
        current.status === "setup" &&
        current.creator_id === message.author.id &&
        launcherExpired
      ) {
        const channel = await getAuctionTextChannel(client);
        if (current.setup_message_id) {
          const previousLauncher = await channel.messages
            .fetch(current.setup_message_id)
            .catch(() => null);
          await previousLauncher?.delete().catch(() => undefined);
        }
        await sendAuctionSetupLauncher(
          pool,
          channel,
          current.id,
          message.author.id,
        );
        return;
      }
      logAuctionInfo("auction_setup_already_open", {
        auctionId: current.id,
        userId: message.author.id,
      });
      return;
    }

    const channel = await getAuctionTextChannel(client);
    const auctionId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO discord_auctions
           (id, guild_id, channel_id, setup_channel_id, creator_id, status)
         VALUES ($1, $2, $3, $4, $5, 'setup')`,
        [
          auctionId,
          auctionGuildId,
          auctionChannelId,
          auctionChannelId,
          message.author.id,
        ],
      );
      await sendAuctionSetupLauncher(
        pool,
        channel,
        auctionId,
        message.author.id,
      );
    } catch (error) {
      await pool.query("DELETE FROM discord_auctions WHERE id = $1", [auctionId])
        .catch(() => undefined);
      if (isUniqueViolation(error)) {
        logAuctionInfo("auction_setup_race_lost", {
          auctionId,
          userId: message.author.id,
        });
        return;
      }
      throw error;
    }
  });
}

async function getAuction(pool: PgPool, auctionId: string) {
  const result = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()}
     FROM discord_auctions
     WHERE id = $1`,
    [auctionId],
  );
  return result.rows[0] ?? null;
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

function makeAuctionSetupFieldModal(
  field: AuctionField,
  auctionId: string,
  sessionId: string,
) {
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
    .setCustomId(`auction:setup:${field}:${auctionId}:${sessionId}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function makeAuctionBidModal(auctionId: string) {
  const input = new TextInputBuilder()
    .setCustomId("bid_amount")
    .setLabel("مبلغ المزايدة")
    .setPlaceholder("اكتب رقماً أعلى من السعر الحالي")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(40);
  return new ModalBuilder()
    .setCustomId(`auction:bid_submit:${auctionId}`)
    .setTitle("تقديم مزايدة")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

async function handleAuctionOpenButton(
  pool: PgPool,
  interaction: ButtonInteraction,
  auctionId: string,
) {
  const auction = await getAuction(pool, auctionId);
  if (
    !auction ||
    auction.status !== "setup" ||
    auction.creator_id !== interaction.user.id ||
    auction.guild_id !== auctionGuildId ||
    interaction.guildId !== auctionGuildId ||
    interaction.channelId !== auction.setup_channel_id ||
    interaction.message.id !== auction.setup_message_id ||
    !auction.setup_launcher_expires_at ||
    auction.setup_launcher_expires_at.getTime() <= Date.now()
  ) {
    await replyPrivately(interaction, "هذا الإعداد غير متاح لك أو لم يعد مفتوحاً.");
    return;
  }
  if (!(await memberHasStarterRole(interaction.guild, interaction.user.id))) {
    await replyPrivately(interaction, "لم يعد لديك الدور المطلوب لإعداد المزاد.");
    return;
  }

  const sessionId = randomUUID();
  await pool.query(
    `UPDATE discord_auctions
     SET setup_session_id = $2, setup_ephemeral_message_id = NULL,
         updated_at = now()
     WHERE id = $1 AND status = 'setup' AND creator_id = $3`,
    [auctionId, sessionId, interaction.user.id],
  );
  await interaction.reply({
    components: [makeAuctionSetupPanel(auctionId, sessionId)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    fetchReply: true,
    allowedMentions: { parse: [] },
  });
  const ephemeralMessage = await interaction.fetchReply();
  await pool.query(
    `UPDATE discord_auctions
     SET setup_ephemeral_message_id = $2, updated_at = now()
     WHERE id = $1 AND setup_session_id = $3 AND status = 'setup'`,
    [auctionId, ephemeralMessage.id, sessionId],
  );
}

async function handleAuctionSetupFieldButton(
  pool: PgPool,
  interaction: ButtonInteraction,
  field: string | undefined,
  auctionId: string | undefined,
  sessionId: string | undefined,
) {
  if (
    !auctionId ||
    !sessionId ||
    !["duration", "price", "item"].includes(field ?? "")
  ) {
    return;
  }
  const auction = await getAuction(pool, auctionId);
  if (
    !auction ||
    auction.status !== "setup" ||
    auction.creator_id !== interaction.user.id ||
    auction.guild_id !== auctionGuildId ||
    interaction.guildId !== auctionGuildId ||
    interaction.channelId !== auction.setup_channel_id ||
    interaction.message.id !== auction.setup_ephemeral_message_id ||
    auction.setup_session_id !== sessionId
  ) {
    await replyPrivately(interaction, "هذا الإعداد المؤقت لم يعد صالحاً.");
    return;
  }
  await interaction.showModal(
    makeAuctionSetupFieldModal(field as AuctionField, auctionId, sessionId),
  );
}

async function handleAuctionBidButton(
  pool: PgPool,
  interaction: ButtonInteraction,
  auctionId: string | undefined,
) {
  if (!auctionId) return;
  const auction = await getAuction(pool, auctionId);
  if (
    !auction ||
    auction.guild_id !== auctionGuildId ||
    auction.channel_id !== interaction.channelId ||
    auction.start_message_id !== interaction.message.id ||
    auction.status !== "active"
  ) {
    await replyPrivately(interaction, "انتهى هذا المزاد أو لم يعد متاحاً للمزايدة.");
    return;
  }
  await interaction.showModal(makeAuctionBidModal(auctionId));
}

async function handleAuctionButton(
  pool: PgPool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, fieldOrAuctionId, auctionOrSessionId, sessionId] =
    interaction.customId.split(":");
  if (prefix !== "auction") return;

  if (action === "open" && fieldOrAuctionId) {
    await handleAuctionOpenButton(pool, interaction, fieldOrAuctionId);
    return;
  }
  if (action === "bid" && fieldOrAuctionId) {
    await handleAuctionBidButton(pool, interaction, fieldOrAuctionId);
    return;
  }
  if (action === "field") {
    await handleAuctionSetupFieldButton(
      pool,
      interaction,
      fieldOrAuctionId,
      auctionOrSessionId,
      sessionId,
    );
  }
}

async function saveAuctionField(
  pool: PgPool,
  auctionId: string,
  userId: string,
  channelId: string,
  sessionId: string,
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
      auction.setup_channel_id !== channelId ||
      auction.setup_session_id !== sessionId ||
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
    const cast =
      field === "duration" ? "::bigint" : field === "price" ? "::numeric" : "";
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
    if (!updatedAuction) {
      throw new Error("Auction setup disappeared while saving.");
    }

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

async function handleAuctionSetupModal(
  client: Client,
  pool: PgPool,
  interaction: ModalSubmitInteraction,
  fieldValue: string | undefined,
  auctionId: string | undefined,
  sessionId: string | undefined,
) {
  if (
    !auctionId ||
    !sessionId ||
    !["duration", "price", "item"].includes(fieldValue ?? "")
  ) {
    return;
  }
  if (interaction.channelId !== auctionChannelId) {
    await replyPrivately(interaction, "هذا النموذج متاح داخل قناة المزاد فقط.");
    return;
  }
  const field = fieldValue as AuctionField;
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

  const saved = await saveAuctionField(
    pool,
    auctionId,
    interaction.user.id,
    interaction.channelId,
    sessionId,
    field,
    value,
  );
  if (saved.kind === "unavailable") {
    await replyPrivately(interaction, "هذا الإعداد لم يعد متاحاً.");
    return;
  }
  if (saved.started) {
    await replyPrivately(
      interaction,
      "اكتمل الإعداد وبدأ المزاد. سيظهر الإعلان العام في القناة.",
    );
    void runAuctionMaintenance(client, pool);
    return;
  }

  const savedLabel =
    field === "duration"
      ? formatAuctionDuration(String(value))
      : field === "price"
        ? formatAuctionAmount(String(value))
        : "اسم العنصر";
  await replyPrivately(
    interaction,
    `تم حفظ ${savedLabel}. أكمل الحقول المتبقية من لوحة الإعداد المؤقتة.`,
  );
}

type BidDecision =
  | { kind: "accepted"; bidId: string; auctionId: string }
  | { kind: "below_start"; startingPrice: string }
  | { kind: "below_current"; currentBid: string }
  | { kind: "ended" }
  | { kind: "unavailable" };

async function recordAuctionBid(
  pool: PgPool,
  auctionId: string,
  userId: string,
  amount: string,
): Promise<BidDecision> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const selected = await connection.query<AuctionRow>(
      `SELECT ${auctionRowSelect()}
       FROM discord_auctions
       WHERE id = $1 AND guild_id = $2 AND channel_id = $3
       FOR UPDATE`,
      [auctionId, auctionGuildId, auctionChannelId],
    );
    const auction = selected.rows[0];
    if (
      !auction ||
      auction.status !== "active" ||
      !auction.ends_at ||
      auction.starting_price === null
    ) {
      await connection.query("COMMIT");
      return { kind: "unavailable" };
    }

    if (auction.ends_at.getTime() <= Date.now()) {
      await connection.query(
        `UPDATE discord_auctions
         SET status = 'completed',
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [auction.id],
      );
      await connection.query("COMMIT");
      return { kind: "ended" };
    }

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
      await connection.query("COMMIT");
      return {
        kind: "below_start",
        startingPrice: auction.starting_price,
      };
    }
    if (checks?.not_above_current && auction.current_bid !== null) {
      await connection.query("COMMIT");
      return { kind: "below_current", currentBid: auction.current_bid };
    }

    await connection.query(
      `UPDATE discord_auctions
       SET current_bid = $2::numeric,
           highest_bidder_id = $3,
           updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [auction.id, amount, userId],
    );
    const bid = await connection.query<{ id: string }>(
      `INSERT INTO discord_auction_bids (auction_id, user_id, amount)
       VALUES ($1, $2, $3::numeric)
       RETURNING id`,
      [auction.id, userId, amount],
    );
    const bidId = bid.rows[0]?.id;
    if (!bidId) throw new Error("Could not record the accepted auction bid.");
    await connection.query("COMMIT");
    logAuctionInfo("auction_bid_accepted", {
      auctionId: auction.id,
      userId,
      bidId,
    });
    return { kind: "accepted", bidId, auctionId: auction.id };
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function handleAuctionBidModal(
  client: Client,
  pool: PgPool,
  interaction: ModalSubmitInteraction,
  auctionId: string | undefined,
) {
  if (!auctionId || interaction.channelId !== auctionChannelId) return;
  const amount = parseAuctionAmount(
    interaction.fields.getTextInputValue("bid_amount").trim(),
  );
  if (amount === null) {
    await replyPrivately(interaction, "اكتب مبلغاً موجباً بالأرقام، مثل: 1000.");
    return;
  }

  const decision = await recordAuctionBid(
    pool,
    auctionId,
    interaction.user.id,
    amount,
  );
  if (decision.kind === "below_start") {
    await replyPrivately(
      interaction,
      `المبلغ أقل من سعر البدء. أدخل مبلغاً أعلى من ${formatAuctionAmount(decision.startingPrice)}.`,
    );
    return;
  }
  if (decision.kind === "below_current") {
    await replyPrivately(
      interaction,
      `المبلغ أقل من آخر مزايدة. أدخل مبلغاً أعلى من ${formatAuctionAmount(decision.currentBid)}.`,
    );
    return;
  }
  if (decision.kind === "ended") {
    await replyPrivately(interaction, "انتهى المزاد؛ لا يمكن قبول مزايدات جديدة.");
    void runAuctionMaintenance(client, pool);
    return;
  }
  if (decision.kind === "unavailable") {
    await replyPrivately(interaction, "هذا المزاد لم يعد متاحاً للمزايدة.");
    return;
  }

  await replyPrivately(
    interaction,
    "تم قبول مزايدتك. سينشر البوت الرقم علناً في القناة.",
  );
  void runAuctionMaintenance(client, pool);
}

async function handleAuctionModal(
  client: Client,
  pool: PgPool,
  interaction: ModalSubmitInteraction,
) {
  const [prefix, action, fieldOrAuctionId, auctionOrSessionId, sessionId] =
    interaction.customId.split(":");
  if (prefix !== "auction") return;
  if (action === "bid_submit") {
    await handleAuctionBidModal(client, pool, interaction, fieldOrAuctionId);
    return;
  }
  if (action === "setup") {
    await handleAuctionSetupModal(
      client,
      pool,
      interaction,
      fieldOrAuctionId,
      auctionOrSessionId,
      sessionId,
    );
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
    message.channelId !== auctionChannelId ||
    message.content.trim() !== "مزاد" ||
    !auctionChannelReady
  ) {
    return;
  }

  const member =
    message.member ??
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member?.roles.cache.has(auctionStarterRoleId)) return;
  await createAuctionSetup(client, pool, message);
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
       AND created_at < now() - ($1::double precision * interval '1 millisecond')`,
    [auctionSetupExpiryMs],
  );
}

async function sendPendingStartAnnouncements(
  client: Client,
  pool: PgPool,
  channel: TextChannel,
) {
  const pending = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()}
     FROM discord_auctions
     WHERE status IN ('active', 'completed')
       AND start_message_id IS NULL
       AND ends_at IS NOT NULL
       AND starting_price IS NOT NULL
       AND item_name IS NOT NULL
     ORDER BY started_at NULLS FIRST, created_at`,
  );
  for (const auction of pending.rows) {
    try {
      const isActive = auction.status === "active";
      const message = await channel.send({
        embeds: [
          makeAuctionStartedEmbed({
            item_name: auction.item_name!,
            starting_price: auction.starting_price!,
            ends_at: auction.ends_at!,
          }),
        ],
        components: [makeAuctionBidButton(auction.id, !isActive)],
        allowedMentions: { parse: [] },
      });
      await pool.query(
        `UPDATE discord_auctions
         SET start_message_id = $2,
             bid_button_configured = true,
             bid_button_disabled = $3,
             updated_at = now()
         WHERE id = $1 AND start_message_id IS NULL`,
        [auction.id, message.id, !isActive],
      );
    } catch (error) {
      logAuctionError("auction_start_announcement_failed", error, {
        auctionId: auction.id,
      });
    }
  }
}

async function updateExistingAuctionButtons(
  pool: PgPool,
  channel: TextChannel,
) {
  const pending = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()}
     FROM discord_auctions
     WHERE start_message_id IS NOT NULL
       AND (
         (status = 'active' AND NOT bid_button_configured)
         OR (status = 'completed' AND NOT bid_button_disabled)
       )
     ORDER BY started_at NULLS FIRST`,
  );
  for (const auction of pending.rows) {
    try {
      const startMessage = await channel.messages.fetch(auction.start_message_id!);
      const isActive = auction.status === "active";
      await startMessage.edit({
        embeds: startMessage.embeds,
        components: [makeAuctionBidButton(auction.id, !isActive)],
        allowedMentions: { parse: [] },
      });
      await pool.query(
        `UPDATE discord_auctions
         SET bid_button_configured = true,
             bid_button_disabled = $2,
             updated_at = now()
         WHERE id = $1`,
        [auction.id, !isActive],
      );
    } catch (error) {
      if (isUnknownDiscordMessage(error)) {
        if (auction.status === "active" && auction.ends_at) {
          try {
            const replacement = await channel.send({
              embeds: [
                makeAuctionStartedEmbed({
                  item_name: auction.item_name ?? "عنصر المزاد",
                  starting_price: auction.starting_price ?? "0",
                  ends_at: auction.ends_at,
                }),
              ],
              components: [makeAuctionBidButton(auction.id)],
              allowedMentions: { parse: [] },
            });
            await pool.query(
              `UPDATE discord_auctions
               SET start_message_id = $2,
                   bid_button_configured = true,
                   bid_button_disabled = false,
                   updated_at = now()
               WHERE id = $1`,
              [auction.id, replacement.id],
            );
            logAuctionInfo("auction_start_message_recreated", {
              auctionId: auction.id,
              messageId: replacement.id,
            });
          } catch (recoveryError) {
            logAuctionError(
              "auction_start_message_recreation_failed",
              recoveryError,
              { auctionId: auction.id },
            );
          }
        } else {
          await pool.query(
            `UPDATE discord_auctions
             SET bid_button_configured = true,
                 bid_button_disabled = true,
                 updated_at = now()
             WHERE id = $1`,
            [auction.id],
          );
          logAuctionInfo("auction_completed_start_message_missing", {
            auctionId: auction.id,
          });
        }
        continue;
      }
      logAuctionError("auction_bid_button_update_failed", error, {
        auctionId: auction.id,
      });
    }
  }
}

async function sendPendingBidAnnouncements(
  pool: PgPool,
  channel: TextChannel,
) {
  const pending = await pool.query<BidRow>(
    `SELECT bid.id, bid.auction_id, bid.user_id, bid.amount::text AS amount
     FROM discord_auction_bids AS bid
     JOIN discord_auctions AS auction ON auction.id = bid.auction_id
     WHERE bid.public_message_id IS NULL
       AND auction.start_message_id IS NOT NULL
     ORDER BY bid.created_at, bid.id
     LIMIT 50`,
  );
  for (const bid of pending.rows) {
    try {
      const message = await channel.send({
        content: `<@${bid.user_id}> — مزايدة: **${formatAuctionAmount(bid.amount)}**`,
        allowedMentions: { parse: [] },
      });
      await pool.query(
        `UPDATE discord_auction_bids
         SET public_message_id = $2
         WHERE id = $1 AND public_message_id IS NULL`,
        [bid.id, message.id],
      );
    } catch (error) {
      logAuctionError("auction_bid_announcement_failed", error, {
        auctionId: bid.auction_id,
        bidId: bid.id,
      });
    }
  }
}

async function sendPendingAuctionResults(
  pool: PgPool,
  channel: TextChannel,
) {
  const pending = await pool.query<AuctionRow>(
    `SELECT ${auctionRowSelect()}
     FROM discord_auctions AS auction
     WHERE auction.status = 'completed'
       AND auction.result_message_id IS NULL
       AND auction.start_message_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM discord_auction_bids AS bid
         WHERE bid.auction_id = auction.id
           AND bid.public_message_id IS NULL
       )
     ORDER BY auction.completed_at NULLS FIRST`,
  );
  for (const auction of pending.rows) {
    try {
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
    } catch (error) {
      logAuctionError("auction_result_announcement_failed", error, {
        auctionId: auction.id,
      });
    }
  }
}

async function deleteExpiredSetupLaunchers(
  pool: PgPool,
  channel: TextChannel,
) {
  const pending = await pool.query<{
    id: string;
    setup_message_id: string;
  }>(
    `SELECT id, setup_message_id
     FROM discord_auctions
     WHERE setup_message_id IS NOT NULL
       AND setup_launcher_expires_at <= now()
       AND NOT setup_launcher_deleted
     ORDER BY setup_launcher_expires_at
     LIMIT 100`,
  );
  for (const auction of pending.rows) {
    try {
      const launcher = await channel.messages.fetch(auction.setup_message_id);
      await launcher.delete();
    } catch (error) {
      if (!isUnknownDiscordMessage(error)) {
        logAuctionError("auction_setup_launcher_delete_failed", error, {
          auctionId: auction.id,
        });
        continue;
      }
      logAuctionInfo("auction_setup_launcher_already_missing", {
        auctionId: auction.id,
      });
    }
    await pool.query(
      `UPDATE discord_auctions
       SET setup_message_id = NULL,
           setup_launcher_deleted = true,
           setup_launcher_disabled = true,
           updated_at = now()
       WHERE id = $1 AND setup_message_id = $2`,
      [auction.id, auction.setup_message_id],
    );
  }
}

async function runAuctionMaintenance(client: Client, pool: PgPool) {
  if (maintenanceRunning || !auctionChannelReady) return;
  maintenanceRunning = true;
  try {
    await completeExpiredAuctions(pool);
    const channel = await getAuctionTextChannel(client);
    await sendPendingStartAnnouncements(client, pool, channel);
    await updateExistingAuctionButtons(pool, channel);
    await sendPendingBidAnnouncements(pool, channel);
    await sendPendingAuctionResults(pool, channel);
    await deleteExpiredSetupLaunchers(pool, channel);
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
        "تعذر تنفيذ هذا الخيار حالياً. حاول مرة أخرى.",
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