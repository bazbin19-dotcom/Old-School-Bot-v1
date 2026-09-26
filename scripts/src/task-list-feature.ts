import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Pool } from "pg";

export const taskListChannelId = "1546779645314203659";

const maxTaskCount = 25;
const maxTaskLength = 100;

type TaskItem = {
  id: string;
  text: string;
  done: boolean;
};

type TaskListRow = {
  message_id: string;
  source_message_id: string;
  guild_id: string;
  channel_id: string;
  owner_id: string;
  tasks: TaskItem[] | string;
  created_at: Date | string;
};

type TaskListContext = {
  list: TaskListRow & { tasks: TaskItem[] };
  message: Message;
};

const taskListQueues = new Map<string, Promise<void>>();

export async function initializeTaskListTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_task_lists (
      message_id text PRIMARY KEY,
      source_message_id text NOT NULL UNIQUE,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      owner_id text NOT NULL,
      tasks jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function parseTaskLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*•]\s*|(?:\d+|[٠-٩]+)[.)\-]\s*)/, "")
        .trim(),
    )
    .filter(Boolean);
}

function decodeTaskItems(value: TaskItem[] | string): TaskItem[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (task): task is TaskItem =>
      task !== null &&
      typeof task === "object" &&
      typeof task.id === "string" &&
      typeof task.text === "string" &&
      typeof task.done === "boolean",
  );
}

async function getTaskList(pool: Pool, messageId: string) {
  const result = await pool.query<TaskListRow>(
    `SELECT message_id, source_message_id, guild_id, channel_id, owner_id,
            tasks, created_at
     FROM discord_task_lists
     WHERE message_id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  return row ? { ...row, tasks: decodeTaskItems(row.tasks) } : null;
}

function relativeTime(createdAt: Date | string) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function buildTaskListContainer(
  list: TaskListRow & { tasks: TaskItem[] },
  includeControls = true,
) {
  const completed = list.tasks.filter((task) => task.done).length;
  const percent =
    list.tasks.length === 0
      ? 0
      : Math.round((completed / list.tasks.length) * 100);
  const filledSegments = Math.round((percent / 100) * 12);
  const progressBar =
    "▰".repeat(filledSegments) + "▱".repeat(12 - filledSegments);
  const taskText =
    list.tasks.length > 0
      ? list.tasks
          .map(
            (task, index) =>
              `${task.done ? "✅" : "⬜"} ${index + 1}. ${
                task.done ? `~~${task.text}~~` : task.text
              }`,
          )
          .join("\n\n")
      : "لا توجد مهام حالياً. أضف مهمة جديدة من الزر أدناه.";

  const container = new ContainerBuilder()
    .setAccentColor(0x7136a8)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📋 قائمة مهام <@${list.owner_id}>\n\n**التقدم:** ${progressBar} **${percent}%** — ${completed}/${list.tasks.length} مهمة مكتملة`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(taskText));

  if (includeControls && list.tasks.length > 0) {
    const taskMenu = new StringSelectMenuBuilder()
      .setCustomId(`tasklist:toggle:${list.message_id}`)
      .setPlaceholder("اختر مهمة لتحديث حالتها")
      .addOptions(
        list.tasks.map((task, index) => ({
          label: `${task.done ? "✅" : "⬜"} ${index + 1}. ${task.text}`.slice(
            0,
            100,
          ),
          value: task.id,
        })),
      );
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(taskMenu),
    );
  }

  if (includeControls) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`tasklist:add:${list.message_id}`)
          .setLabel("إضافة مهمة")
          .setEmoji("➕")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`tasklist:manage:${list.message_id}`)
          .setLabel("تعديل / حذف")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  container
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🤖 تم إنشاء هذه القائمة بواسطة البوت • ${relativeTime(list.created_at)}`,
      ),
    );

  return container;
}

function makeTaskModal(
  action: "add" | "edit",
  messageId: string,
  taskId?: string,
) {
  const input = new TextInputBuilder()
    .setCustomId("task_text")
    .setLabel("نص المهمة")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(maxTaskLength);
  return new ModalBuilder()
    .setCustomId(
      action === "add"
        ? `tasklist:add_submit:${messageId}`
        : `tasklist:edit_submit:${messageId}:${taskId}`,
    )
    .setTitle(action === "add" ? "إضافة مهمة" : "تعديل المهمة")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function makeManageMenu(list: TaskListRow & { tasks: TaskItem[] }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tasklist:manage_select:${list.message_id}`)
    .setPlaceholder("اختر المهمة التي تريد تعديلها أو حذفها")
    .addOptions(
      list.tasks.map((task, index) => ({
        label: `${index + 1}. ${task.text}`.slice(0, 100),
        value: task.id,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function logTaskListError(event: string, error: unknown) {
  const info =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown })
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      errorName: typeof info.name === "string" ? info.name : "Error",
      ...(info.code !== undefined ? { errorCode: String(info.code) } : {}),
    })}\n`,
  );
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

async function loadOwnedTaskList(
  client: Client,
  pool: Pool,
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  messageId: string,
): Promise<TaskListContext | null> {
  if (
    interaction.channelId !== taskListChannelId ||
    !interaction.guildId
  ) {
    return null;
  }
  const list = await getTaskList(pool, messageId);
  if (
    !list ||
    list.guild_id !== interaction.guildId ||
    list.channel_id !== taskListChannelId ||
    list.owner_id !== interaction.user.id
  ) {
    return null;
  }
  const channel = await client.channels.fetch(taskListChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message || message.author.id !== client.user?.id) return null;
  return { list, message };
}

async function withTaskListQueue<T>(
  messageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = taskListQueues.get(messageId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  taskListQueues.set(messageId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (taskListQueues.get(messageId) === current) {
      taskListQueues.delete(messageId);
    }
  }
}

async function mutateAndRefresh(
  pool: Pool,
  context: TaskListContext,
  mutate: (tasks: TaskItem[]) => TaskItem[],
) {
  const messageId = context.list.message_id;
  return withTaskListQueue(messageId, async () => {
    const latest = await getTaskList(pool, messageId);
    if (!latest) throw new Error("Task list no longer exists.");
    const nextTasks = mutate(latest.tasks);
    await pool.query(
      `UPDATE discord_task_lists
       SET tasks = $2::jsonb, updated_at = now()
       WHERE message_id = $1`,
      [messageId, JSON.stringify(nextTasks)],
    );
    try {
      await context.message.edit({
        components: [
          buildTaskListContainer({ ...latest, tasks: nextTasks }),
        ],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await pool.query(
        `UPDATE discord_task_lists
         SET tasks = $2::jsonb, updated_at = now()
         WHERE message_id = $1`,
        [messageId, JSON.stringify(latest.tasks)],
      );
      throw error;
    }
    return nextTasks;
  });
}

async function handleTaskListMessage(
  client: Client,
  pool: Pool,
  source: Message,
) {
  if (
    !source.inGuild() ||
    source.author.bot ||
    source.channelId !== taskListChannelId
  ) {
    return;
  }

  const taskLines = parseTaskLines(source.content);
  if (taskLines.length === 0) return;
  const invalidTaskLength = taskLines.some(
    (task) => Array.from(task).length > maxTaskLength,
  );
  if (taskLines.length > maxTaskCount || invalidTaskLength) {
    await source.reply({
      content:
        taskLines.length > maxTaskCount
          ? `يمكن إضافة ${maxTaskCount} مهمة كحد أقصى في القائمة الواحدة.`
          : `يجب ألا يتجاوز نص كل مهمة ${maxTaskLength} حرفاً.`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const tasks = taskLines.map((text) => ({
    id: randomUUID(),
    text,
    done: false,
  }));
  const channel = source.channel;
  if (channel.type !== ChannelType.GuildText) return;

  const placeholderList: TaskListRow & { tasks: TaskItem[] } = {
    message_id: "",
    source_message_id: source.id,
    guild_id: source.guildId,
    channel_id: source.channelId,
    owner_id: source.author.id,
    tasks,
    created_at: source.createdAt,
  };

  const botMessage = await channel.send({
    components: [buildTaskListContainer(placeholderList, false)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
  const list = { ...placeholderList, message_id: botMessage.id };

  let rowInserted = false;
  try {
    await pool.query(
      `INSERT INTO discord_task_lists
         (message_id, source_message_id, guild_id, channel_id, owner_id, tasks, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        botMessage.id,
        source.id,
        source.guildId,
        source.channelId,
        source.author.id,
        JSON.stringify(tasks),
        source.createdAt,
      ],
    );
    rowInserted = true;
    await botMessage.edit({
      components: [buildTaskListContainer(list)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (rowInserted) {
      await pool
        .query("DELETE FROM discord_task_lists WHERE message_id = $1", [
          botMessage.id,
        ])
        .catch(() => undefined);
    }
    await botMessage.delete().catch(() => undefined);
    throw error;
  }

  await source.delete().catch((error: unknown) => {
    logTaskListError("task_list_source_message_delete_failed", error);
  });
}

async function handleTaskListButton(
  client: Client,
  pool: Pool,
  interaction: ButtonInteraction,
) {
  const [prefix, action, messageId, taskId] = interaction.customId.split(":");
  if (prefix !== "tasklist" || !action || !messageId) return;
  const context = await loadOwnedTaskList(client, pool, interaction, messageId);
  if (!context) {
    await replyPrivately(interaction, "هذه القائمة غير متاحة لك أو لم تعد موجودة.");
    return;
  }

  if (action === "add" || action === "manage") {
    if (
      interaction.message.id !== messageId ||
      interaction.message.author.id !== client.user?.id
    ) {
      await replyPrivately(interaction, "هذا الخيار غير مرتبط بالقائمة المطلوبة.");
      return;
    }
    if (action === "add") {
      await interaction.showModal(makeTaskModal("add", messageId));
      return;
    }
    if (context.list.tasks.length === 0) {
      await replyPrivately(interaction, "أضف مهمة أولاً قبل تعديلها أو حذفها.");
      return;
    }
    await interaction.reply({
      content: "اختر المهمة التي تريد تعديلها أو حذفها:",
      components: [makeManageMenu(context.list)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "edit_task" && taskId) {
    if (!context.list.tasks.some((task) => task.id === taskId)) {
      await replyPrivately(interaction, "لم أجد هذه المهمة في القائمة.");
      return;
    }
    await interaction.showModal(makeTaskModal("edit", messageId, taskId));
    return;
  }

  if (action === "delete_task" && taskId) {
    const task = context.list.tasks.find((item) => item.id === taskId);
    if (!task) {
      await replyPrivately(interaction, "لم أجد هذه المهمة في القائمة.");
      return;
    }
    await interaction.update({
      content: `هل تريد حذف المهمة «${task.text}»؟`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`tasklist:confirm_delete:${messageId}:${taskId}`)
            .setLabel("نعم، احذفها")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`tasklist:cancel_delete:${messageId}`)
            .setLabel("إلغاء")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "cancel_delete") {
    await interaction.update({
      content: "تم إلغاء الحذف.",
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "confirm_delete" && taskId) {
    await interaction.deferUpdate();
    await mutateAndRefresh(pool, context, (tasks) =>
      tasks.filter((task) => task.id !== taskId),
    );
    await interaction.editReply({
      content: "تم حذف المهمة.",
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

async function handleTaskListSelect(
  client: Client,
  pool: Pool,
  interaction: StringSelectMenuInteraction,
) {
  const [prefix, action, messageId] = interaction.customId.split(":");
  if (prefix !== "tasklist" || !action || !messageId) return;
  const context = await loadOwnedTaskList(client, pool, interaction, messageId);
  if (!context) {
    await replyPrivately(interaction, "هذه القائمة غير متاحة لك أو لم تعد موجودة.");
    return;
  }
  const selectedTaskId = interaction.values[0];
  if (!selectedTaskId) {
    await replyPrivately(interaction, "اختر مهمة أولاً.");
    return;
  }

  if (action === "toggle") {
    if (
      interaction.message.id !== messageId ||
      interaction.message.author.id !== client.user?.id
    ) {
      await replyPrivately(interaction, "هذا الخيار غير مرتبط بالقائمة المطلوبة.");
      return;
    }
    if (!context.list.tasks.some((task) => task.id === selectedTaskId)) {
      await replyPrivately(interaction, "لم أجد هذه المهمة في القائمة.");
      return;
    }
    await interaction.deferUpdate();
    await mutateAndRefresh(pool, context, (tasks) =>
      tasks.map((task) =>
        task.id === selectedTaskId ? { ...task, done: !task.done } : task,
      ),
    );
    return;
  }

  if (action === "manage_select") {
    if (!context.list.tasks.some((task) => task.id === selectedTaskId)) {
      await replyPrivately(interaction, "لم أجد هذه المهمة في القائمة.");
      return;
    }
    await interaction.update({
      content: "اختر الإجراء:",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`tasklist:edit_task:${messageId}:${selectedTaskId}`)
            .setLabel("تعديل المهمة")
            .setEmoji("✏️")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`tasklist:delete_task:${messageId}:${selectedTaskId}`)
            .setLabel("حذف المهمة")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { parse: [] },
    });
  }
}

async function handleTaskListModal(
  client: Client,
  pool: Pool,
  interaction: ModalSubmitInteraction,
) {
  const [prefix, action, messageId, taskId] = interaction.customId.split(":");
  if (
    prefix !== "tasklist" ||
    !["add_submit", "edit_submit"].includes(action ?? "") ||
    !messageId
  ) {
    return;
  }
  const context = await loadOwnedTaskList(client, pool, interaction, messageId);
  if (!context) {
    await replyPrivately(interaction, "هذه القائمة غير متاحة لك أو لم تعد موجودة.");
    return;
  }
  const text = interaction.fields.getTextInputValue("task_text").trim();
  if (!text) {
    await replyPrivately(interaction, "اكتب نص المهمة قبل الحفظ.");
    return;
  }

  if (action === "add_submit") {
    if (context.list.tasks.length >= maxTaskCount) {
      await replyPrivately(
        interaction,
        `وصلت القائمة إلى الحد الأقصى وهو ${maxTaskCount} مهمة.`,
      );
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await mutateAndRefresh(pool, context, (tasks) => [
      ...tasks,
      { id: randomUUID(), text, done: false },
    ]);
    await interaction.editReply("تمت إضافة المهمة.");
    return;
  }

  if (!taskId || !context.list.tasks.some((task) => task.id === taskId)) {
    await replyPrivately(interaction, "لم أجد هذه المهمة في القائمة.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await mutateAndRefresh(pool, context, (tasks) =>
    tasks.map((task) => (task.id === taskId ? { ...task, text } : task)),
  );
  await interaction.editReply("تم تعديل المهمة.");
}

async function handleTaskListInteraction(
  client: Client,
  pool: Pool,
  interaction: Interaction,
) {
  try {
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("tasklist:")
    ) {
      await handleTaskListButton(client, pool, interaction);
    } else if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("tasklist:")
    ) {
      await handleTaskListSelect(client, pool, interaction);
    } else if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("tasklist:")
    ) {
      await handleTaskListModal(client, pool, interaction);
    }
  } catch (error) {
    logTaskListError("task_list_interaction_failed", error);
    if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit()
    ) {
      await replyPrivately(
        interaction,
        "تعذر تحديث القائمة حالياً. حاول مرة أخرى بعد قليل.",
      ).catch(() => undefined);
    }
  }
}

async function validateTaskListChannel(client: Client) {
  const channel = await client.channels.fetch(taskListChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("The configured task-list channel is unavailable.");
  }
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "task_list_channel_ready",
      timestamp: new Date().toISOString(),
      channelId: taskListChannelId,
    })}\n`,
  );
}

export function attachTaskListFeature(client: Client, pool: Pool) {
  const onMessage = (message: Message) => {
    void handleTaskListMessage(client, pool, message).catch((error: unknown) => {
      logTaskListError("task_list_message_failed", error);
      if (
        message.channelId === taskListChannelId &&
        !message.author.bot
      ) {
        void message
          .reply({
            content: "تعذر إنشاء قائمة المهام حالياً. بقيت رسالتك كما هي.",
            allowedMentions: { parse: [], repliedUser: false },
          })
          .catch(() => undefined);
      }
    });
  };
  const onInteraction = (interaction: Interaction) => {
    void handleTaskListInteraction(client, pool, interaction);
  };
  const onReady = () => {
    void validateTaskListChannel(client).catch((error: unknown) => {
      logTaskListError("task_list_channel_validation_failed", error);
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