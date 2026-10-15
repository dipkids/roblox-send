import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

import {
  getManualReviewOrders,
} from "../services/adminOrderService.js";

export const data = new SlashCommandBuilder()
  .setName("admin_review")
  .setDescription(
    "Melihat order yang membutuhkan pemeriksaan admin",
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
) {
  const orders = await getManualReviewOrders();

  if (orders.length === 0) {
    await interaction.editReply({
      content:
        "✅ Tidak ada order yang sedang membutuhkan pemeriksaan manual.",
      embeds: [],
      components: [],
    });

    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🔎 AutoVisend — Manual Review")
    .setDescription(
      "Pilih order untuk melihat detail dan riwayat transfer.",
    )
    .setColor(0xF1C40F);

  for (const order of orders) {
    const latestTransfer = order.transfers[0];

    embed.addFields({
      name: `${order.orderNumber} · ID ${order.id}`,
      value: [
        `**Status:** ${order.status}`,
        `**Robux:** ${order.robuxAmount.toLocaleString("id-ID")}`,
        `**Total:** Rp${order.totalAmount.toLocaleString("id-ID")}`,
        `**Penerima:** ${order.robloxProfile.username}`,
        `**Transfer terakhir:** ${latestTransfer?.status ?? "Belum ada"}`,
        `**Percobaan:** ${latestTransfer?.attemptCount ?? 0}`,
      ].join("\n"),
    });
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < orders.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();

    for (const order of orders.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`admin_review_view_${order.id}`)
          .setLabel(`Periksa #${order.id}`)
          .setStyle(ButtonStyle.Primary),
      );
    }

    rows.push(row);
  }

  await interaction.editReply({
    content: "",
    embeds: [embed],
    components: rows,
  });
}