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
  sessionId: string,
) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`auction:field:duration:${auctionId}:${sessionId}`)
      .setLabel("المدة")
      .setEmoji("⏱️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`auction:field:price:${auctionId}:${sessionId}`)
      .setLabel("سعر البدء")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`auction:field:item:${auctionId}:${sessionId}`)
      .setLabel("العنصر")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Secondary),
  );

  return new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 🔨 إعداد المزاد",
          "هذه اللوحة مرئية لك وحدك.",
          "أدخل المدة وسعر البدء والعنصر عبر الأزرار أدناه. يبدأ المزاد تلقائياً بعد حفظ الحقول الثلاثة.",
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "### إعداد المزاد\nيمكنك حفظ الحقول بأي ترتيب. ستظهر رسالة عامة عند بدء المزاد.",
      ),
    )
    .addActionRowComponents(buttons);
}

export function makeAuctionOpenButton(auctionId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`auction:open:${auctionId}`)
      .setLabel("إعداد المزاد")
      .setEmoji("🔨")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

export function makeAuctionBidButton(auctionId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`auction:bid:${auctionId}`)
      .setLabel("قدّم مزايدة")
      .setEmoji("💸")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
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
    .setFooter({ text: "اضغط «قدّم مزايدة» وأدخل مبلغك؛ ستظهر المزايدات المقبولة في القناة." });
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