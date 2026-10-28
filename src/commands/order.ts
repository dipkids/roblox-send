import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";

import {
  buildOrderPanel,
  getOrderPanelReference,
  saveOrderPanelReference,
} from "../services/orderPanelService.js";

export const data = new SlashCommandBuilder()
  .setName("order")
  .setDescription("Pasang / perbarui panel order Robux di channel");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { embed, components } = await buildOrderPanel();

  const channel = interaction.channel;
  if (channel && "send" in channel && interaction.inGuild()) {
    // Coba hapus panel order lama jika ada di channel yang sama untuk mencegah pesan dobel
    const oldRef = await getOrderPanelReference();
    if (oldRef && oldRef.channelId === channel.id) {
      try {
        const oldMsg = await (channel as TextChannel).messages
          .fetch(oldRef.messageId)
          .catch(() => null);
        if (oldMsg) {
          await oldMsg.delete().catch(() => {});
        }
      } catch {
        // Abaikan jika pesan lama sudah dihapus manual
      }
    }

    // Kirim pesan panel murni dari bot (tanpa header 'user used /order')
    const panelMessage = await (channel as TextChannel).send({
      embeds: [embed],
      components,
    });

    // Simpan referensi pesan & channel agar bisa di-update otomatis setiap ada pembelian & tiap 30 menit
    await saveOrderPanelReference(panelMessage.channelId, panelMessage.id);

    // Balas interaction secara ephemeral (hanya dilihat oleh yang menjalankan command)
    await interaction.reply({
      content:
        "✅ **Panel order Robux berhasil dipasang di channel ini.**\n" +
        "Pesan ditampilkan bersih murni dari bot tanpa nama kamu di atasnya.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Fallback jika tidak berada di text channel
  await interaction.reply({
    embeds: [embed],
    components,
  });
}
