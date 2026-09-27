import { readFile } from "node:fs/promises";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type DMChannel,
  type Message,
  type TextChannel,
} from "discord.js";

const imageAssets = {
  renewed: {
    fileName: "streak-fire-orange.png",
    url: new URL("../../attached_assets/IMG_5026_1790385475993.png", import.meta.url),
  },
  reminder: {
    fileName: "streak-fire-bell.png",
    url: new URL("../../attached_assets/IMG_5023_1790385475993.png", import.meta.url),
  },
  expired: {
    fileName: "streak-fire-grey.png",
    url: new URL("../../attached_assets/IMG_5025_1790385475993.png", import.meta.url),
  },
} as const;

type StreakReminderKind = "three_hours" | "one_hour";

const assetBuffers = new Map<keyof typeof imageAssets, Promise<Buffer>>();
const deadlineFormatter = new Intl.DateTimeFormat("ar-IQ", {
  timeZone: "Asia/Baghdad",
  dateStyle: "medium",
  timeStyle: "short",
});

function getAssetBuffer(kind: keyof typeof imageAssets) {
  let pending = assetBuffers.get(kind);
  if (!pending) {
    pending = readFile(imageAssets[kind].url);
    assetBuffers.set(kind, pending);
  }
  return pending;
}

function createAttachment(kind: keyof typeof imageAssets, buffer: Buffer) {
  return new AttachmentBuilder(buffer, { name: imageAssets[kind].fileName });
}

function createStreakPanel(
  title: string,
  accentColor: number,
  imageKind: keyof typeof imageAssets,
) {
  const fileName = imageAssets[imageKind].fileName;
  const header = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`),
    )
    .setThumbnailAccessory(
      new ThumbnailBuilder().setURL(`attachment://${fileName}`),
    );

  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addSectionComponents(header);
}

export async function sendStreakRenewedMessage(
  channel: TextChannel | DMChannel,
  userId: string,
  streakDays: number,
) {
  const image = await getAssetBuffer("renewed");
  const panel = createStreakPanel(
    "✅ • Streak updated",
    0x35c879,
    "renewed",
  )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `• <@${userId}>\n  ◦ 🔥 • **${streakDays}**`,
      ),
    );

  return channel.send({
    components: [panel],
    flags: MessageFlags.IsComponentsV2,
    files: [createAttachment("renewed", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}

export async function sendStreakReminderMessage(
  channel: TextChannel | DMChannel,
  userId: string,
  streakDays: number,
  kind: StreakReminderKind,
) {
  const image = await getAssetBuffer("reminder");
  const isThreeHours = kind === "three_hours";
  const remainingTime = isThreeHours
    ? "بقيت ٣ ساعات قبل منتصف الليل. انشر اليوم للحفاظ على ستريكك."
    : "بقيت ساعة واحدة قبل منتصف الليل. انشر الآن للحفاظ على ستريكك.";
  const panel = createStreakPanel(
    "🟠 • Streak Remember",
    0xffa726,
    "reminder",
  )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `• <@${userId}>\n  ◦ 🔥 • **${streakDays}**\n\n${remainingTime}`,
      ),
    );

  return channel.send({
    components: [panel],
    flags: MessageFlags.IsComponentsV2,
    files: [createAttachment("reminder", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}

export async function sendExpiredStreakMessage(
  channel: TextChannel | DMChannel,
  userId: string,
  streakDays: number,
  recoveryDeadline: Date,
): Promise<Message> {
  const image = await getAssetBuffer("expired");
  const formattedDeadline = deadlineFormatter.format(recoveryDeadline);
  const recoveryButton = new ButtonBuilder()
    .setCustomId(`streak:recover:${userId}`)
    .setEmoji("🔥")
    .setLabel("استرداد الستريك")
    .setStyle(ButtonStyle.Primary);
  const panel = createStreakPanel(
    "❌ • Streak failed",
    0xe5484d,
    "expired",
  )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `• <@${userId}>\n  ◦ Total (**${streakDays}**)`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### فرصة الاسترداد\nيمكنك استعادة **${streakDays} 🔥** خلال يومين، حتى **${formattedDeadline}** بتوقيت بغداد. بعد انتهاء المهلة، ستبدأ من ١ عند نشرك التالي.`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton),
    );

  return channel.send({
    components: [panel],
    flags: MessageFlags.IsComponentsV2,
    files: [createAttachment("expired", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}