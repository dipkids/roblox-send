import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalSubmitInteraction,
} from "discord.js";

export async function showRobloxConfirmation(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  profile: {
    id: number;
    username: string;
    displayName: string;
    avatarUrl: string;
  },
  amount: number,
  rate: number,
) {
  const embed = new EmbedBuilder()
    .setTitle("🔎 Roblox Profile Ditemukan")
    .setDescription(
      "Pastikan data Roblox dan jumlah Robux sudah benar.",
    )
    .addFields(
      {
        name: "Robux",
        value: `${amount.toLocaleString()} Robux`,
        inline: true,
      },
      {
        name: "Rate",
        value: `Rp${rate.toLocaleString("id-ID")} / Robux`,
        inline: true,
      },
      {
        name: "Harga",
        value: `Rp${(
          amount * rate
        ).toLocaleString("id-ID")}`,
        inline: true,
      },
      {
        name: "Username",
        value: profile.username,
        inline: true,
      },
      {
        name: "Display Name",
        value: profile.displayName,
        inline: true,
      },
      {
        name: "User ID",
        value: profile.id.toString(),
        inline: false,
      },
    );

  if (profile.avatarUrl) {
    embed.setThumbnail(profile.avatarUrl);
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `roblox_confirm_${profile.id}_${amount}`,
      )
      .setLabel("Ya, Benar")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("roblox_cancel")
      .setLabel("Batal")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({
    content: "Apakah profile Roblox ini benar?",
    embeds: [embed],
    components: [row],
  });
}