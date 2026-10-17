import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export async function showTransferCancelModal(
  interaction: ButtonInteraction,
  orderId: number,
) {
  const destination = new TextInputBuilder()
    .setCustomId("refund_destination")
    .setLabel("Tujuan refund (e-wallet / rekening)")
    .setPlaceholder("Contoh: DANA 08123456789 a.n. Nama")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(150);

  const reason = new TextInputBuilder()
    .setCustomId("cancel_reason")
    .setLabel("Alasan (opsional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300);

  const modal = new ModalBuilder()
    .setCustomId(`transfer_cancel_modal_${orderId}`)
    .setTitle("Cancel Order & Refund")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(destination),
      new ActionRowBuilder<TextInputBuilder>().addComponents(reason),
    );

  await interaction.showModal(modal);
}