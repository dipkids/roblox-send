import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

import {
  AdminReviewFilter,
  getManualReviewOrders,
} from "../services/adminOrderService.js";

export const data = new SlashCommandBuilder()
  .setName("admin_review")
  .setDescription("Melihat order yang membutuhkan pemeriksaan admin")
  .addStringOption((option) =>
    option
      .setName("filter")
      .setDescription("Pilih status order yang ingin dilihat")
      .setRequired(false)
      .addChoices(
        {
          name: "Perlu Tindakan Admin (Gagal Transfer/Limit) [Default]",
          value: "review",
        },
        {
          name: "Belum Dibayar (Pending/Unpaid QRIS)",
          value: "unpaid",
        },
        {
          name: "Semua Order Terbaru",
          value: "all",
        },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const filter =
    (interaction.options.getString("filter") as AdminReviewFilter) || "review";

  const orders = await getManualReviewOrders(filter);

  let title = "🔎 AutoVisend — Manual Review";
  let emptyMsg = "✅ Tidak ada order yang sedang membutuhkan pemeriksaan manual.";

  if (filter === "unpaid") {
    title = "⏳ AutoVisend — Order Belum Dibayar (Pending)";
    emptyMsg = "✅ Tidak ada order yang sedang menunggu pembayaran.";
  } else if (filter === "all") {
    title = "📋 AutoVisend — Semua Order Terbaru";
    emptyMsg = "Belum ada riwayat order di database.";
  }

  if (orders.length === 0) {
    await interaction.editReply({
      content: emptyMsg,
      embeds: [],
      components: [],
    });

    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription("Pilih order untuk melihat detail atau mengambil tindakan.")
    .setColor(filter === "unpaid" ? 0x3498db : 0xf1c40f);

  for (const order of orders) {
    const latestTransfer = order.transfers[0];

    embed.addFields({
      name: `${order.orderNumber} · ID ${order.id}`,
      value: [
        `**Status:** \`${order.status}\``,
        `**Buyer:** <@${order.user.discordUserId}> (${order.user.discordUsername ?? "Unknown"})`,
        `**Robux:** ${order.robuxAmount.toLocaleString("id-ID")}`,
        `**Total:** Rp${order.totalAmount.toLocaleString("id-ID")}`,
        `**Penerima:** ${order.robloxProfile.username}`,
        `**Transfer terakhir:** ${latestTransfer?.status ?? "Belum ada"}`,
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
