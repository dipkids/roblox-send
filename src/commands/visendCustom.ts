import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { setCustomOrderEnabled } from "../services/customOrderSettingService.js";
import { refreshOrderPanel } from "../services/orderPanelService.js";

export const data = new SlashCommandBuilder()
  .setName("visend_custom")
  .setDescription("Atur visibilitas tombol Custom Order di /order")
  .addStringOption((opt) =>
    opt
      .setName("status")
      .setDescription("Pilih status tampilan tombol Custom Order")
      .setRequired(true)
      .addChoices(
        { name: "Tampilkan (Show)", value: "show" },
        { name: "Sembunyikan (Hide)", value: "hide" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const choice = interaction.options.getString("status", true);
  const enabled = choice === "show";

  await setCustomOrderEnabled(enabled);

  // Perbarui panel order yang sudah terpasang di Discord secara otomatis
  refreshOrderPanel(interaction.client).catch(() => {});

  await interaction.reply({
    content: `✅ Tombol **Custom Order** pada menu \`/order\` sekarang telah di-**${enabled ? "Tampilkan (Show)" : "Sembunyikan (Hide)"}**. Panel Discord telah diperbarui.`,
    flags: MessageFlags.Ephemeral,
  });
}
