import type { Pool } from "pg";

export const profileImagePostChannelId = "1546491043334201374";
export const profileDefaultBackground = "#39393d";
export const profileXpPerPost = 100;

export type ProfileSettings = {
  display_name: string | null;
  background_color: string;
  following_private: boolean;
};

export type ProfilePostRow = {
  message_id: string;
  images: string[] | string;
  like_count: number;
};

export type ProfileListKind = "following" | "followers";

export async function initializeProfileTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_profile_settings (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      display_name text,
      background_color text NOT NULL DEFAULT '${profileDefaultBackground}',
      following_private boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id),
      CHECK (background_color ~ '^#[0-9A-Fa-f]{6}$')
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_profile_follows (
      guild_id text NOT NULL,
      follower_id text NOT NULL,
      followed_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, follower_id, followed_id),
      CHECK (follower_id <> followed_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_profile_xp_awards (
      guild_id text NOT NULL,
      message_id text NOT NULL,
      user_id text NOT NULL,
      xp_amount integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, message_id),
      CHECK (xp_amount > 0)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_profile_follows_followed_idx
    ON discord_profile_follows (guild_id, followed_id, created_at DESC)
  `);
}

export async function backfillProfileXpAwards(
  pool: Pool,
  guildId: string,
  userId: string,
) {
  await pool.query(
    `INSERT INTO discord_profile_xp_awards
       (guild_id, message_id, user_id, xp_amount, created_at)
     SELECT $1, p.message_id, p.author_id, $4, p.created_at
     FROM discord_image_posts p
     WHERE p.author_id = $2 AND p.channel_id = $3
     ON CONFLICT (guild_id, message_id) DO NOTHING`,
    [guildId, userId, profileImagePostChannelId, profileXpPerPost],
  );
}

export async function getProfileXp(
  pool: Pool,
  guildId: string,
  userId: string,
) {
  const result = await pool.query<{ total_xp: number }>(
    `SELECT COALESCE(SUM(xp_amount), 0)::int AS total_xp
     FROM discord_profile_xp_awards
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return result.rows[0]?.total_xp ?? 0;
}

export async function getProfileSettings(
  pool: Pool,
  guildId: string,
  userId: string,
): Promise<ProfileSettings> {
  const result = await pool.query<ProfileSettings>(
    `SELECT display_name, background_color, following_private
     FROM discord_profile_settings
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return (
    result.rows[0] ?? {
      display_name: null,
      background_color: profileDefaultBackground,
      following_private: false,
    }
  );
}

export async function getProfileCounts(
  pool: Pool,
  guildId: string,
  userId: string,
) {
  const [postResult, socialResult] = await Promise.all([
    pool.query<{ total_posts: number }>(
      `SELECT COUNT(*)::int AS total_posts
       FROM discord_image_posts
       WHERE author_id = $1 AND channel_id = $2`,
      [userId, profileImagePostChannelId],
    ),
    pool.query<{
      following_count: number;
      follower_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int
          FROM discord_profile_follows
          WHERE guild_id = $1 AND follower_id = $2) AS following_count,
         (SELECT COUNT(*)::int
          FROM discord_profile_follows
          WHERE guild_id = $1 AND followed_id = $2) AS follower_count`,
      [guildId, userId],
    ),
  ]);

  return {
    totalPosts: postResult.rows[0]?.total_posts ?? 0,
    followingCount: socialResult.rows[0]?.following_count ?? 0,
    followerCount: socialResult.rows[0]?.follower_count ?? 0,
  };
}

export async function getProfilePostPage(
  pool: Pool,
  userId: string,
  page: number,
  pageSize: number,
) {
  return pool.query<ProfilePostRow>(
    `SELECT p.message_id,
            p.images,
            COUNT(l.user_id)::int AS like_count
     FROM discord_image_posts p
     LEFT JOIN discord_image_post_likes l ON l.message_id = p.message_id
     WHERE p.author_id = $1 AND p.channel_id = $2
     GROUP BY p.message_id
     ORDER BY MAX(p.created_at) DESC
     LIMIT $3 OFFSET $4`,
    [userId, profileImagePostChannelId, pageSize, page * pageSize],
  );
}

export async function toggleProfileFollow(
  pool: Pool,
  guildId: string,
  followerId: string,
  followedId: string,
) {
  const removed = await pool.query(
    `DELETE FROM discord_profile_follows
     WHERE guild_id = $1 AND follower_id = $2 AND followed_id = $3`,
    [guildId, followerId, followedId],
  );
  if ((removed.rowCount ?? 0) > 0) return false;

  await pool.query(
    `INSERT INTO discord_profile_follows (guild_id, follower_id, followed_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, follower_id, followed_id) DO NOTHING`,
    [guildId, followerId, followedId],
  );
  return true;
}

export async function getProfileUserList(
  pool: Pool,
  guildId: string,
  userId: string,
  kind: ProfileListKind,
) {
  const column = kind === "following" ? "follower_id" : "followed_id";
  const selectedColumn = kind === "following" ? "followed_id" : "follower_id";
  const result = await pool.query<{ user_id: string; total_count: number }>(
    `SELECT ${selectedColumn} AS user_id,
            COUNT(*) OVER()::int AS total_count
     FROM discord_profile_follows
     WHERE guild_id = $1 AND ${column} = $2
     ORDER BY created_at DESC
     LIMIT 20`,
    [guildId, userId],
  );
  return {
    userIds: result.rows.map((row) => row.user_id),
    totalCount: result.rows[0]?.total_count ?? 0,
  };
}

export async function setProfileFollowingPrivacy(
  pool: Pool,
  guildId: string,
  userId: string,
  isPrivate: boolean,
) {
  await pool.query(
    `INSERT INTO discord_profile_settings
       (guild_id, user_id, following_private)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET following_private = EXCLUDED.following_private,
                   updated_at = now()`,
    [guildId, userId, isPrivate],
  );
}

export async function setProfileDisplayName(
  pool: Pool,
  guildId: string,
  userId: string,
  displayName: string | null,
) {
  await pool.query(
    `INSERT INTO discord_profile_settings
       (guild_id, user_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   updated_at = now()`,
    [guildId, userId, displayName],
  );
}

export async function setProfileBackgroundColor(
  pool: Pool,
  guildId: string,
  userId: string,
  backgroundColor: string,
) {
  await pool.query(
    `INSERT INTO discord_profile_settings
       (guild_id, user_id, background_color)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET background_color = EXCLUDED.background_color,
                   updated_at = now()`,
    [guildId, userId, backgroundColor],
  );
}