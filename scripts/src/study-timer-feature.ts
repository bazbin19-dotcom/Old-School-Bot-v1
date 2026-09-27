import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ApplicationCommandType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  Events,
  MediaGalleryBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import { Pool as PgPool, type QueryResultRow } from "pg";
import { renderStudyTimerImage } from "./study-timer-image.js";
import {
  getStudyTimerTheme,
  studyTimerThemes,
  type StudyTimerThemeKey,
} from "./study-timer-themes.js";

const studyTimerCommandName = "start";
const timerRefreshIntervalMs = 30_000;
const timerRecoveryRetryMs = 5_000;
let registeredStudyTimerCommandId: string | null = null;

type TimerPhase = "study" | "break";

type StudyTimerRow = QueryResultRow & {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  creator_id: string;
  study_duration_ms: string;
  break_duration_ms: string;
  theme_key: string;
  phase: TimerPhase;
  study_ends_at: Date;
  phase_ends_at: Date;
};

type StudyTimerState = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  creatorId: string;
  studyDurationMs: number;
  breakDurationMs: number;
  themeKey: StudyTimerThemeKey;
  studyEndsAtMs: number;
  phase: TimerPhase;
  phaseEndsAtMs: number;
  timeout: NodeJS.Timeout | null;
  inFlight: boolean;
  cancelled: boolean;
  retryDelayMs: number;
};

const activeTimers = new Map<string, StudyTimerState>();

function logTimerInfo(event: string, details: Record<string, string> = {}) {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })}\n`,
  );
}

function logTimerError(
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
        ? {
            errorMessage: info.message
              .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[redacted connection]")
              .replace(/https?:\/\/\S+/gi, "[url]")
              .replace(/\b\d{17,20}\b/g, "[id]")
              .slice(0, 240),
          }
        : {}),
    })}\n`,
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

function isMissingDiscordResource(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === "10003" || code === "10008";
}

export function buildStudyTimerCommand() {
  return new SlashCommandBuilder()
    .setName(studyTimerCommandName)
    .setDescription("Start a study and break timer.")
    .addIntegerOption((option) =>
      option
        .setName("study_minutes")
        .setDescription("Study duration in minutes.")
        .setMinValue(1)
        .setMaxValue(1_440)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("break_minutes")
        .setDescription("Break duration in minutes.")
        .setMinValue(1)
        .setMaxValue(1_440)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("theme")
        .setDescription("Choose the timer theme.")
        .setRequired(true)
        .addChoices(
          ...studyTimerThemes.map((theme) => ({
            name: `${theme.icon} ${theme.name}`,
            value: theme.key,
          })),
        ),
    );
}

export function formatStudyTimerTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${totalMinutes}:${String(seconds).padStart(2, "0")}`;
}

export function buildStudyTimerContainer(
  state: {
    id: string;
    phase: TimerPhase;
    themeKey: StudyTimerThemeKey;
    phaseEndsAtMs: number;
  },
  fileName: string,
  nowMs: number,
) {
  const theme = getStudyTimerTheme(state.themeKey);
  if (!theme) throw new Error("The study timer theme is not supported.");

  const phaseLabel = state.phase === "study" ? "Study Time" : "Break Time";
  const phaseIcon = state.phase === "study" ? "📚" : "☕";
  const timeRemaining = formatStudyTimerTime(state.phaseEndsAtMs - nowMs);
  const altDescription = `${phaseLabel}: ${timeRemaining}. Theme: ${theme.icon} ${theme.name} theme.`;
  const information = [
    `**${phaseIcon} ${phaseLabel}**`,
    `⏱️ Time Remaining: **${timeRemaining}**`,
    `🎨 Theme: ${theme.icon} ${theme.name} theme`,
  ].join("\n");
  const stopButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`study-timer:stop:${state.id}`)
      .setLabel("Stop Timer")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger),
  );

  return new ContainerBuilder()
    .setAccentColor(0xc64b58)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems({
        media: { url: `attachment://${fileName}` },
        description: altDescription,
      }),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(information))
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(stopButton);
}

async function buildTimerCard(state: StudyTimerState, nowMs = Date.now()) {
  const timeRemaining = formatStudyTimerTime(state.phaseEndsAtMs - nowMs);
  const image = await renderStudyTimerImage(state.themeKey, timeRemaining);
  const fileName = `study-timer-${state.id}-${nowMs}.png`;
  return {
    components: [buildStudyTimerContainer(state, fileName, nowMs)],
    files: [new AttachmentBuilder(image, { name: fileName })],
    allowedMentions: { parse: [] as const },
  };
}

function stateFromRow(row: StudyTimerRow): StudyTimerState {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    creatorId: row.creator_id,
    studyDurationMs: Number(row.study_duration_ms),
    breakDurationMs: Number(row.break_duration_ms),
    themeKey: row.theme_key as StudyTimerThemeKey,
    studyEndsAtMs: row.study_ends_at.getTime(),
    phase: row.phase,
    phaseEndsAtMs: row.phase_ends_at.getTime(),
    timeout: null,
    inFlight: false,
    cancelled: false,
    retryDelayMs: 0,
  };
}

async function fetchTimerMessage(
  client: Client,
  state: StudyTimerState,
): Promise<Message> {
  const channel = await client.channels.fetch(state.channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("The study timer channel is no longer available.");
  }
  return channel.messages.fetch(state.messageId);
}

function clearTimerState(state: StudyTimerState) {
  state.cancelled = true;
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
  activeTimers.delete(state.id);
}

function scheduleTimerUpdate(
  client: Client,
  pool: PgPool,
  state: StudyTimerState,
) {
  if (state.cancelled || !activeTimers.has(state.id)) return;
  if (state.timeout) clearTimeout(state.timeout);

  const nowMs = Date.now();
  const startedAtMs = state.studyEndsAtMs - state.studyDurationMs;
  const nextUpdateAtMs =
    startedAtMs +
    (Math.floor((nowMs - startedAtMs) / timerRefreshIntervalMs) + 1) *
      timerRefreshIntervalMs;
  const nextDueAtMs = Math.min(nextUpdateAtMs, state.phaseEndsAtMs);
  const delay = Math.max(state.retryDelayMs, nextDueAtMs - nowMs, 0);
  state.retryDelayMs = 0;
  state.timeout = setTimeout(() => {
    state.timeout = null;
    void updateTimer(client, pool, state);
  }, delay);
  state.timeout.unref();
}

async function markTimerComplete(pool: PgPool, state: StudyTimerState) {
  await pool.query(
    `UPDATE discord_study_timers
     SET status = 'completed', completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [state.id],
  );
  clearTimerState(state);
}

async function updateTimer(
  client: Client,
  pool: PgPool,
  state: StudyTimerState,
) {
  if (state.cancelled || state.inFlight || !activeTimers.has(state.id)) return;
  state.inFlight = true;
  try {
    let nowMs = Date.now();
    if (state.phase === "study" && nowMs >= state.studyEndsAtMs) {
      const breakEndsAtMs = state.studyEndsAtMs + state.breakDurationMs;
      const transitioned = await pool.query(
        `UPDATE discord_study_timers
         SET phase = 'break', phase_ends_at = $2, updated_at = now()
         WHERE id = $1 AND status = 'running' AND phase = 'study'
         RETURNING id`,
        [state.id, new Date(breakEndsAtMs)],
      );
      if (!transitioned.rows[0]) {
        clearTimerState(state);
        return;
      }
      state.phase = "break";
      state.phaseEndsAtMs = breakEndsAtMs;
      nowMs = Date.now();
    }

    if (nowMs >= state.phaseEndsAtMs) {
      try {
        const message = await fetchTimerMessage(client, state);
        await message.delete();
      } catch (error) {
        if (!isUnknownDiscordMessage(error)) throw error;
      }
      await markTimerComplete(pool, state);
      logTimerInfo("study_timer_completed", { timerId: state.id });
      return;
    }

    const card = await buildTimerCard(state, nowMs);
    if (state.cancelled) return;
    const message = await fetchTimerMessage(client, state);
    if (state.cancelled) return;
    await message.edit({
      ...card,
      attachments: [],
    });
  } catch (error) {
    if (isMissingDiscordResource(error)) {
      try {
        await markTimerComplete(pool, state);
        logTimerInfo("study_timer_message_missing", { timerId: state.id });
        return;
      } catch (cleanupError) {
        logTimerError("study_timer_missing_message_cleanup_failed", cleanupError, {
          timerId: state.id,
        });
      }
    }
    state.retryDelayMs = timerRecoveryRetryMs;
    logTimerError("study_timer_update_failed", error, {
      timerId: state.id,
      phase: state.phase,
    });
  } finally {
    state.inFlight = false;
    scheduleTimerUpdate(client, pool, state);
  }
}

async function startTimer(
  interaction: ChatInputCommandInteraction,
  client: Client,
  pool: PgPool,
) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({
      content: "Use this command in a Discord server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const studyMinutes = interaction.options.getInteger("study_minutes", true);
  const breakMinutes = interaction.options.getInteger("break_minutes", true);
  const themeKey = interaction.options.getString("theme", true);
  const theme = getStudyTimerTheme(themeKey);
  if (!theme || studyMinutes < 1 || studyMinutes > 1_440 || breakMinutes < 1 || breakMinutes > 1_440) {
    await interaction.reply({
      content: "Choose durations from 1 to 1,440 minutes and a listed theme.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = randomUUID();
  const nowMs = Date.now();
  const studyDurationMs = studyMinutes * 60_000;
  const breakDurationMs = breakMinutes * 60_000;
  const state: StudyTimerState = {
    id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: "",
    creatorId: interaction.user.id,
    studyDurationMs,
    breakDurationMs,
    themeKey: theme.key,
    studyEndsAtMs: nowMs + studyDurationMs,
    phase: "study",
    phaseEndsAtMs: nowMs + studyDurationMs,
    timeout: null,
    inFlight: false,
    cancelled: false,
    retryDelayMs: 0,
  };

  const card = await buildTimerCard(state, nowMs);
  await interaction.reply({
    ...card,
    flags: MessageFlags.IsComponentsV2,
  });
  const timerMessage = await interaction.fetchReply();
  state.messageId = timerMessage.id;

  try {
    await pool.query(
      `INSERT INTO discord_study_timers
         (id, guild_id, channel_id, message_id, creator_id,
          study_duration_ms, break_duration_ms, theme_key, phase,
          study_ends_at, phase_ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'study', $9, $9, 'running')`,
      [
        state.id,
        state.guildId,
        state.channelId,
        state.messageId,
        state.creatorId,
        state.studyDurationMs,
        state.breakDurationMs,
        state.themeKey,
        new Date(state.studyEndsAtMs),
      ],
    );
  } catch (error) {
    await timerMessage.delete().catch(() => undefined);
    await interaction
      .followUp({
        content: "The timer could not be saved. Please try again.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    throw error;
  }

  activeTimers.set(state.id, state);
  scheduleTimerUpdate(client, pool, state);
  logTimerInfo("study_timer_started", {
    timerId: state.id,
    guildId: state.guildId,
    channelId: state.channelId,
    studyMinutes: String(studyMinutes),
    breakMinutes: String(breakMinutes),
    theme: state.themeKey,
  });
}

async function stopTimer(
  interaction: ButtonInteraction,
  client: Client,
  pool: PgPool,
  timerId: string,
) {
  let state = activeTimers.get(timerId);
  if (!state) {
    const result = await pool.query<StudyTimerRow>(
      `SELECT id, guild_id, channel_id, message_id, creator_id,
              study_duration_ms, break_duration_ms, theme_key, phase,
              study_ends_at, phase_ends_at
       FROM discord_study_timers
       WHERE id = $1 AND status = 'running'`,
      [timerId],
    );
    const row = result.rows[0];
    if (row) {
      state = stateFromRow(row);
      activeTimers.set(timerId, state);
      scheduleTimerUpdate(client, pool, state);
    }
  }

  if (!state) {
    await interaction.reply({
      content: "This timer is no longer active.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    interaction.channelId !== state.channelId ||
    interaction.message.id !== state.messageId
  ) {
    await interaction.reply({
      content: "This button is not attached to the active timer message.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== state.creatorId) {
    await interaction.reply({
      content: "Only the person who started this timer can stop it.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  const stopped = await pool.query(
    `UPDATE discord_study_timers
     SET status = 'stopped', completed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [timerId],
  );
  clearTimerState(state);
  try {
    await interaction.message.delete();
  } catch (error) {
    if (!isUnknownDiscordMessage(error)) throw error;
  }
  logTimerInfo(stopped.rows[0] ? "study_timer_stopped" : "study_timer_already_ended", {
    timerId,
    userId: interaction.user.id,
  });
}

async function handleStudyTimerInteraction(
  client: Client,
  pool: PgPool,
  interaction: Interaction,
) {
  try {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === studyTimerCommandName &&
      interaction.commandId === registeredStudyTimerCommandId
    ) {
      await startTimer(interaction, client, pool);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("study-timer:stop:")) {
      const timerId = interaction.customId.split(":")[2];
      if (!timerId) return;
      await stopTimer(interaction, client, pool, timerId);
    }
  } catch (error) {
    logTimerError("study_timer_interaction_failed", error, {
      interactionId: interaction.id,
      ...(interaction.isChatInputCommand()
        ? { commandName: interaction.commandName }
        : interaction.isButton()
          ? { action: interaction.customId.split(":")[1] ?? "unknown" }
          : {}),
    });
    if (interaction.isChatInputCommand() || interaction.isButton()) {
      const errorReply = {
        content: "The study timer could not complete that action.",
        flags: MessageFlags.Ephemeral as const,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(errorReply).catch(() => undefined);
      } else {
        await interaction.reply(errorReply).catch(() => undefined);
      }
    }
  }
}

async function registerStudyTimerCommand(client: Client<true>) {
  const commandData = buildStudyTimerCommand().toJSON();
  const commands = client.application.commands;
  const currentCommands = await commands.fetch();
  const existing = currentCommands.find(
    (command) =>
      command.name === studyTimerCommandName &&
      command.type === ApplicationCommandType.ChatInput,
  );

  if (existing && existing.description !== commandData.description) {
    logTimerError(
      "study_timer_command_conflict",
      new Error("A different global /start command already exists; it was left unchanged."),
      { commandId: existing.id },
    );
    return;
  }

  const registered = existing
    ? await commands.edit(existing.id, commandData)
    : await commands.create(commandData);
  registeredStudyTimerCommandId = registered.id;
  logTimerInfo("study_timer_command_registered", {
    commandId: registered.id,
    scope: "global",
  });
}

async function recoverActiveTimers(client: Client, pool: PgPool) {
  const active = await pool.query<StudyTimerRow>(
    `SELECT id, guild_id, channel_id, message_id, creator_id,
            study_duration_ms, break_duration_ms, theme_key, phase,
            study_ends_at, phase_ends_at
     FROM discord_study_timers
     WHERE status = 'running'
     ORDER BY created_at`,
  );

  for (const row of active.rows) {
    const theme = getStudyTimerTheme(row.theme_key);
    if (!theme) {
      await pool.query(
        `UPDATE discord_study_timers
         SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [row.id],
      );
      logTimerError(
        "study_timer_recovery_skipped",
        new Error("The saved timer theme is no longer supported."),
        { timerId: row.id },
      );
      continue;
    }

    const state = stateFromRow(row);
    activeTimers.set(state.id, state);
    try {
      await updateTimer(client, pool, state);
    } catch (error) {
      logTimerError("study_timer_recovery_failed", error, {
        timerId: state.id,
      });
    }
  }

  logTimerInfo("study_timer_recovery_complete", {
    activeCount: String(activeTimers.size),
  });
}

export async function initializeStudyTimerTables(pool: PgPool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_study_timers (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      message_id text NOT NULL UNIQUE,
      creator_id text NOT NULL,
      study_duration_ms bigint NOT NULL,
      break_duration_ms bigint NOT NULL,
      theme_key text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('study', 'break')),
      study_ends_at timestamptz NOT NULL,
      phase_ends_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'stopped', 'completed')),
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_study_timers_running_idx
      ON discord_study_timers (phase_ends_at)
      WHERE status = 'running'
  `);
}

export function attachStudyTimerFeature(client: Client, pool: PgPool) {
  const onInteraction = (interaction: Interaction) => {
    void handleStudyTimerInteraction(client, pool, interaction);
  };
  const onReady = (readyClient: Client<true>) => {
    void registerStudyTimerCommand(readyClient).catch((error: unknown) => {
      logTimerError("study_timer_command_registration_failed", error);
    });
    void recoverActiveTimers(client, pool).catch((error: unknown) => {
      logTimerError("study_timer_recovery_failed", error);
    });
  };

  client.on(Events.InteractionCreate, onInteraction);
  client.once(Events.ClientReady, onReady);

  return () => {
    client.off(Events.InteractionCreate, onInteraction);
    client.off(Events.ClientReady, onReady);
    for (const state of activeTimers.values()) {
      state.cancelled = true;
      if (state.timeout) clearTimeout(state.timeout);
    }
    activeTimers.clear();
  };
}