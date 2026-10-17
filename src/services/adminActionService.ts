import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { ADMIN_REVIEW_STATUSES } from "./adminOrderService.js";
import { fulfillPaidOrder } from "./orderFulfillmentService.js";
import { releaseQuotaForOrder } from "./senderAdminService.js";

const TX_OPTIONS = { maxWait: 30000, timeout: 30000 };

async function lockReviewOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
) {
  const rows = await tx.$queryRaw<Array<{ id: number; status: string }>>`
    SELECT id, status FROM "Order" WHERE id = ${orderId} FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new Error("Order tidak ditemukan.");
  }

  const order = rows[0];

  if (!(ADMIN_REVIEW_STATUSES as readonly string[]).includes(order.status)) {
    throw new Error(
      `Order tidak lagi membutuhkan tindakan admin. Status sekarang: ${order.status}`,
    );
  }

  return order;
}

// ======================================================
// PROSES ULANG
// ======================================================

export async function adminRetryOrder(
  orderId: number,
  adminDiscordId: string,
  reason: string,
) {
  const prepared = await prisma.$transaction(async (tx) => {
    const order = await lockReviewOrder(tx, orderId);

    let nextStatus: "READY_TO_SEND" | "PAID";
    let transferId: number | null = null;
    let previousAttempts = 0;

    if (order.status === "SENDER_LIMIT_ERROR") {
      // Belum ada transfer aktif: reservasi sender diulang dari awal.
      nextStatus = "PAID";
    } else {
      const failed = await tx.transfer.findFirst({
        where: { orderId, status: "FAILED" },
        orderBy: { requestedAt: "desc" },
      });

      if (failed) {
        transferId = failed.id;
        previousAttempts = failed.attemptCount;

        // Jatah retry baru setelah intervensi admin.
        await tx.transfer.update({
          where: { id: failed.id },
          data: {
            status: "PENDING",
            attemptCount: 0,
            errorCode: null,
            errorMessage: null,
          },
        });

        nextStatus = "READY_TO_SEND";
      } else {
        const totalTransfers = await tx.transfer.count({ where: { orderId } });

        if (totalTransfers > 0) {
          throw new Error(
            "Order ini tidak punya transfer FAILED yang bisa diproses ulang. Gunakan Tandai Selesai atau Batalkan.",
          );
        }

        // Dibayar tetapi belum punya transfer (mis. pembayaran terlambat).
        const payment = await tx.payment.findUnique({ where: { orderId } });

        if (payment?.status !== "PAID") {
          throw new Error(
            "Pembayaran order ini belum berstatus PAID, jadi tidak bisa diproses.",
          );
        }

        nextStatus = "PAID";
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: nextStatus },
    });

    await tx.adminAction.create({
      data: {
        orderId,
        adminDiscordId,
        action: "RETRY_ORDER",
        oldStatus: order.status,
        newStatus: nextStatus,
        reason,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "ADMIN_RETRY",
        oldStatus: order.status,
        newStatus: nextStatus,
        description: "Admin memproses ulang order.",
        metadata: { adminDiscordId, transferId, previousAttempts, reason },
      },
    });

    return { nextStatus };
  }, TX_OPTIONS);

  // Fulfillment dijalankan di luar transaksi supaya perubahan status
  // admin tetap tersimpan walaupun pemrosesan ulang gagal.
  try {
    const result = await fulfillPaidOrder(orderId, "ADMIN");

    return {
      nextStatus: prepared.nextStatus,
      success: result.success,
      reason: "reason" in result ? (result.reason ?? null) : null,
      error: null as string | null,
    };
  } catch (error) {
    return {
      nextStatus: prepared.nextStatus,
      success: false,
      reason: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ======================================================
// TANDAI SELESAI (dikirim manual di luar sistem)
// ======================================================

export async function adminMarkCompleted(
  orderId: number,
  adminDiscordId: string,
  note: string,
) {
  return prisma.$transaction(async (tx) => {
    const order = await lockReviewOrder(tx, orderId);

    await tx.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    await releaseQuotaForOrder(tx, orderId);

    await tx.adminAction.create({
      data: {
        orderId,
        adminDiscordId,
        action: "MARK_COMPLETED_MANUAL",
        oldStatus: order.status,
        newStatus: "COMPLETED",
        reason: note,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "ADMIN_MARK_COMPLETED",
        oldStatus: order.status,
        newStatus: "COMPLETED",
        description:
          "Admin menyelesaikan order secara manual (Robux dikirim di luar sistem).",
        metadata: { adminDiscordId, note },
      },
    });

    return { orderId, status: "COMPLETED" as const };
  }, TX_OPTIONS);
}

// ======================================================
// BATALKAN (refund dilakukan manual oleh admin)
// ======================================================

export async function adminCancelOrder(
  orderId: number,
  adminDiscordId: string,
  note: string,
) {
  return prisma.$transaction(async (tx) => {
    const order = await lockReviewOrder(tx, orderId);

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await releaseQuotaForOrder(tx, orderId);

    await tx.adminAction.create({
      data: {
        orderId,
        adminDiscordId,
        action: "CANCEL_REFUND_REQUIRED",
        oldStatus: order.status,
        newStatus: "CANCELLED",
        reason: note,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "REFUND_REQUIRED",
        oldStatus: order.status,
        newStatus: "CANCELLED",
        description: "Order dibatalkan admin. Refund manual diperlukan.",
        metadata: { adminDiscordId, note },
      },
    });

    return { orderId, status: "CANCELLED" as const };
  }, TX_OPTIONS);
}