import { Prisma } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import { prisma } from "../database/prisma.js";
import {
  getNotificationClient,
  kindFromErrorCode,
  notifyAdminOrder,
} from "./adminNotificationService.js";
import { releaseQuotaForOrder } from "./senderAdminService.js";
import { retryFailedTransfer } from "./transferRetryService.js";

const TX_OPTIONS = { maxWait: 30000, timeout: 30000 };

// Error yang pesannya aman ditampilkan ke customer.
export class CustomerFlowError extends Error {}

export type FailureOrigin = "AUTO" | "CUSTOMER" | "ADMIN";

interface TicketPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
  mentionUserId?: string;
}

interface PromptOrder {
  id: number;
  orderNumber: string;
  robuxAmount: number;
  robloxUsername: string;
  discordUserId: string;
}

// ======================================================
// PESAN KE TICKET
// ======================================================

async function sendToTicket(
  orderId: number,
  payload: TicketPayload,
): Promise<boolean> {
  try {
    const client = getNotificationClient();

    if (!client) return false;

    const ticket = await prisma.ticket.findUnique({ where: { orderId } });

    if (!ticket) return false;

    const channel = await client.channels.fetch(ticket.channelId);

    if (!channel || !channel.isSendable()) return false;

    await channel.send({
      content: payload.content,
      embeds: payload.embeds,
      components: payload.components,
      allowedMentions: {
        users: payload.mentionUserId ? [payload.mentionUserId] : [],
      },
    });

    return true;
  } catch (error) {
    console.error(
      "⚠️ Gagal mengirim pesan ke ticket:",
      error instanceof Error ? error.message : error,
    );

    return false;
  }
}

function orderFields(order: PromptOrder) {
  return [
    { name: "Order", value: `\`${order.orderNumber}\``, inline: false },
    {
      name: "Robux",
      value: order.robuxAmount.toLocaleString("id-ID"),
      inline: true,
    },
    { name: "Penerima", value: order.robloxUsername, inline: true },
  ];
}

// Embed pertama: limit akun, instruksi 2FA.
function stage1Prompt(order: PromptOrder): TicketPayload {
  const guide = process.env.TWO_FA_GUIDE_URL;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Pengiriman Robux Gagal")
    .setColor(0xf1c40f)
    .setDescription(
      "Robux belum bisa dikirim karena akun Roblox kamu **mencapai batas penerimaan transfer**.\n\n" +
        "Nyalakan **Verifikasi 2 Langkah (2-Step Verification)** di akun Roblox kamu, " +
        "lalu klik **2FA Nyala** di bawah." +
        (guide ? `\n\n🎬 [Tonton panduan menyalakan 2FA](${guide})` : ""),
    )
    .addFields(...orderFields(order));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`transfer_2fa_${order.id}`)
      .setLabel("2FA Nyala")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`transfer_cancel_${order.id}`)
      .setLabel("Cancel Order")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );

  return {
    content: `<@${order.discordUserId}>`,
    embeds: [embed],
    components: [row],
    mentionUserId: order.discordUserId,
  };
}

// Embed kedua: masih gagal setelah retry.
function stage2Prompt(order: PromptOrder): TicketPayload {
  const embed = new EmbedBuilder()
    .setTitle("❌ Pengiriman Masih Gagal")
    .setColor(0xe74c3c)
    .setDescription(
      "Kami sudah mencoba mengirim ulang, tetapi proses kirim masih gagal.\n\n" +
        "Kamu bisa meminta bantuan admin, atau membatalkan order " +
        "(dana akan dikembalikan secara manual).",
    )
    .addFields(...orderFields(order));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`transfer_help_${order.id}`)
      .setLabel("Minta Bantuan Admin")
      .setEmoji("🆘")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`transfer_cancel_${order.id}`)
      .setLabel("Cancel Order")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );

  return {
    content: `<@${order.discordUserId}>`,
    embeds: [embed],
    components: [row],
    mentionUserId: order.discordUserId,
  };
}

// ======================================================
// PINDAH KE MANUAL_REVIEW (idempotent)
// ======================================================

async function moveToManualReview(
  orderId: number,
  eventType: string,
  description: string,
  metadata: Prisma.InputJsonValue,
): Promise<boolean> {
  return prisma.$transaction(async (tx): Promise<boolean> => {
    const rows = await tx.$queryRaw<Array<{ id: number; status: string }>>`
      SELECT id, status FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;

    if (rows.length === 0 || rows[0].status !== "TRANSFER_FAILED") {
      return false;
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: "MANUAL_REVIEW" },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType,
        oldStatus: "TRANSFER_FAILED",
        newStatus: "MANUAL_REVIEW",
        description,
        metadata,
      },
    });

    return true;
  }, TX_OPTIONS);
}

// ======================================================
// DIPANGGIL SAAT TRANSFER GAGAL
// ======================================================
//
// Tidak pernah melempar error: kegagalan notifikasi tidak
// boleh merusak alur order.

export async function handleTransferFailure(params: {
  orderId: number;
  origin: FailureOrigin;
}): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: params.orderId },
      include: {
        user: true,
        robloxProfile: true,
        ticket: true,
        transfers: {
          where: { status: "FAILED" },
          orderBy: { requestedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!order || order.status !== "TRANSFER_FAILED") return;

    const errorCode = order.transfers[0]?.errorCode ?? null;
    const isLimit = kindFromErrorCode(errorCode) === "RECEIVER_LIMIT";

    const promptOrder: PromptOrder = {
      id: order.id,
      orderNumber: order.orderNumber,
      robuxAmount: order.robuxAmount,
      robloxUsername: order.robloxProfile.username,
      discordUserId: order.user.discordUserId,
    };

    // Admin baru saja mencoba dan hasilnya sudah terlihat di Discord admin:
    // cukup kembalikan ke antrean review, tanpa melibatkan customer.
    if (params.origin === "ADMIN") {
      await moveToManualReview(
        order.id,
        "ADMIN_RETRY_FAILED",
        "Proses ulang oleh admin gagal. Order dikembalikan ke antrean pemeriksaan.",
        { errorCode },
      );

      return;
    }

    // Setelah retry customer: embed kedua.
    if (params.origin === "CUSTOMER") {
      await sendToTicket(order.id, stage2Prompt(promptOrder));
      return;
    }

    // Kegagalan otomatis pertama
    if (isLimit && order.ticket) {
      await sendToTicket(order.id, stage1Prompt(promptOrder));
      return;
    }

    // Kegagalan yang tidak bisa diperbaiki customer → admin
    const moved = await moveToManualReview(
      order.id,
      "TRANSFER_NEEDS_ADMIN",
      "Transfer gagal dan membutuhkan pemeriksaan admin.",
      { errorCode },
    );

    if (moved) {
      await notifyAdminOrder({
        orderId: order.id,
        kind: "MANUAL_REVIEW",
        detail: `Transfer gagal (${errorCode ?? "tanpa kode"}).`,
      });

      await sendToTicket(order.id, {
        content:
          `<@${order.user.discordUserId}> ⚠️ Pengiriman Robux mengalami kendala. ` +
          "Admin sudah diberi tahu dan akan memeriksa order ini.",
        mentionUserId: order.user.discordUserId,
      });
    }
  } catch (error) {
    console.error(
      "❌ Gagal menangani transfer gagal:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ======================================================
// AKSI CUSTOMER
// ======================================================

export async function isOrderOwner(orderId: number, discordUserId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { user: { select: { discordUserId: true } } },
  });

  return order?.user.discordUserId === discordUserId;
}

async function lockOrderForCustomer(
  tx: Prisma.TransactionClient,
  orderId: number,
  discordUserId: string,
) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { user: true },
  });

  if (!order) {
    throw new CustomerFlowError("Order tidak ditemukan.");
  }

  if (order.user.discordUserId !== discordUserId) {
    throw new CustomerFlowError(
      "Tombol ini hanya bisa dipakai oleh pemilik order.",
    );
  }

  if (order.status !== "TRANSFER_FAILED") {
    throw new CustomerFlowError(
      "Order ini sedang tidak menunggu tindakan kamu.",
    );
  }

  return order;
}

// 2FA nyala → satu kali retry
export async function customerRetryAfter2FA(
  orderId: number,
  discordUserId: string,
) {
  await prisma.$transaction(async (tx) => {
    await lockOrderForCustomer(tx, orderId, discordUserId);

    const already = await tx.orderEvent.count({
      where: { orderId, eventType: "CUSTOMER_RETRY" },
    });

    if (already > 0) {
      throw new CustomerFlowError(
        "Percobaan ulang sudah dilakukan. Gunakan tombol bantuan admin atau cancel.",
      );
    }

    const failed = await tx.transfer.count({
      where: { orderId, status: "FAILED" },
    });

    if (failed === 0) {
      throw new CustomerFlowError("Tidak ada transfer yang bisa dicoba ulang.");
    }

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "CUSTOMER_RETRY",
        oldStatus: "TRANSFER_FAILED",
        newStatus: "TRANSFER_FAILED",
        description:
          "Customer mengonfirmasi 2FA sudah menyala dan meminta kirim ulang.",
      },
    });
  }, TX_OPTIONS);

  const result = await retryFailedTransfer(orderId);

  if (result.success) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, robloxProfile: true },
    });

    if (order) {
      await sendToTicket(orderId, {
        content:
          `✅ <@${order.user.discordUserId}> **${order.robuxAmount.toLocaleString("id-ID")} Robux** ` +
          `berhasil dikirim ke akun **${order.robloxProfile.username}**. Terima kasih!`,
        mentionUserId: order.user.discordUserId,
      });
    }

    return { success: true as const };
  }

  if (result.status === "TRANSFER_FAILED") {
    await handleTransferFailure({ orderId, origin: "CUSTOMER" });
  } else if (result.status === "MANUAL_REVIEW") {
    await notifyAdminOrder({
      orderId,
      kind: "MANUAL_REVIEW",
      detail: result.reason,
    });
  }

  return { success: false as const, status: result.status };
}

// Minta bantuan admin
export async function customerRequestHelp(
  orderId: number,
  discordUserId: string,
) {
  await prisma.$transaction(async (tx) => {
    await lockOrderForCustomer(tx, orderId, discordUserId);

    await tx.order.update({
      where: { id: orderId },
      data: { status: "MANUAL_REVIEW" },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "CUSTOMER_REQUESTED_HELP",
        oldStatus: "TRANSFER_FAILED",
        newStatus: "MANUAL_REVIEW",
        description: "Customer meminta bantuan admin setelah pengiriman gagal.",
      },
    });
  }, TX_OPTIONS);

  await notifyAdminOrder({
    orderId,
    kind: "HELP_REQUESTED",
    detail: "Customer meminta bantuan setelah pengiriman gagal.",
  });
}

// Cancel order → refund manual
export async function customerCancelOrder(
  orderId: number,
  discordUserId: string,
  input: { refundDestination: string; reason: string },
) {
  const destination = input.refundDestination.trim();
  const reason = input.reason.trim();

  if (destination.length < 5 || destination.length > 150) {
    throw new CustomerFlowError(
      "Tujuan refund harus 5 sampai 150 karakter (contoh: DANA 08123456789 a.n. Nama).",
    );
  }

  await prisma.$transaction(async (tx) => {
    await lockOrderForCustomer(tx, orderId, discordUserId);

    // Kuota sender dikembalikan karena Robux tidak jadi dikirim.
    await releaseQuotaForOrder(tx, orderId);

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "REFUND_REQUIRED",
        oldStatus: "TRANSFER_FAILED",
        newStatus: "CANCELLED",
        description: "Order dibatalkan customer. Refund manual diperlukan.",
        metadata: {
          requestedBy: "CUSTOMER",
          refundDestination: destination,
          reason: reason || null,
        },
      },
    });
  }, TX_OPTIONS);

  await notifyAdminOrder({
    orderId,
    kind: "REFUND_REQUESTED",
    detail: `Tujuan refund: ${destination}\nAlasan: ${reason || "-"}`,
  });
}

export async function notifyCustomerEscalated(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true },
  });

  if (!order) return;

  await sendToTicket(orderId, {
    content:
      `<@${order.user.discordUserId}> ⏰ Order kamu diteruskan ke admin karena belum ada tindakan. ` +
      "Admin akan memeriksa dan menghubungi kamu di sini.",
    mentionUserId: order.user.discordUserId,
  });
}