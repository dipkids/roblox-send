import {
  ButtonInteraction,
  MessageFlags,
} from "discord.js";

export async function execute(
  interaction: ButtonInteraction,
) {
  const amount = interaction.customId.replace("robux_", "");

  await interaction.reply({
    content: `✅ Kamu memilih **${amount} Robux**.`,
    flags: MessageFlags.Ephemeral,
  });
}