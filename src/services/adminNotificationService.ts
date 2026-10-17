import { Client, EmbedBuilder } from "discord.js";
import { prisma } from "../database/prisma.js";

// ======================================================
// CLIENT
// ======================================================

let discordClient: Client | null = null;

export function setNotificationClient(client: Client) {
  discordClient = client;
}

export function getNotificationClient(): Client | null {
  return discordClient;
}

export type AdminNotifyKind =
  | "SENDER_LIMIT"
  | "RECEIVER_LIMIT"
  | "MANUAL_REVIEW"
  | "HELP_REQUESTED"
  | "REFUND_REQUESTED";

// Kode error transfer yang berarti limit AKUN PENERIMA.
// Samakan dengan errorCode dari transfer Roblox asli nanti.
const RECEIVER_LIMIT_ERROR_CODES = ["RECEIVER_LIMIT", "MOCK_RECEIVER_LIMIT"];

export function kindFromErrorCode(
  errorCode?: string | null,
): AdminNotifyKind {
  return errorCode && RECEIVER_LIMIT_ERROR_CODES.includes(errorCode)
    ? "RECEIVER_LIMIT"
    : "MANUAL_REVIEW";
}

const TITLES: Record<AdminNotifyKind, string> = {
  SENDER_LIMIT: "🚨 Sender kehabisan limit",
  RECEIVER_LIMIT: "⚠️ Limit akun penerima",
  MANUAL_REVIEW: "🔎 Order butuh pemeriksaan manual",
  HELP_REQUESTED: "🙋 Customer meminta bantuan admin",
  REFUND_REQUESTED: "💸 Customer meminta refund",
};

const ACTIONS: Record<AdminNotifyKind, string> = {
  SENDER_LIMIT:
    "Tambahkan atau ganti akun sender (atau naikkan limitnya), lalu proses ulang order ini.",
  RECEIVER_LIMIT:
    "Minta customer menyalakan verifikasi 2 langkah di Roblox, lalu proses transfer setelah limit naik.",
  MANUAL_REVIEW:
    "Periksa detail lewat /admin_review, lalu putuskan: transfer manual atau refund.",
  HELP_REQUESTED:
    "Hubungi customer di ticket, lalu proses transfer manual atau refund.",
  REFUND_REQUESTED:
    "Lakukan refund manual ke tujuan di atas, lalu konfirmasi ke customer di ticket.",
};

// Tidak pernah melempar error: kegagalan notifikasi
// tidak boleh merusak alur order.
export async function notifyAdminOrder(params: {
  orderId: number;
  kind: AdminNotifyKind;
  detail?: string;
}): Promise<void> {
  try {
    const client = discordClient;

    if (!client) {
      console.warn("⚠️ Notification client belum diatur.");
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: params.orderId },
      include: { user: true, robloxProfile: true, ticket: true },
    });

    if (!order) return;

    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const alertChannelId = process.env.ADMIN_ALERT_CHANNEL_ID;
    const rolePing = adminRoleId ? `<@&${adminRoleId}> ` : "";
    const roles = adminRoleId ? [adminRoleId] : [];

    const send = async (
      channelId: string,
      options: {
        content: string;
        embeds?: EmbedBuilder[];
        users?: string[];
      },
    ) => {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isSendable()) {
        throw new Error(`Channel ${channelId} tidak bisa dikirimi pesan.`);
      }

      await channel.send({
        content: options.content,
        embeds: options.embeds,
        allowedMentions: { roles, users: options.users ?? [] },
      });
    };

    let sentTo: string | null = null;

    // Limit penerima → ticket, supaya customer ikut melihat instruksi
    if (
      (params.kind === "RECEIVER_LIMIT" || params.kind === "HELP_REQUESTED") &&
      order.ticket
    ) {
      try {
        const content =
          params.kind === "HELP_REQUESTED"
            ? `${rolePing}<@${order.user.discordUserId}>\n` +
              `🙋 **Customer meminta bantuan admin** untuk order **${order.orderNumber}**.\n` +
              "Admin akan memeriksa dan menghubungi kamu di sini."
            : `${rolePing}<@${order.user.discordUserId}>\n` +
              "⚠️ **Transfer Robux belum bisa diproses** karena limit akun penerima.\n\n" +
              "**Customer:** nyalakan verifikasi 2 langkah (2-Step Verification) di akun Roblox kamu agar limit naik, lalu kabari di ticket ini.\n" +
              "**Admin:** transfer diproses setelah limit naik.";

        await send(order.ticket.channelId, {
          content,
          users: [order.user.discordUserId],
        });

        sentTo = order.ticket.channelId;
      } catch (error) {
        console.error(
          "⚠️ Gagal kirim ke ticket, fallback ke channel admin:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Sender limit, review manual, atau fallback
    if (!sentTo) {
      if (!alertChannelId) {
        console.warn(
          "⚠️ ADMIN_ALERT_CHANNEL_ID belum diatur. Notifikasi admin tidak terkirim.",
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(TITLES[params.kind])
        .setColor(params.kind === "SENDER_LIMIT" ? 0xe74c3c : 0xf1c40f)
        .addFields(
          {
            name: "Order",
            value: `${order.orderNumber} · ID ${order.id}`,
          },
          {
            name: "Robux",
            value: order.robuxAmount.toLocaleString("id-ID"),
            inline: true,
          },
          {
            name: "Total",
            value: `Rp${order.totalAmount.toLocaleString("id-ID")}`,
            inline: true,
          },
          {
            name: "Penerima",
            value: order.robloxProfile.username,
            inline: true,
          },
        );

      if (params.detail) {
        embed.addFields({
          name: "Keterangan",
          value: params.detail.slice(0, 500),
        });
      }

      if (order.ticket) {
        embed.addFields({
          name: "Ticket",
          value: `<#${order.ticket.channelId}>`,
        });
      }

      embed.addFields({ name: "Tindakan", value: ACTIONS[params.kind] });

      await send(alertChannelId, {
        content: `${rolePing}Order **${order.orderNumber}** butuh tindakan admin.`,
        embeds: [embed],
      });

      sentTo = alertChannelId;
    }

    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "ADMIN_NOTIFIED",
        description: `Admin dinotifikasi (${params.kind}).`,
        metadata: { kind: params.kind, channelId: sentTo },
      },
    });
  } catch (error) {
    console.error(
      "❌ Gagal mengirim notifikasi admin:",
      error instanceof Error ? error.message : error,
    );
  }
}