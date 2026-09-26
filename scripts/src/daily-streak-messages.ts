import { readFile } from "node:fs/promises";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
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

export async function sendStreakRenewedMessage(
  channel: TextChannel,
  userId: string,
  streakDays: number,
) {
  const image = await getAssetBuffer("renewed");
  const fileName = imageAssets.renewed.fileName;
  return channel.send({
    content: `<@${userId}> تم تجديد ستريكك إلى **${streakDays}** يوم.`,
    embeds: [
      new EmbedBuilder()
        .setColor(0xff7800)
        .setImage(`attachment://${fileName}`),
    ],
    files: [createAttachment("renewed", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}

export async function sendStreakReminderMessage(
  channel: TextChannel,
  userId: string,
  streakDays: number,
  kind: StreakReminderKind,
) {
  const image = await getAssetBuffer("reminder");
  const isThreeHours = kind === "three_hours";
  const title = isThreeHours ? "تذكير الستريك — بقيت ٣ ساعات" : "تذكير الستريك — بقيت ساعة";
  const description = isThreeHours
    ? `انشر اليوم قبل منتصف الليل للحفاظ على ستريكك الحالي (${streakDays} 🔥).`
    : `بقيت ساعة واحدة قبل منتصف الليل. انشر الآن حتى لا ينتهي ستريكك الحالي (${streakDays} 🔥).`;

  return channel.send({
    content: `<@${userId}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(0xff7800)
        .setTitle(title)
        .setDescription(description)
        .setImage(`attachment://${imageAssets.reminder.fileName}`),
    ],
    files: [createAttachment("reminder", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}

export async function sendExpiredStreakMessage(
  channel: TextChannel,
  userId: string,
  streakDays: number,
  recoveryDeadline: Date,
): Promise<Message> {
  const image = await getAssetBuffer("expired");
  const fileName = imageAssets.expired.fileName;
  const formattedDeadline = deadlineFormatter.format(recoveryDeadline);
  const recoveryButton = new ButtonBuilder()
    .setCustomId(`streak:recover:${userId}`)
    .setEmoji("🔥")
    .setLabel("استرداد الستريك")
    .setStyle(ButtonStyle.Primary);
  const firstPanel = new ContainerBuilder()
    .setAccentColor(0x91999f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## انتهى ستريكك\n<@${userId}> انتهت سلسلة النشر اليومية الخاصة بك.`,
      ),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems({
        media: { url: `attachment://${fileName}` },
      }),
    );
  const recoveryPanel = new ContainerBuilder()
    .setAccentColor(0x91999f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### لديك فرصة للاسترداد\nيمكنك استعادة **${streakDays} 🔥** خلال يومين، حتى **${formattedDeadline}** بتوقيت بغداد. بعد انتهاء المهلة، ستبدأ من ١ عند نشرك التالي.`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton),
    );

  return channel.send({
    components: [
      firstPanel,
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
      recoveryPanel,
    ],
    flags: MessageFlags.IsComponentsV2,
    files: [createAttachment("expired", image)],
    allowedMentions: { users: [userId], parse: [] },
  });
}