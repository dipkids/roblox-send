import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("order")
  .setDescription("Mulai order Robux");

export async function execute(
  interaction: ChatInputCommandInteraction,
) {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("robux_100")
      .setLabel("100 Robux")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("robux_300")
      .setLabel("300 Robux")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("robux_500")
      .setLabel("500 Robux")
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("robux_1000")
      .setLabel("1000 Robux")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("robux_3000")
      .setLabel("3000 Robux")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("custom_order")
      .setLabel("Custom Order")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content:
      "🛒 **AutoVisend — Robux Order**\n\n" +
      "Pilih jumlah Robux yang ingin kamu beli:",
    components: [row1, row2],
    flags: MessageFlags.Ephemeral,
  });
}