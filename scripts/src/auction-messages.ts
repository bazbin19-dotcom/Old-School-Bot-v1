import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  escapeMarkdown,
} from "discord.js";
import {
  formatAuctionAmount,
  formatAuctionDuration,
} from "./auction-parsing.js";

export type AuctionPanelValues = {
  status: "setup" | "active" | "completed" | "cancelled";
  duration_ms: string | null;
  starting_price: string | null;
  item_name: string | null;
  current_bid: string | null;
  highest_bidder_id: string | null;
  ends_at: Date | null;
};

export function makeAuctionSetupPanel(
  auctionId: string,
  auction: AuctionPanelValues,
) {
  const isEditable = auction.status === "setup";
  const statusMessage =
    auction.status === "setup"
      ? "لن يبدأ العدّ التنازلي حتى تكتمل الحقول الثلاثة. عند اكتمالها يبدأ المزاد تلقائياً."
      : auction.status === "active"
        ? `بدأ المزاد. المزايدة الحالية: **${formatAuctionAmount(auction.current_bid)}**`
        : auction.status === "completed"
          ? "انتهى هذا المزاد."
          : "انتهت صلاحية إعداد هذا المزاد.";
  const itemName = auction.item_name
    ? escapeMarkdown(auction.item_name)
    : "لم يُحدد بعد";
  const fields = [
    `**المدة:** ${formatAuctionDuration(auction.duration_ms)}`,
    `**سعر البدء:** ${formatAuctionAmount(auction.starting_price)}`,
    `**العنصر:** ${itemName}`,
  ].join("\n");

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`auction:field:duration:${auctionId}`)
      .setLabel("المدة")
      .setEmoji("⏱️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isEditable),
    new ButtonBuilder()
      .setCustomId(`auction:field:price:${auctionId}`)
      .setLabel("سعر البدء")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isEditable),
    new ButtonBuilder()
      .setCustomId(`auction:field:item:${auctionId}`)
      .setLabel("العنصر")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isEditable),
  );

  return new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 🔨 إعداد المزاد",
          "استخدم الأزرار أدناه لتحديد مدة المزاد وسعر البدء والعنصر.",
          "هذه المحادثة في خيط خاص؛ قد يراه مشرفو السيرفر.",
          statusMessage,
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### تفاصيل المزاد\n${fields}`),
    )
    .addActionRowComponents(buttons);
}

export function makeAuctionStartedEmbed(auction: {
  item_name: string;
  starting_price: string;
  ends_at: Date;
}) {
  const endsAtSeconds = Math.floor(auction.ends_at.getTime() / 1_000);
  return new EmbedBuilder()
    .setColor(0x57a663)
    .setTitle("🔔 بدأ المزاد")
    .setDescription(`**العنصر:** ${escapeMarkdown(auction.item_name)}`)
    .addFields(
      {
        name: "سعر البدء",
        value: formatAuctionAmount(auction.starting_price),
        inline: true,
      },
      {
        name: "ينتهي",
        value: `<t:${endsAtSeconds}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: "للمزايدة، أرسل رقماً أعلى من سعر البدء في هذه القناة." });
}

export function makeAuctionResultEmbed(auction: {
  item_name: string;
  starting_price: string;
  current_bid: string | null;
  highest_bidder_id: string | null;
  completed_at: Date | null;
}) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🏁 انتهى المزاد")
    .setDescription(`**العنصر:** ${escapeMarkdown(auction.item_name)}`)
    .addFields({
      name: "سعر البدء",
      value: formatAuctionAmount(auction.starting_price),
      inline: true,
    });

  if (auction.current_bid && auction.highest_bidder_id) {
    embed.addFields(
      {
        name: "السعر النهائي",
        value: formatAuctionAmount(auction.current_bid),
        inline: true,
      },
      {
        name: "الفائز",
        value: `<@${auction.highest_bidder_id}>`,
        inline: true,
      },
    );
  } else {
    embed.addFields({
      name: "النتيجة",
      value: "لم تُسجل أي مزايدة صالحة؛ لا يوجد فائز.",
    });
  }

  if (auction.completed_at) embed.setTimestamp(auction.completed_at);
  return embed;
}

export function makeAuctionNoticeEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(title)
    .setDescription(description);
}