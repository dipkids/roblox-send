import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonInteraction,
} from "discord.js";

export async function showCustomOrderModal(
  interaction: ButtonInteraction,
) {
  const modal = new ModalBuilder()
    .setCustomId("custom_order_modal")
    .setTitle("Custom Order Robux");

  const amountInput = new TextInputBuilder()
    .setCustomId("robux_amount")
    .setLabel("Jumlah Robux")
    .setPlaceholder("Contoh: 2500")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
    amountInput,
  );

  modal.addComponents(row);

  await interaction.showModal(modal);
}