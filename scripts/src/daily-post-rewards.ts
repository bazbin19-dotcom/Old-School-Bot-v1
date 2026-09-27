import {
  ChannelType,
  Events,
  PermissionFlagsBits,
  type Client,
  type DMChannel,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
  type TextChannel,
  type ButtonInteraction,
  type Interaction,
} from "discord.js";
import type { Pool } from "pg";
import {
  sendExpiredStreakMessage,
  sendStreakReminderMessage,
  sendStreakRenewedMessage,
} from "./daily-streak-messages.js";

const rewardChannelIds = new Set([
  "1546491043334201374",
  "1546491155406135296",
  "1546491262142517328",
  "1546491369713958984",
  "1546491461644718080",
  "1546492836592222279",
  "1546492235204534272",
  "1546492627547988049",
  "1546964922649284718",
  "1546922464301416478",
  "1546491554892484669",
  "1546491651198034020",
  "1553714914567135312",
  "1553713879442526209",
  "1498730522803703848",
]);
const streakNoticeChannelId = "1546917729695432795";
const privateStreakNoticeGuildIds = new Set(["1313568118198632520"]);
const rewardGuildIds = new Set<string>();

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Baghdad",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const baghdadClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Baghdad",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const memberQueues = new Map<string, Promise<void>>();
const roleCreationPromises = new Map<string, Promise<Role>>();
let cleanupTimer: NodeJS.Timeout | undefined;
let cleanupRunning = false;
let maintenanceRunning = false;
let heartbeatRunning = false;
let botAvailabilityInitialization: Promise<void> | undefined;
let lastNoticePruneDate: string | undefined;
const heartbeatIntervalMs = 60_000;

type DailyStreakRow = {
  streak_days: number;
  last_post_date: string;
};

type RecoveryStateRow = {
  streak_days: number;
  last_post_date: string;
  expired_streak_days: number;
  recovery_expires_at: Date | null;
  recovery_message_id: string | null;
};

type RecoveryNoticeRow = {
  expired_streak_days: number;
  recovery_expires_at: Date | null;
  recovery_message_id: string | null;
};

type StreakNoticeKind = "renewed" | "reminder_3h" | "reminder_1h";

function baghdadClock(date: Date) {
  const parts = new Map(
    baghdadClockFormatter
      .formatToParts(date)
      .map(({ type, value }) => [type, value] as const),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  if (!year || !month || !day || !hour || !minute) {
    throw new Error("Could not determine the Baghdad local time.");
  }
  return {
    date: `${year}-${month}-${day}`,
    hour: Number(hour),
    minute: Number(minute),
  };
}

async function getStreakNoticeChannel(client: Client): Promise<TextChannel> {
  const channel = await client.channels.fetch(streakNoticeChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("The configured streak-notice channel is unavailable.");
  }
  return channel;
}

async function getStreakDeliveryChannel(
  client: Client,
  guildId: string,
  userId: string,
): Promise<TextChannel | DMChannel | null> {
  if (privateStreakNoticeGuildIds.has(guildId)) {
    const user = await client.users.fetch(userId);
    return user.createDM();
  }

  const noticeChannel = await getStreakNoticeChannel(client);
  return noticeChannel.guildId === guildId ? noticeChannel : null;
}

async function sendStreakNoticeOnce(
  pool: Pool,
  guildId: string,
  userId: string,
  noticeDate: string,
  noticeKind: StreakNoticeKind,
  deliver: () => Promise<unknown>,
) {
  const claim = await pool.query(
    `INSERT INTO discord_daily_post_notices
       (guild_id, user_id, notice_date, notice_type)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (guild_id, user_id, notice_date, notice_type) DO NOTHING
     RETURNING user_id`,
    [guildId, userId, noticeDate, noticeKind],
  );
  if (claim.rows.length === 0) return false;

  try {
    await deliver();
    return true;
  } catch (error) {
    await pool.query(
      `DELETE FROM discord_daily_post_notices
       WHERE guild_id = $1
         AND user_id = $2
         AND notice_date = $3::date
         AND notice_type = $4`,
      [guildId, userId, noticeDate, noticeKind],
    );
    throw error;
  }
}
function baghdadDateString(date: Date) {
  const parts = new Map(
    dateFormatter
      .formatToParts(date)
      .map(({ type, value }) => [type, value] as const),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) {
    throw new Error("Could not determine the Baghdad calendar date.");
  }
  return `${year}-${month}-${day}`;
}

function previousCalendarDate(dateString: string) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function nextCalendarDate(dateString: string) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function recordBotHeartbeat(pool: Pool) {
  const connection = await pool.connect();
  const now = new Date();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(1453379201)",
    );
    const previous = await connection.query<{
      last_seen_at: Date;
    }>(
      `SELECT last_seen_at
       FROM discord_daily_post_bot_heartbeat
       WHERE singleton = TRUE
       FOR UPDATE`,
    );
    const previousHeartbeat = previous.rows[0]?.last_seen_at;

    if (
      previousHeartbeat &&
      now.getTime() - new Date(previousHeartbeat).getTime() >
        heartbeatIntervalMs * 2
    ) {
      const outageDays = await connection.query<{ outage_date: string }>(
        `WITH outage AS (
           SELECT $1::timestamptz AS started_at,
                  $2::timestamptz AS ended_at
         ),
         local_days AS (
           SELECT local_day::date AS outage_date,
                  (local_day::date::timestamp AT TIME ZONE 'Asia/Baghdad')
                    AS day_start,
                  ((local_day::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad')
                    AS day_end,
                  outage.started_at,
                  outage.ended_at
           FROM outage
           CROSS JOIN LATERAL generate_series(
             (outage.started_at AT TIME ZONE 'Asia/Baghdad')::date::timestamp,
             (outage.ended_at AT TIME ZONE 'Asia/Baghdad')::date::timestamp,
             interval '1 day'
           ) AS dates(local_day)
         )
         INSERT INTO discord_daily_post_bot_outage_days (outage_date)
         SELECT outage_date
         FROM local_days
         WHERE LEAST(ended_at, day_end) > GREATEST(started_at, day_start)
           AND EXTRACT(
             EPOCH FROM LEAST(ended_at, day_end) - GREATEST(started_at, day_start)
           ) >= 12 * 60 * 60
         ON CONFLICT (outage_date) DO NOTHING
         RETURNING outage_date::text AS outage_date`,
        [previousHeartbeat, now],
      );
      if (outageDays.rows.length > 0) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "daily_streak_outage_days_recorded",
            timestamp: now.toISOString(),
            dates: outageDays.rows.map((row) => row.outage_date),
          }),
        );
      }
    }

    if (previousHeartbeat) {
      await connection.query(
        `UPDATE discord_daily_post_bot_heartbeat
         SET last_seen_at = $1
         WHERE singleton = TRUE`,
        [now],
      );
    } else {
      const firstObservedDate = nextCalendarDate(baghdadDateString(now));
      await connection.query(
        `INSERT INTO discord_daily_post_bot_heartbeat
           (singleton, last_seen_at, first_fully_observed_date)
         VALUES (TRUE, $1, $2::date)
         ON CONFLICT (singleton)
         DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
        [now, firstObservedDate],
      );
    }

    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function ensureBotAvailabilityInitialized(pool: Pool) {
  if (!botAvailabilityInitialization) {
    botAvailabilityInitialization = recordBotHeartbeat(pool).catch((error) => {
      botAvailabilityInitialization = undefined;
      throw error;
    });
  }
  return botAvailabilityInitialization;
}

async function hasObservedMissedDay(
  pool: Pool,
  lastPostDate: string,
  cutoffDate: string,
) {
  const result = await pool.query<{ has_observed_missed_day: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM discord_daily_post_bot_heartbeat AS heartbeat
       CROSS JOIN LATERAL generate_series(
         GREATEST(
           $1::date + 1,
           heartbeat.first_fully_observed_date
         ),
         $2::date,
         interval '1 day'
       ) AS missed_days(missed_date)
       WHERE NOT EXISTS (
         SELECT 1
         FROM discord_daily_post_bot_outage_days AS outage
         WHERE outage.outage_date = missed_days.missed_date::date
       )
     ) AS has_observed_missed_day`,
    [lastPostDate, cutoffDate],
  );
  return result.rows[0]?.has_observed_missed_day ?? false;
}

function discordErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? String(code)
    : null;
}

function isDiscordErrorCode(error: unknown, code: number) {
  return discordErrorCode(error) === String(code);
}

function logRoleFailure(
  event: string,
  error: unknown,
  details: Record<string, string | number | boolean>,
) {
  const candidate =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown })
      : {};
  console.error(
    JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...details,
      errorName: typeof candidate.name === "string" ? candidate.name : "Error",
      ...(candidate.code !== undefined
        ? { errorCode: String(candidate.code) }
        : {}),
    }),
  );
}

async function withMemberQueue<T>(
  guildId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${guildId}:${userId}`;
  const previous = memberQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => gate,
    () => gate,
  );
  memberQueues.set(key, queued);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (memberQueues.get(key) === queued) memberQueues.delete(key);
  }
}

async function getBotMemberWithRolePermission(guild: Guild) {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot needs Manage Roles to award daily posting roles.");
  }
  return botMember;
}

async function saveRoleMapping(
  pool: Pool,
  guildId: string,
  streakDays: number,
  roleId: string,
) {
  await pool.query(
    `INSERT INTO discord_daily_post_roles (guild_id, streak_days, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, streak_days)
     DO UPDATE SET role_id = EXCLUDED.role_id`,
    [guildId, streakDays, roleId],
  );
}

async function createOrFindDailyRole(
  guild: Guild,
  pool: Pool,
  botMember: GuildMember,
  streakDays: number,
): Promise<Role> {
  const roleName = `${streakDays}🔥`;
  const mapped = await pool.query<{ role_id: string }>(
    `SELECT role_id
     FROM discord_daily_post_roles
     WHERE guild_id = $1 AND streak_days = $2`,
    [guild.id, streakDays],
  );

  let role: Role | null = null;
  if (mapped.rows[0]) {
    try {
      role = await guild.roles.fetch(mapped.rows[0].role_id);
    } catch (error) {
      if (!isDiscordErrorCode(error, 10011)) throw error;
    }
  }

  if (role) {
    if (role.position >= botMember.roles.highest.position) {
      throw new Error(`The bot cannot manage the ${roleName} role.`);
    }
    if (role.name !== roleName) {
      role = await role.setName(roleName, "Restore the daily posting role name");
    }
    return role;
  }

  const allRoles = await guild.roles.fetch();
  const existingRole = allRoles.find(
    (candidate) =>
      candidate.name === roleName &&
      !candidate.managed &&
      candidate.position < botMember.roles.highest.position,
  );
  if (existingRole) {
    await saveRoleMapping(pool, guild.id, streakDays, existingRole.id);
    return existingRole;
  }

  const createdRole = await guild.roles.create({
    name: roleName,
    color: 0xff6a00,
    permissions: [],
    hoist: false,
    mentionable: false,
    reason: `Daily posting streak reward: ${streakDays} day(s)`,
  });
  try {
    await saveRoleMapping(pool, guild.id, streakDays, createdRole.id);
  } catch (error) {
    await createdRole.delete("Could not save the daily role mapping").catch(() => null);
    throw error;
  }
  return createdRole;
}

async function getDailyRole(
  guild: Guild,
  pool: Pool,
  botMember: GuildMember,
  streakDays: number,
) {
  const key = `${guild.id}:${streakDays}`;
  let pending = roleCreationPromises.get(key);
  if (!pending) {
    pending = createOrFindDailyRole(guild, pool, botMember, streakDays);
    roleCreationPromises.set(key, pending);
  }

  try {
    return await pending;
  } finally {
    if (roleCreationPromises.get(key) === pending) {
      roleCreationPromises.delete(key);
    }
  }
}

async function assignDailyRole(
  guild: Guild,
  pool: Pool,
  member: GuildMember,
  streakDays: number,
) {
  const botMember = await getBotMemberWithRolePermission(guild);
  const rewardRole = await getDailyRole(guild, pool, botMember, streakDays);
  let updatedMember = member;
  const alreadyHasReward = updatedMember.roles.cache.has(rewardRole.id);
  if (!alreadyHasReward) {
    updatedMember = await updatedMember.roles.add(
      rewardRole,
      "Daily posting streak updated",
    );
  }

  const mappedRoles = await pool.query<{ role_id: string }>(
    `SELECT role_id
     FROM discord_daily_post_roles
     WHERE guild_id = $1`,
    [guild.id],
  );
  const previousRoleIds = mappedRoles.rows
    .map((row) => row.role_id)
    .filter(
      (roleId) =>
        roleId !== rewardRole.id && updatedMember.roles.cache.has(roleId),
    );
  if (previousRoleIds.length > 0) {
    updatedMember = await updatedMember.roles.remove(
      previousRoleIds,
      "Replace the previous daily posting streak role",
    );
  }

  return { rewardRole, alreadyHasReward, previousRoleIds };
}

async function updateMemberDailyRole(
  client: Client,
  message: Message,
  pool: Pool,
) {
  const guild = message.guild;
  if (!guild) return;

  await withMemberQueue(guild.id, message.author.id, async () => {
    await ensureBotAvailabilityInitialized(pool);
    const activityDate = baghdadDateString(message.createdAt);
    const previous = await pool.query<DailyStreakRow>(
      `SELECT streak_days, last_post_date::text AS last_post_date
       FROM discord_daily_post_streaks
       WHERE guild_id = $1 AND user_id = $2`,
      [guild.id, message.author.id],
    );
    const priorState = previous.rows[0];
    if (
      priorState &&
      priorState.streak_days > 0 &&
      priorState.last_post_date < previousCalendarDate(activityDate) &&
      (await hasObservedMissedDay(
        pool,
        priorState.last_post_date,
        previousCalendarDate(activityDate),
      ))
    ) {
      await expireStaleMemberRoleInQueue(
        client,
        pool,
        guild.id,
        message.author.id,
        previousCalendarDate(activityDate),
      );
    }

    const streakResult = await pool.query<DailyStreakRow>(
      `INSERT INTO discord_daily_post_streaks
         (guild_id, user_id, streak_days, last_post_date)
       VALUES ($1, $2, 1, $3::date)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         streak_days = CASE
           WHEN discord_daily_post_streaks.last_post_date = EXCLUDED.last_post_date
             THEN GREATEST(discord_daily_post_streaks.streak_days, 1)
           WHEN discord_daily_post_streaks.last_post_date < EXCLUDED.last_post_date
             THEN discord_daily_post_streaks.streak_days + 1
           ELSE discord_daily_post_streaks.streak_days
         END,
         last_post_date = GREATEST(
           discord_daily_post_streaks.last_post_date,
           EXCLUDED.last_post_date
         ),
         updated_at = now()
       RETURNING streak_days, last_post_date::text AS last_post_date`,
      [guild.id, message.author.id, activityDate],
    );

    const streakDays = streakResult.rows[0]?.streak_days;
    if (!streakDays || streakDays < 1) return;

    let member = message.member;
    if (!member) member = await guild.members.fetch(message.author.id);
    const { rewardRole, alreadyHasReward, previousRoleIds } =
      await assignDailyRole(guild, pool, member, streakDays);

    if (!alreadyHasReward || previousRoleIds.length > 0) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "daily_post_role_assigned",
          timestamp: new Date().toISOString(),
          guildId: guild.id,
          userId: message.author.id,
          channelId: message.channelId,
          streakDays,
          roleId: rewardRole.id,
        }),
      );
    }

    try {
      const deliveryChannel = await getStreakDeliveryChannel(
        client,
        guild.id,
        message.author.id,
      );
      if (deliveryChannel) {
        await sendStreakNoticeOnce(
          pool,
          guild.id,
          message.author.id,
          activityDate,
          "renewed",
          () =>
            sendStreakRenewedMessage(
              deliveryChannel,
              message.author.id,
              streakDays,
            ),
        );
      }
    } catch (error) {
      logRoleFailure("daily_streak_renewal_notice_failed", error, {
        guildId: guild.id,
        userId: message.author.id,
        channelId: privateStreakNoticeGuildIds.has(guild.id)
          ? "direct-message"
          : streakNoticeChannelId,
      });
    }
  });
}

async function archiveExpiredStreak(
  pool: Pool,
  guildId: string,
  userId: string,
  cutoffDate: string,
) {
  const archived = await pool.query<RecoveryNoticeRow>(
    `WITH stale AS (
       SELECT guild_id,
              user_id,
              ((last_post_date + 2)::timestamp AT TIME ZONE 'Asia/Baghdad') AS expired_at,
              ((last_post_date + 4)::timestamp AT TIME ZONE 'Asia/Baghdad') AS recovery_expires_at
       FROM discord_daily_post_streaks
       WHERE guild_id = $1
         AND user_id = $2
         AND streak_days > 0
          AND last_post_date < $3::date
          AND EXISTS (
            SELECT 1
            FROM discord_daily_post_bot_heartbeat AS heartbeat
            CROSS JOIN LATERAL generate_series(
              GREATEST(
                discord_daily_post_streaks.last_post_date + 1,
                heartbeat.first_fully_observed_date
              ),
              $3::date,
              interval '1 day'
            ) AS missed_days(missed_date)
            WHERE NOT EXISTS (
              SELECT 1
              FROM discord_daily_post_bot_outage_days AS outage
              WHERE outage.outage_date = missed_days.missed_date::date
            )
          )
       FOR UPDATE
     )
     UPDATE discord_daily_post_streaks AS current_streak
     SET streak_days = 0,
         expired_streak_days = CASE
           WHEN stale.recovery_expires_at > now()
             THEN GREATEST(current_streak.expired_streak_days, current_streak.streak_days)
           ELSE 0
         END,
         expired_at = CASE
           WHEN stale.recovery_expires_at > now() THEN stale.expired_at
           ELSE NULL
         END,
         recovery_expires_at = CASE
           WHEN stale.recovery_expires_at > now() THEN stale.recovery_expires_at
           ELSE NULL
         END,
         recovery_message_id = NULL,
         updated_at = now()
     FROM stale
     WHERE current_streak.guild_id = stale.guild_id
       AND current_streak.user_id = stale.user_id
     RETURNING current_streak.expired_streak_days,
               current_streak.recovery_expires_at,
               current_streak.recovery_message_id`,
    [guildId, userId, cutoffDate],
  );
  return archived.rows[0] ?? null;
}

async function expireStaleMemberRoleInQueue(
  client: Client,
  pool: Pool,
  guildId: string,
  userId: string,
  cutoffDate: string,
) {
  const stillStale = await pool.query<DailyStreakRow>(
    `SELECT streak_days, last_post_date::text AS last_post_date
     FROM discord_daily_post_streaks
     WHERE guild_id = $1
       AND user_id = $2
       AND streak_days > 0
       AND last_post_date < $3::date`,
    [guildId, userId, cutoffDate],
  );
  const state = stillStale.rows[0];
  if (
    !state ||
    !(await hasObservedMissedDay(pool, state.last_post_date, cutoffDate))
  ) {
    return false;
  }

  let guild: Guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (error) {
    if (!isDiscordErrorCode(error, 10004)) throw error;
    await archiveExpiredStreak(pool, guildId, userId, cutoffDate);
    return true;
  }

  let member: GuildMember | null = null;
  try {
    member = await guild.members.fetch(userId);
  } catch (error) {
    if (!isDiscordErrorCode(error, 10007)) throw error;
  }

  if (member) {
    const mappedRoles = await pool.query<{ role_id: string }>(
      `SELECT role_id
       FROM discord_daily_post_roles
       WHERE guild_id = $1`,
      [guildId],
    );
    const rolesToRemove = mappedRoles.rows
      .map((row) => row.role_id)
      .filter((roleId) => member?.roles.cache.has(roleId));

    if (rolesToRemove.length > 0) {
      await getBotMemberWithRolePermission(guild);
      await member.roles.remove(
        rolesToRemove,
        "Daily posting streak expired after a missed day",
      );
    }
  }

  const archived = await archiveExpiredStreak(
    pool,
    guildId,
    userId,
    cutoffDate,
  );
  if (archived?.expired_streak_days && archived.recovery_expires_at) {
    await sendPendingRecoveryCardForUser(
      client,
      pool,
      guildId,
      userId,
    );
  }
  return Boolean(archived);
}

async function clearStaleMemberRole(
  guildId: string,
  userId: string,
  cutoffDate: string,
  client: Client,
  pool: Pool,
) {
  return withMemberQueue(guildId, userId, () =>
    expireStaleMemberRoleInQueue(client, pool, guildId, userId, cutoffDate),
  );
}

async function sendPendingRecoveryCardForUser(
  client: Client,
  pool: Pool,
  guildId: string,
  userId: string,
) {
  const recovery = await pool.query<RecoveryNoticeRow>(
    `SELECT expired_streak_days, recovery_expires_at, recovery_message_id
     FROM discord_daily_post_streaks
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  const state = recovery.rows[0];
  if (
    !state ||
    state.expired_streak_days < 1 ||
    !state.recovery_expires_at ||
    state.recovery_message_id ||
    state.recovery_expires_at.getTime() <= Date.now()
  ) {
    return false;
  }

  const deliveryChannel = await getStreakDeliveryChannel(
    client,
    guildId,
    userId,
  );
  if (!deliveryChannel) return false;
  const message = await sendExpiredStreakMessage(
    deliveryChannel,
    userId,
    state.expired_streak_days,
    state.recovery_expires_at,
  );
  await pool.query(
    `UPDATE discord_daily_post_streaks
     SET recovery_message_id = $3, updated_at = now()
     WHERE guild_id = $1
       AND user_id = $2
       AND recovery_message_id IS NULL
       AND recovery_expires_at = $4`,
    [guildId, userId, message.id, state.recovery_expires_at],
  );
  return true;
}

async function sendPendingRecoveryCards(client: Client, pool: Pool) {
  const guildIds = [...rewardGuildIds];
  if (guildIds.length === 0) return;
  const pending = await pool.query<{ guild_id: string; user_id: string }>(
    `SELECT guild_id, user_id
     FROM discord_daily_post_streaks
     WHERE guild_id = ANY($1::text[])
       AND expired_streak_days > 0
       AND recovery_expires_at > now()
       AND recovery_message_id IS NULL`,
    [guildIds],
  );

  for (const row of pending.rows) {
    try {
      await withMemberQueue(row.guild_id, row.user_id, () =>
        sendPendingRecoveryCardForUser(
          client,
          pool,
          row.guild_id,
          row.user_id,
        ),
      );
    } catch (error) {
      logRoleFailure("daily_streak_recovery_notice_failed", error, {
        guildId: row.guild_id,
        userId: row.user_id,
        channelId: privateStreakNoticeGuildIds.has(row.guild_id)
          ? "direct-message"
          : streakNoticeChannelId,
      });
    }
  }
}

async function sendStreakReminders(
  client: Client,
  pool: Pool,
  today: string,
  kind: "three_hours" | "one_hour",
) {
  const noticeKind = kind === "three_hours" ? "reminder_3h" : "reminder_1h";

  for (const guildId of rewardGuildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const rows = await pool.query<{ user_id: string; streak_days: number }>(
        `SELECT user_id, streak_days
         FROM discord_daily_post_streaks
         WHERE guild_id = $1
           AND streak_days > 0
           AND last_post_date < $2::date`,
        [guild.id, today],
      );

      for (const row of rows.rows) {
        try {
          await withMemberQueue(guild.id, row.user_id, async () => {
            const current = await pool.query<DailyStreakRow>(
              `SELECT streak_days, last_post_date::text AS last_post_date
               FROM discord_daily_post_streaks
               WHERE guild_id = $1 AND user_id = $2`,
              [guild.id, row.user_id],
            );
            const currentState = current.rows[0];
            if (
              !currentState ||
              currentState.streak_days < 1 ||
              currentState.last_post_date >= today
            ) {
              return;
            }
            await guild.members.fetch(row.user_id);
            const deliveryChannel = await getStreakDeliveryChannel(
              client,
              guild.id,
              row.user_id,
            );
            if (!deliveryChannel) return;
            await sendStreakNoticeOnce(
              pool,
              guild.id,
              row.user_id,
              today,
              noticeKind,
              () =>
                sendStreakReminderMessage(
                  deliveryChannel,
                  row.user_id,
                  currentState.streak_days,
                  kind,
                ),
            );
          });
        } catch (error) {
          if (isDiscordErrorCode(error, 10007)) continue;
          logRoleFailure("daily_streak_reminder_failed", error, {
            guildId: guild.id,
            userId: row.user_id,
            channelId: privateStreakNoticeGuildIds.has(guild.id)
              ? "direct-message"
              : streakNoticeChannelId,
            reminder: kind,
          });
        }
      }
    } catch (error) {
      logRoleFailure("daily_streak_reminder_guild_failed", error, {
        guildId,
        channelId: privateStreakNoticeGuildIds.has(guildId)
          ? "direct-message"
          : streakNoticeChannelId,
        reminder: kind,
      });
    }
  }
}

async function handleStreakRecovery(
  client: Client,
  pool: Pool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, ownerId] = interaction.customId.split(":");
  if (
    prefix !== "streak" ||
    action !== "recover" ||
    !ownerId ||
    !/^\d{17,20}$/.test(ownerId)
  ) {
    return;
  }

  if (interaction.message.author.id !== client.user?.id) {
    await interaction.reply({
      content: "رسالة استرداد الستريك هذه لم تعد متاحة.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: "زر الاسترداد متاح لصاحب الستريك فقط.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const recoveryOwner = await pool.query<{ guild_id: string }>(
    `SELECT guild_id
     FROM discord_daily_post_streaks
     WHERE user_id = $1
       AND recovery_message_id = $2`,
    [ownerId, interaction.message.id],
  );
  const guildId = recoveryOwner.rows[0]?.guild_id;
  const isGuildRecoveryMessage =
    guildId !== undefined &&
    Boolean(interaction.guildId) &&
    interaction.channelId === streakNoticeChannelId &&
    interaction.guildId === guildId;
  const isPrivateRecoveryMessage =
    guildId !== undefined &&
    !interaction.guildId &&
    privateStreakNoticeGuildIds.has(guildId);
  if (!guildId || (!isGuildRecoveryMessage && !isPrivateRecoveryMessage)) {
    await interaction.reply({
      content: "رسالة استرداد الستريك هذه لم تعد متاحة.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await withMemberQueue(guildId, ownerId, async () => {
    const result = await pool.query<RecoveryStateRow>(
      `SELECT streak_days,
              last_post_date::text AS last_post_date,
              expired_streak_days,
              recovery_expires_at,
              recovery_message_id
       FROM discord_daily_post_streaks
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, ownerId],
    );
    const state = result.rows[0];
    if (
      !state ||
      state.recovery_message_id !== interaction.message.id ||
      state.expired_streak_days < 1 ||
      !state.recovery_expires_at ||
      state.recovery_expires_at.getTime() <= Date.now()
    ) {
      await interaction.editReply(
        "انتهت مهلة الاسترداد أو تم استخدام هذا الزر من قبل.",
      );
      return;
    }

    const activityDate = baghdadDateString(new Date());
    const restored = await pool.query<{ streak_days: number }>(
      `UPDATE discord_daily_post_streaks
       SET streak_days = expired_streak_days,
           last_post_date = $4::date,
           expired_streak_days = 0,
           expired_at = NULL,
           recovery_expires_at = NULL,
           recovery_message_id = NULL,
           updated_at = now()
       WHERE guild_id = $1
         AND user_id = $2
         AND recovery_message_id = $3
         AND expired_streak_days > 0
         AND recovery_expires_at > now()
       RETURNING streak_days`,
      [
        guildId,
        ownerId,
        interaction.message.id,
        activityDate,
      ],
    );
    const restoredDays = restored.rows[0]?.streak_days;
    if (!restoredDays) {
      await interaction.editReply(
        "تعذر تأكيد الاسترداد؛ ربما انتهت المهلة. حاول تحديث الستريك بالنشر.",
      );
      return;
    }

    try {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(ownerId);
      await assignDailyRole(guild, pool, member, restoredDays);
    } catch (error) {
      await pool.query(
        `UPDATE discord_daily_post_streaks
         SET streak_days = $4,
             last_post_date = $5::date,
             expired_streak_days = $6,
             expired_at = (($5::date + 2)::timestamp AT TIME ZONE 'Asia/Baghdad'),
             recovery_expires_at = $7,
             recovery_message_id = $3,
             updated_at = now()
         WHERE guild_id = $1
           AND user_id = $2
           AND recovery_message_id IS NULL
           AND expired_streak_days = 0`,
        [
          guildId,
          ownerId,
          interaction.message.id,
          state.streak_days,
          state.last_post_date,
          state.expired_streak_days,
          new Date(state.recovery_expires_at),
        ],
      );
      throw error;
    }

    await interaction.editReply(
      `تم استرداد ستريكك إلى **${restoredDays} 🔥**. تم تسجيل اليوم كتجديد؛ انشر غداً للمحافظة عليه.`,
    );
  });
}

async function removeMissedDayRoles(client: Client, pool: Pool) {
  if (cleanupRunning) return;
  cleanupRunning = true;

  try {
    const today = baghdadDateString(new Date());
    const cutoffDate = previousCalendarDate(today);
    const staleMembers = await pool.query<{
      guild_id: string;
      user_id: string;
    }>(
      `SELECT guild_id, user_id
       FROM discord_daily_post_streaks
       WHERE streak_days > 0
         AND last_post_date < $1::date`,
      [cutoffDate],
    );

    let removedCount = 0;
    for (const row of staleMembers.rows) {
      try {
        if (
          await clearStaleMemberRole(
            row.guild_id,
            row.user_id,
            cutoffDate,
            client,
            pool,
          )
        ) {
          removedCount += 1;
        }
      } catch (error) {
        logRoleFailure("daily_post_stale_role_cleanup_failed", error, {
          guildId: row.guild_id,
          userId: row.user_id,
        });
      }
    }

    if (removedCount > 0) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "daily_post_stale_roles_removed",
          timestamp: new Date().toISOString(),
          count: removedCount,
        }),
      );
    }
  } catch (error) {
    logRoleFailure("daily_post_streak_cleanup_failed", error, {});
  } finally {
    cleanupRunning = false;
  }
}

async function clearExpiredRecoveryWindows(pool: Pool) {
  await pool.query(
    `UPDATE discord_daily_post_streaks
     SET expired_streak_days = 0,
         expired_at = NULL,
         recovery_expires_at = NULL,
         recovery_message_id = NULL,
         updated_at = now()
     WHERE expired_streak_days > 0
       AND recovery_expires_at <= now()`,
  );
}

async function runStreakMaintenance(client: Client, pool: Pool) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await ensureBotAvailabilityInitialized(pool);
    await removeMissedDayRoles(client, pool);
    await clearExpiredRecoveryWindows(pool).catch((error: unknown) => {
      logRoleFailure("daily_streak_recovery_expiry_cleanup_failed", error, {});
    });
    await sendPendingRecoveryCards(client, pool).catch((error: unknown) => {
      logRoleFailure("daily_streak_pending_recovery_delivery_failed", error, {
        channelId: streakNoticeChannelId,
      });
    });

    const localTime = baghdadClock(new Date());
    if (localTime.hour === 21 && localTime.minute <= 1) {
      await sendStreakReminders(client, pool, localTime.date, "three_hours");
    } else if (localTime.hour === 23 && localTime.minute <= 1) {
      await sendStreakReminders(client, pool, localTime.date, "one_hour");
    }

    if (lastNoticePruneDate !== localTime.date) {
      await pool.query(
        `DELETE FROM discord_daily_post_notices
         WHERE notice_date < $1::date - 45`,
        [localTime.date],
      );
      lastNoticePruneDate = localTime.date;
    }
  } catch (error) {
    logRoleFailure("daily_streak_maintenance_failed", error, {
      channelId: streakNoticeChannelId,
    });
  } finally {
    maintenanceRunning = false;
  }
}

async function validateDailyRewardAccess(client: Client) {
  const channels = await Promise.all(
    [...rewardChannelIds, streakNoticeChannelId].map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        const guildId =
          channel &&
          "guildId" in channel &&
          typeof channel.guildId === "string"
            ? channel.guildId
            : null;
        return { channelId, guildId };
      } catch (error) {
        logRoleFailure("daily_post_reward_channel_check_failed", error, {
          channelId,
        });
        return { channelId, guildId: null };
      }
    }),
  );

  const guildIds = new Set<string>();
  rewardGuildIds.clear();
  for (const channel of channels) {
    if (channel.guildId) {
      guildIds.add(channel.guildId);
      if (channel.channelId !== streakNoticeChannelId) {
        rewardGuildIds.add(channel.guildId);
      }
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          event: "daily_post_reward_channel_unavailable",
          timestamp: new Date().toISOString(),
          channelId: channel.channelId,
        }),
      );
    }
  }

  for (const guildId of guildIds) {
    try {
      const guild =
        client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
      await getBotMemberWithRolePermission(guild);
      console.log(
        JSON.stringify({
          level: "info",
          event: "daily_post_reward_permissions_ready",
          timestamp: new Date().toISOString(),
          guildId,
          channelCount: channels.filter(
            (channel) => channel.guildId === guildId,
          ).length,
        }),
      );
    } catch (error) {
      logRoleFailure("daily_post_reward_permission_check_failed", error, {
        guildId,
      });
    }
  }

  try {
    const noticeChannel = await getStreakNoticeChannel(client);
    const guild = await client.guilds.fetch(noticeChannel.guildId);
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = noticeChannel.permissionsFor(botMember);
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ];
    if (
      !permissions ||
      requiredPermissions.some((permission) => !permissions.has(permission))
    ) {
      throw new Error(
        "The bot needs View Channel, Send Messages, Embed Links, and Attach Files in the streak-notice channel.",
      );
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "daily_streak_notice_permissions_ready",
        timestamp: new Date().toISOString(),
        guildId: guild.id,
        channelId: noticeChannel.id,
      }),
    );
  } catch (error) {
    logRoleFailure("daily_streak_notice_permission_check_failed", error, {
      channelId: streakNoticeChannelId,
    });
  }
}

export async function initializeDailyPostRewardTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_daily_post_streaks (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      streak_days integer NOT NULL DEFAULT 0,
      last_post_date date NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  await pool.query(`
    ALTER TABLE discord_daily_post_streaks
      ADD COLUMN IF NOT EXISTS expired_streak_days integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS expired_at timestamptz,
      ADD COLUMN IF NOT EXISTS recovery_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS recovery_message_id text
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_daily_post_roles (
      guild_id text NOT NULL,
      streak_days integer NOT NULL,
      role_id text NOT NULL,
      PRIMARY KEY (guild_id, streak_days)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_daily_post_notices (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      notice_date date NOT NULL,
      notice_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id, notice_date, notice_type)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_daily_post_bot_heartbeat (
      singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      last_seen_at timestamptz NOT NULL,
      first_fully_observed_date date NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_daily_post_bot_outage_days (
      outage_date date PRIMARY KEY
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_daily_post_streaks_last_post_date_idx
    ON discord_daily_post_streaks (last_post_date)
    WHERE streak_days > 0
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_daily_post_streaks_recovery_expiry_idx
    ON discord_daily_post_streaks (recovery_expires_at)
    WHERE expired_streak_days > 0
  `);
}

export function attachDailyPostRewards(client: Client, pool: Pool) {
  const onMessage = (message: Message) => {
    if (
      !rewardChannelIds.has(message.channelId) ||
      !message.guild ||
      message.author.bot ||
      message.webhookId
    ) {
      return;
    }

    void updateMemberDailyRole(client, message, pool).catch((error: unknown) => {
      logRoleFailure("daily_post_role_update_failed", error, {
        guildId: message.guildId ?? "unknown",
        userId: message.author.id,
        channelId: message.channelId,
      });
    });
  };

  const onReady = () => {
    if (cleanupTimer) return;
    void ensureBotAvailabilityInitialized(pool)
      .then(async () => {
        await validateDailyRewardAccess(client);
        await runStreakMaintenance(client, pool);
      })
      .catch((error: unknown) => {
        logRoleFailure("daily_streak_heartbeat_failed", error, {});
      });
    cleanupTimer = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void (async () => {
        try {
          await ensureBotAvailabilityInitialized(pool);
          await recordBotHeartbeat(pool);
          await runStreakMaintenance(client, pool);
        } catch (error) {
          logRoleFailure("daily_streak_heartbeat_failed", error, {});
        } finally {
          heartbeatRunning = false;
        }
      })();
    }, heartbeatIntervalMs);
    cleanupTimer.unref();
  };

  const onInteraction = (interaction: Interaction) => {
    if (
      !interaction.isButton() ||
      !interaction.customId.startsWith("streak:recover:")
    ) {
      return;
    }

    void handleStreakRecovery(client, pool, interaction).catch(
      async (error: unknown) => {
        logRoleFailure("daily_streak_recovery_failed", error, {
          channelId: interaction.channelId ?? "unknown",
          userId: interaction.user.id,
        });
        const response = {
          content: "تعذر استرداد الستريك الآن. حاول مرة أخرى بعد قليل.",
        };
        if (interaction.deferred) {
          await interaction.editReply(response).catch(() => null);
        } else if (interaction.replied) {
          await interaction.followUp({ ...response, ephemeral: true }).catch(() => null);
        } else {
          await interaction.reply({ ...response, ephemeral: true }).catch(() => null);
        }
      },
    );
  };

  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, onInteraction);
  client.once(Events.ClientReady, onReady);

  return () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.InteractionCreate, onInteraction);
    client.off(Events.ClientReady, onReady);
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  };
}