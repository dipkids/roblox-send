import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export async function showRobloxProfileModal(
  interaction: ButtonInteraction,
  amount: number,
) {
  const modal = new ModalBuilder()
    .setCustomId(`roblox_profile_modal_${amount}`)
    .setTitle("Roblox Profile");

  const usernameInput = new TextInputBuilder()
    .setCustomId("roblox_username")
    .setLabel("Roblox Username")
    .setPlaceholder("Contoh: Builderman")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(20);

  const displayNameInput = new TextInputBuilder()
    .setCustomId("roblox_display_name")
    .setLabel("Roblox Display Username")
    .setPlaceholder("Contoh: Builderman")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(20);

  const usernameRow =
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      usernameInput,
    );

  const displayNameRow =
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      displayNameInput,
    );

  modal.addComponents(
    usernameRow,
    displayNameRow,
  );

  await interaction.showModal(modal);
}