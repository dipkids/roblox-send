import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export type AdminActionType = "retry" | "complete" | "cancel";

const CONFIG = {
  retry: {
    title: "Proses Ulang Order",
    label: "Alasan / catatan",
    placeholder:
      "Contoh: Customer sudah menyalakan 2-step verification, limit naik ke 5000/10000.",
  },
  complete: {
    title: "Tandai Selesai Manual",
    label: "Bukti pengiriman manual",
    placeholder: "Contoh: Dikirim manual dari akun X, ID transaksi Roblox ...",
  },
  cancel: {
    title: "Batalkan Order & Refund",
    label: "Alasan + tujuan refund",
    placeholder: "Contoh: Limit tidak naik. Refund ke DANA 08xx...",
  },
} as const;

export async function showAdminActionModal(
  interaction: ButtonInteraction,
  action: AdminActionType,
  orderId: number,
) {
  const config = CONFIG[action];

  const input = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel(config.label)
    .setPlaceholder(config.placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(500);

  const modal = new ModalBuilder()
    .setCustomId(`admin_action_${action}_${orderId}`)
    .setTitle(config.title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );

  await interaction.showModal(modal);
}