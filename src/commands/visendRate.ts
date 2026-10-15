import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import {
  getRobuxRate,
  setRobuxRate,
} from "../services/rateService.js";

export const data = new SlashCommandBuilder()
  .setName("visend_rate")
  .setDescription("Mengatur rate harga Robux")
  .addIntegerOption((option) =>
    option
      .setName("rate")
      .setDescription("Rate harga per 1 Robux")
      .setRequired(false)
      .setMinValue(1),
  )
  .setDefaultMemberPermissions(
    PermissionFlagsBits.Administrator.toString(),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
) {
  // ==============================
  // CEK ADMIN
  // ==============================
  if (
    !interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator,
    )
  ) {
    await interaction.reply({
      content:
        "❌ Kamu tidak memiliki izin untuk mengubah rate.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  // ==============================
  // DEFER RESPONSE
  // ==============================
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  try {
    const rate = interaction.options.getInteger("rate");

    // ==============================
    // LIHAT RATE SAAT INI
    // ==============================
    if (rate === null) {
      const currentRate = await getRobuxRate();

      await interaction.editReply({
        content:
          "💰 **AutoVisend Rate**\n\n" +
          `Rate saat ini: **Rp${currentRate.toLocaleString(
            "id-ID",
          )} / Robux**\n\n` +
          `Contoh 100 Robux = **Rp${(
            currentRate * 100
          ).toLocaleString("id-ID")}**`,
      });

      return;
    }

    // ==============================
    // UPDATE RATE
    // ==============================
    const newRate = await setRobuxRate(rate);

    await interaction.editReply({
      content:
        "✅ **Rate berhasil diperbarui.**\n\n" +
        `Rate baru: **Rp${newRate.toLocaleString(
          "id-ID",
        )} / Robux**\n\n` +
        `100 Robux = **Rp${(
          newRate * 100
        ).toLocaleString("id-ID")}**\n` +
        `500 Robux = **Rp${(
          newRate * 500
        ).toLocaleString("id-ID")}**\n` +
        `1000 Robux = **Rp${(
          newRate * 1000
        ).toLocaleString("id-ID")}**`,
    });

  } catch (error) {
    console.error("Visend Rate Error:", error);

    await interaction.editReply({
      content:
        "❌ Terjadi kesalahan saat mengakses rate.\n" +
        "Silakan coba lagi.",
    });
  }
}