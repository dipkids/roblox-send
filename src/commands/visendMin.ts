import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";

import {
  getMinRobuxAmount,
  setMinRobuxAmount,
} from "../services/minOrderService.js";

export const data = new SlashCommandBuilder()
  .setName("visend_min")
  .setDescription("Mengatur batas minimal pembelian Robux (Admin Only)")
  .addIntegerOption((option) =>
    option
      .setName("amount")
      .setDescription("Jumlah minimal Robux per order (contoh: 10, 25, 100)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(5000),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  try {
    const amount = interaction.options.getInteger("amount");

    // Jika tidak memasukkan nominal, tampilkan nilai minimal saat ini
    if (amount === null) {
      const currentMin = await getMinRobuxAmount();

      await interaction.editReply({
        content:
          "⚙️ **AutoVisend — Pengaturan Minimal Pembelian**\n\n" +
          `Batas minimal pembelian saat ini: **${currentMin.toLocaleString(
            "id-ID",
          )} Robux**\n\n` +
          `Gunakan \`/visend_min amount:<angka>\` untuk mengubah batas minimal.`,
      });

      return;
    }

    // Update minimal pembelian
    const updatedMin = await setMinRobuxAmount(amount);

    console.log(
      `⚙️ Minimal pembelian Robux diubah oleh admin ${interaction.user.id}: ${updatedMin} Robux`,
    );

    await interaction.editReply({
      content:
        "✅ **Batas minimal pembelian berhasil diperbarui!**\n\n" +
        `Minimal order baru: **${updatedMin.toLocaleString(
          "id-ID",
        )} Robux**.\n` +
        `Pelanggan tidak dapat membuat pesanan di bawah nominal ini.`,
    });
  } catch (error) {
    console.error("Visend Min Error:", error);

    await interaction.editReply({
      content:
        "❌ Terjadi kesalahan saat mengatur batas minimal pembelian.\n" +
        (error instanceof Error ? error.message : "Silakan coba lagi."),
    });
  }
}
