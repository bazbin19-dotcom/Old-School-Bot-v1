import {
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
} from "discord.js";
import type { Pool } from "pg";

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
]);

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Baghdad",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const memberQueues = new Map<string, Promise<void>>();
const roleCreationPromises = new Map<string, Promise<Role>>();
let cleanupTimer: NodeJS.Timeout | undefined;
let cleanupRunning = false;

type DailyStreakRow = {
  streak_days: number;
  last_post_date: string;
};

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

async function updateMemberDailyRole(message: Message, pool: Pool) {
  const guild = message.guild;
  if (!guild) return;

  await withMemberQueue(guild.id, message.author.id, async () => {
    const botMember = await getBotMemberWithRolePermission(guild);
    const activityDate = baghdadDateString(message.createdAt);
    const streakResult = await pool.query<DailyStreakRow>(
      `INSERT INTO discord_daily_post_streaks
         (guild_id, user_id, streak_days, last_post_date)
       VALUES ($1, $2, 1, $3::date)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         streak_days = CASE
           WHEN discord_daily_post_streaks.last_post_date = EXCLUDED.last_post_date
             THEN GREATEST(discord_daily_post_streaks.streak_days, 1)
           WHEN discord_daily_post_streaks.last_post_date = EXCLUDED.last_post_date - 1
             THEN discord_daily_post_streaks.streak_days + 1
           WHEN discord_daily_post_streaks.last_post_date < EXCLUDED.last_post_date
             THEN 1
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

    const rewardRole = await getDailyRole(guild, pool, botMember, streakDays);
    let member = message.member;
    if (!member) member = await guild.members.fetch(message.author.id);

    const alreadyHasReward = member.roles.cache.has(rewardRole.id);
    if (!alreadyHasReward) {
      member = await member.roles.add(
        rewardRole,
        "Posted in a daily-reward channel",
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
          roleId !== rewardRole.id && member.roles.cache.has(roleId),
      );
    if (previousRoleIds.length > 0) {
      await member.roles.remove(
        previousRoleIds,
        "Replace the previous daily posting streak role",
      );
    }

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
  });
}

async function clearStaleMemberRole(
  guildId: string,
  userId: string,
  cutoffDate: string,
  client: Client,
  pool: Pool,
) {
  return withMemberQueue(guildId, userId, async () => {
    const stillStale = await pool.query<{ streak_days: number }>(
      `SELECT streak_days
       FROM discord_daily_post_streaks
       WHERE guild_id = $1
         AND user_id = $2
         AND streak_days > 0
         AND last_post_date < $3::date`,
      [guildId, userId, cutoffDate],
    );
    if (!stillStale.rows[0]) return false;

    let guild: Guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (error) {
      if (!isDiscordErrorCode(error, 10004)) throw error;
      await markStreakInactive(pool, guildId, userId, cutoffDate);
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

    await markStreakInactive(pool, guildId, userId, cutoffDate);
    return true;
  });
}

async function markStreakInactive(
  pool: Pool,
  guildId: string,
  userId: string,
  cutoffDate: string,
) {
  await pool.query(
    `UPDATE discord_daily_post_streaks
     SET streak_days = 0, updated_at = now()
     WHERE guild_id = $1
       AND user_id = $2
       AND streak_days > 0
       AND last_post_date < $3::date`,
    [guildId, userId, cutoffDate],
  );
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

async function validateDailyRewardAccess(client: Client) {
  const channels = await Promise.all(
    [...rewardChannelIds].map(async (channelId) => {
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
  for (const channel of channels) {
    if (channel.guildId) {
      guildIds.add(channel.guildId);
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
    CREATE TABLE IF NOT EXISTS discord_daily_post_roles (
      guild_id text NOT NULL,
      streak_days integer NOT NULL,
      role_id text NOT NULL,
      PRIMARY KEY (guild_id, streak_days)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_daily_post_streaks_last_post_date_idx
    ON discord_daily_post_streaks (last_post_date)
    WHERE streak_days > 0
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

    void updateMemberDailyRole(message, pool).catch((error: unknown) => {
      logRoleFailure("daily_post_role_update_failed", error, {
        guildId: message.guildId ?? "unknown",
        userId: message.author.id,
        channelId: message.channelId,
      });
    });
  };

  const onReady = () => {
    if (cleanupTimer) return;
    void validateDailyRewardAccess(client);
    void removeMissedDayRoles(client, pool);
    cleanupTimer = setInterval(
      () => void removeMissedDayRoles(client, pool),
      60_000,
    );
    cleanupTimer.unref();
  };

  client.on(Events.MessageCreate, onMessage);
  client.once(Events.ClientReady, onReady);

  return () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.ClientReady, onReady);
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  };
}