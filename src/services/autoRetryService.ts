import { prisma } from "../database/prisma.js";
import { retryFailedTransfer } from "./transferRetryService.js";

const AUTO_RETRY_ERRORS = [
  "NETWORK_ERROR",
  "TIMEOUT",
  "TEMPORARY_ERROR",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "MOCK_TRANSFER_FAILED",
] as const;

const MAX_AUTO_RETRY = 3;

// ==========================================
// WORKER GUARD
// ==========================================
//
// Mencegah cycle auto-retry overlap jika
// cycle sebelumnya belum selesai.
// ==========================================

let autoRetryRunning = false;

export async function processAutoRetries() {
  if (autoRetryRunning) {
    console.log(
      "⏭️ Auto Retry Worker masih berjalan. Skip cycle ini.",
    );
    return;
  }

  autoRetryRunning = true;

  try {
    console.log("========================================");
    console.log("AUTO RETRY CHECK");
    console.log("========================================");

    const failedTransfers = await prisma.transfer.findMany({
      where: {
        status: "FAILED",
        order: {
          status: "TRANSFER_FAILED",
        },
        errorCode: {
          in: [...AUTO_RETRY_ERRORS],
        },
      },
      include: {
        order: true,
      },
      orderBy: {
        requestedAt: "asc",
      },
    });

    if (failedTransfers.length === 0) {
      console.log("✅ Tidak ada transfer yang perlu auto-retry.");
      console.log("========================================");
      return;
    }

    console.log(
      `🔎 Ditemukan ${failedTransfers.length} transfer yang bisa di-auto-retry.`,
    );

    for (const transfer of failedTransfers) {
      console.log("----------------------------------------");
      console.log(`Order: ${transfer.order.orderNumber}`);
      console.log(`Order ID: ${transfer.orderId}`);
      console.log(`Transfer ID: ${transfer.id}`);
      console.log(`Error: ${transfer.errorCode}`);
      console.log(
        `Attempt: ${transfer.attemptCount}/${MAX_AUTO_RETRY}`,
      );

      if (transfer.attemptCount >= MAX_AUTO_RETRY) {
        console.log(
          "⚠️ Maksimum retry tercapai. Menjadi MANUAL_REVIEW.",
        );

        try {
          await retryFailedTransfer(transfer.orderId);
        } catch (error) {
          console.log(
            "ℹ️ Retry service menangani batas maksimum retry:",
            error instanceof Error
              ? error.message
              : error,
          );
        }

        continue;
      }

      try {
        console.log("🔄 Menjalankan auto-retry...");

        const result = await retryFailedTransfer(
          transfer.orderId,
        );

        if (result.success) {
          console.log(
            `✅ Auto-retry berhasil: ${transfer.order.orderNumber}`,
          );
        } else {
          console.log(
            `⚠️ Auto-retry gagal: ${transfer.order.orderNumber}`,
          );

          console.log(
            "Reason:",
            result.reason,
          );
        }
      } catch (error) {
        console.error(
          `❌ Auto-retry error untuk ${transfer.order.orderNumber}:`,
          error,
        );
      }
    }

    console.log("----------------------------------------");
    console.log("AUTO RETRY CHECK SELESAI");
    console.log("========================================");
  } finally {
    autoRetryRunning = false;
  }
}