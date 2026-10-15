import { prisma } from "../database/prisma.js";
import { executeMockTransfer } from "./robloxTransferService.js";
import { verifyTransfer } from "./transferVerificationService.js";

const MAX_RETRY = 3;

// ======================================================
// RESULT TYPES
// ======================================================

type RetryResult =
  | {
      success: true;
      orderId: number;
      transferId: number;
      status: "COMPLETED";
      attemptCount: number;
    }
  | {
      success: false;
      orderId: number;
      transferId: number;
      status: "TRANSFER_FAILED";
      attemptCount: number;
      reason: string;
    }
  | {
      success: false;
      orderId: number;
      transferId: number | null;
      status: "MANUAL_REVIEW";
      attemptCount: number;
      reason: string;
    }
  | {
      success: false;
      orderId: number;
      transferId: number | null;
      status: "NOT_RETRYABLE";
      attemptCount: number;
      reason: string;
    };

// ======================================================
// RETRY FAILED TRANSFER
// ======================================================

export async function retryFailedTransfer(
  orderId: number,
): Promise<RetryResult> {
  console.log("========================================");
  console.log("RETRY FAILED TRANSFER");
  console.log(`Order ID: ${orderId}`);
  console.log("========================================");

  // ==========================================
  // CLAIM FAILED TRANSFER SECARA ATOMIC
  // ==========================================
  //
  // Lock Order + Transfer menggunakan FOR UPDATE.
  //
  // Tujuan:
  // Worker A → berhasil claim FAILED → PROCESSING
  // Worker B → menunggu lock → melihat sudah PROCESSING → STOP
  //
  // Dengan ini transfer yang sama tidak akan di-retry
  // oleh dua worker secara bersamaan.
  // ==========================================

  type ClaimOutcome =
    | {
        kind: "CLAIMED";
        transferId: number;
        attemptCount: number;
      }
    | {
        kind: "MAX_RETRY";
        transferId: number;
        attemptCount: number;
      }
    | {
        kind: "NOT_RETRYABLE";
        transferId: number | null;
        attemptCount: number;
        reason: string;
      };

  const outcome = await prisma.$transaction(
    async (tx): Promise<ClaimOutcome> => {
      const lockedOrders = await tx.$queryRaw<
        Array<{
          id: number;
          status: string;
        }>
      >`
        SELECT
          id,
          status
        FROM "Order"
        WHERE id = ${orderId}
        FOR UPDATE
      `;

      if (lockedOrders.length === 0) {
        return {
          kind: "NOT_RETRYABLE",
          transferId: null,
          attemptCount: 0,
          reason: `Order ${orderId} tidak ditemukan.`,
        };
      }

      const lockedOrder = lockedOrders[0];

      // ==========================================
      // CEK STATUS ORDER
      // ==========================================
      //
      // Kalau order sudah bukan TRANSFER_FAILED,
      // berarti sudah diproses worker lain
      // (misal sudah PROCESSING / MANUAL_REVIEW).
      //

      if (lockedOrder.status !== "TRANSFER_FAILED") {
        return {
          kind: "NOT_RETRYABLE",
          transferId: null,
          attemptCount: 0,
          reason: `Order ${orderId} tidak bisa di-retry karena status saat ini: ${lockedOrder.status}`,
        };
      }

      // ==========================================
      // AMBIL TRANSFER FAILED
      // ==========================================

      const failedTransfers = await tx.$queryRaw<
        Array<{
          id: number;
          orderId: number;
          senderAccountId: number;
          recipientRobloxId: bigint;
          robuxAmount: number;
          status: string;
          attemptCount: number;
          errorCode: string | null;
          errorMessage: string | null;
        }>
      >`
        SELECT
          id,
          "orderId",
          "senderAccountId",
          "recipientRobloxId",
          "robuxAmount",
          status,
          "attemptCount",
          "errorCode",
          "errorMessage"
        FROM "Transfer"
        WHERE
          "orderId" = ${orderId}
          AND status = 'FAILED'
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `;

      if (failedTransfers.length === 0) {
        return {
          kind: "NOT_RETRYABLE",
          transferId: null,
          attemptCount: 0,
          reason: `Order ${orderId} tidak memiliki transfer FAILED yang bisa di-retry.`,
        };
      }

      const failedTransfer = failedTransfers[0];

      // ==========================================
      // CEK MAX RETRY
      // ==========================================
      //
      // PENTING:
      //
      // Jangan throw di dalam transaction!
      //
      // Kalau throw, Prisma akan rollback update
      // MANUAL_REVIEW dan status order tetap
      // TRANSFER_FAILED selamanya.
      //
      // Jadi kita return outcome, lalu handle
      // di luar transaction.
      //

      if (failedTransfer.attemptCount >= MAX_RETRY) {
        await tx.order.update({
          where: {
            id: orderId,
          },
          data: {
            status: "MANUAL_REVIEW",
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "TRANSFER_MAX_RETRY",
            oldStatus: "TRANSFER_FAILED",
            newStatus: "MANUAL_REVIEW",
            description:
              "Transfer mencapai batas maksimum retry dan membutuhkan pemeriksaan manual.",
            metadata: {
              transferId: failedTransfer.id,
              attemptCount: failedTransfer.attemptCount,
              maxRetry: MAX_RETRY,
            },
          },
        });

        return {
          kind: "MAX_RETRY",
          transferId: failedTransfer.id,
          attemptCount: failedTransfer.attemptCount,
        };
      }

      // ==========================================
      // CLAIM
      // FAILED → PROCESSING
      // ==========================================
      //
      // Karena Order sudah di-lock dan Transfer juga
      // di-lock, hanya satu proses yang dapat melakukan
      // perubahan ini pada satu waktu.
      // ==========================================

      const updatedTransfer = await tx.transfer.update({
        where: {
          id: failedTransfer.id,
        },
        data: {
          status: "PROCESSING",
          attemptCount: {
            increment: 1,
          },
          errorCode: null,
          errorMessage: null,
        },
      });

      await tx.order.update({
        where: {
          id: orderId,
        },
        data: {
          status: "PROCESSING",
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "TRANSFER_RETRY",
          oldStatus: "TRANSFER_FAILED",
          newStatus: "PROCESSING",
          description: "Transfer gagal di-retry.",
          metadata: {
            transferId: failedTransfer.id,
            attemptCount: updatedTransfer.attemptCount,
            senderAccountId: failedTransfer.senderAccountId,
            recipientRobloxId:
              failedTransfer.recipientRobloxId.toString(),
            robuxAmount: failedTransfer.robuxAmount,
          },
        },
      });

      return {
        kind: "CLAIMED",
        transferId: updatedTransfer.id,
        attemptCount: updatedTransfer.attemptCount,
      };
    },
    {
      maxWait: 10000,
      timeout: 10000,
    },
  );

  // ==========================================
  // HANDLE OUTCOME DI LUAR TRANSACTION
  // ==========================================

  if (outcome.kind === "NOT_RETRYABLE") {
    console.log(
      `⏭️ Skip retry untuk Order ${orderId}: ${outcome.reason}`,
    );

    return {
      success: false,
      orderId,
      transferId: outcome.transferId,
      status: "NOT_RETRYABLE",
      attemptCount: outcome.attemptCount,
      reason: outcome.reason,
    };
  }

  if (outcome.kind === "MAX_RETRY") {
    console.log(
      `⚠️ Transfer ${outcome.transferId} sudah mencapai maksimum retry (${MAX_RETRY}).`,
    );

    console.log(
      `📌 Order ${orderId} dipindahkan ke MANUAL_REVIEW.`,
    );

    return {
      success: false,
      orderId,
      transferId: outcome.transferId,
      status: "MANUAL_REVIEW",
      attemptCount: outcome.attemptCount,
      reason: `Transfer ${outcome.transferId} sudah mencapai maksimum retry (${MAX_RETRY}).`,
    };
  }

  // ==========================================
  // CLAIMED → EXECUTE TRANSFER
  // ==========================================

  const retryingTransfer = {
    id: outcome.transferId,
    attemptCount: outcome.attemptCount,
  };

  console.log(
    `🔄 Retry dimulai untuk Transfer ${retryingTransfer.id}`,
  );

  console.log(
    `Attempt: ${retryingTransfer.attemptCount}/${MAX_RETRY}`,
  );

  // ==========================================
  // EXECUTE TRANSFER
  // ==========================================

  const simulateMockFailure =
    process.env.MOCK_TRANSFER_FAIL === "true";

  const result = await executeMockTransfer(
    retryingTransfer.id,
    simulateMockFailure
      ? {
          simulateFailure: true,
          failureMessage:
            "Simulasi transfer gagal untuk testing retry.",
        }
      : {},
  );

  // ==========================================
  // RETRY GAGAL LAGI
  // ==========================================

  if (result.status === "FAILED") {
    console.log(
      `❌ Retry gagal lagi untuk Transfer ${retryingTransfer.id}`,
    );

    return {
      success: false,
      orderId,
      transferId: retryingTransfer.id,
      status: "TRANSFER_FAILED",
      attemptCount: result.attemptCount,
      reason:
        result.errorMessage ??
        "Transfer gagal saat retry.",
    };
  }

  // ==========================================
  // TRANSFER BERHASIL
  // ==========================================

  console.log(
    `✅ Retry berhasil untuk Transfer ${retryingTransfer.id}`,
  );

  // executeMockTransfer:
  //
  // Transfer PROCESSING → SUCCESS
  // Order PROCESSING → VERIFYING
  //
  // Setelah itu lakukan verification.

  const verifiedOrder = await verifyTransfer(
    retryingTransfer.id,
  );

  console.log(
    `✅ Order ${verifiedOrder.id} berhasil diverifikasi.`,
  );

  return {
    success: true,
    orderId: verifiedOrder.id,
    transferId: retryingTransfer.id,
    status: "COMPLETED",
    attemptCount: result.attemptCount,
  };
}