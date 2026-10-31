import { prisma } from "../database/prisma.js";
import { reserveSenderForOrder } from "./transferService.js";
import { getSendersLiveEconomy } from "./robloxEconomyService.js";
import { startTransfer } from "./transferExecutor.js";
import { executeTransfer, isRobloxBrowserBusy } from "./robloxTransferService.js";
import { sendOrderCompletionReceipt, sendTicketProcessingEmbed } from "./ticketService.js";
import { verifyTransfer } from "./transferVerificationService.js";
import { notifyAdminOrder, getNotificationClient } from "./adminNotificationService.js";
import { handleTransferFailure, type FailureOrigin, } from "./transferFailureService.js";

const inFlight = new Set<number>();

export async function fulfillPaidOrder(orderId: number, origin: FailureOrigin = "AUTO") {
  if (inFlight.has(orderId)) {
    console.log(
      `⏭️ Order ${orderId} sedang diproses proses lain. Skip.`,
    );

    return {
      success: false as const,
      reason: "ALREADY_IN_PROGRESS" as const,
    };
  }

  inFlight.add(orderId);

  try {
    return await runFulfillment(orderId, origin);
  } finally {
    inFlight.delete(orderId);
  }
}

async function runFulfillment(orderId: number, origin: FailureOrigin) {
  console.log("========================================");
  console.log("START ORDER FULFILLMENT");
  console.log(`Order ID: ${orderId}`);
  console.log("========================================");

  let order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      transfers: {
        orderBy: {
          requestedAt: "desc",
        },
      },
    },
  });

  if (!order) {
    throw new Error(`Order ${orderId} tidak ditemukan.`);
  }

  console.log(`Current status: ${order.status}`);

  // ============================================================
  // COMPLETED
  // ============================================================

  if (order.status === "COMPLETED") {
    console.log(`✅ Order ${orderId} sudah COMPLETED.`);

    return {
      success: true,
      order,
      reason: "ALREADY_COMPLETED",
    };
  }

  // ============================================================
  // PAID
  // ============================================================

  if (order.status === "PAID") {
    console.log(
      "📦 Order PAID → memeriksa transfer yang sudah ada...",
    );

    // ==========================================================
    // PAID + EXISTING TRANSFER
    // ==========================================================

    const existingTransfer = order.transfers[0];

    if (existingTransfer) {
      console.log(
        `ℹ️ Order ${order.orderNumber} sudah memiliki transfer ${existingTransfer.id}.`,
      );

      console.log(
        `Transfer status: ${existingTransfer.status}`,
      );

      // ========================================================
      // PENDING
      // ========================================================

      if (existingTransfer.status === "PENDING") {
        console.log(
          "🔄 Existing transfer PENDING → mengubah order menjadi READY_TO_SEND...",
        );

        order = await prisma.$transaction(
          async (tx) => {
            const currentOrder = await tx.order.findUnique({
              where: { id: orderId },
            });

            if (!currentOrder) {
              throw new Error(
                `Order ${orderId} tidak ditemukan saat recovery PENDING transfer.`,
              );
            }

            if (currentOrder.status === "PAID") {
              const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                  status: "READY_TO_SEND",
                },
                include: {
                  transfers: {
                    orderBy: {
                      requestedAt: "desc",
                    },
                  },
                },
              });

              await tx.orderEvent.create({
                data: {
                  orderId,
                  eventType: "ORDER_RECOVERY",
                  oldStatus: "PAID",
                  newStatus: "READY_TO_SEND",
                  description:
                    "Order direcovery berdasarkan transfer PENDING yang sudah ada.",
                  metadata: {
                    transferId: existingTransfer.id,
                    transferStatus: "PENDING",
                  },
                },
              });

              return updatedOrder;
            }

            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                transfers: {
                  orderBy: {
                    requestedAt: "desc",
                  },
                },
              },
            });
          },
          {
            maxWait: 30000,
            timeout: 30000,
          },
        );
      }

      // ========================================================
      // PROCESSING
      // ========================================================

      else if (existingTransfer.status === "PROCESSING") {
        console.log(
          "🔄 Existing transfer PROCESSING → mengubah order menjadi PROCESSING...",
        );

        order = await prisma.$transaction(
          async (tx) => {
            const currentOrder = await tx.order.findUnique({
              where: { id: orderId },
            });

            if (!currentOrder) {
              throw new Error(
                `Order ${orderId} tidak ditemukan saat recovery PROCESSING transfer.`,
              );
            }

            if (currentOrder.status === "PAID") {
              const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                  status: "PROCESSING",
                },
                include: {
                  transfers: {
                    orderBy: {
                      requestedAt: "desc",
                    },
                  },
                },
              });

              await tx.orderEvent.create({
                data: {
                  orderId,
                  eventType: "ORDER_RECOVERY",
                  oldStatus: "PAID",
                  newStatus: "PROCESSING",
                  description:
                    "Order direcovery berdasarkan transfer PROCESSING yang sudah ada.",
                  metadata: {
                    transferId: existingTransfer.id,
                    transferStatus: "PROCESSING",
                  },
                },
              });

              return updatedOrder;
            }

            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                transfers: {
                  orderBy: {
                    requestedAt: "desc",
                  },
                },
              },
            });
          },
          {
            maxWait: 30000,
            timeout: 30000,
          },
        );
      }

      // ========================================================
      // SUCCESS
      // ========================================================

      else if (existingTransfer.status === "SUCCESS") {
        console.log(
          "✅ Existing transfer SUCCESS → mengubah order menjadi VERIFYING...",
        );

        order = await prisma.$transaction(
          async (tx) => {
            const currentOrder = await tx.order.findUnique({
              where: { id: orderId },
            });

            if (!currentOrder) {
              throw new Error(
                `Order ${orderId} tidak ditemukan saat recovery SUCCESS transfer.`,
              );
            }

            if (currentOrder.status === "PAID") {
              const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                  status: "VERIFYING",
                },
                include: {
                  transfers: {
                    orderBy: {
                      requestedAt: "desc",
                    },
                  },
                },
              });

              await tx.orderEvent.create({
                data: {
                  orderId,
                  eventType: "ORDER_RECOVERY",
                  oldStatus: "PAID",
                  newStatus: "VERIFYING",
                  description:
                    "Order direcovery berdasarkan transfer SUCCESS yang sudah ada.",
                  metadata: {
                    transferId: existingTransfer.id,
                    externalTransferId:
                      existingTransfer.externalTransferId,
                    transferStatus: "SUCCESS",
                  },
                },
              });

              return updatedOrder;
            }

            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                transfers: {
                  orderBy: {
                    requestedAt: "desc",
                  },
                },
              },
            });
          },
          {
            maxWait: 30000,
            timeout: 30000,
          },
        );
      }

      // ========================================================
      // FAILED
      // ========================================================

      else if (existingTransfer.status === "FAILED") {
        console.log(
          "❌ Existing transfer FAILED → mengubah order menjadi TRANSFER_FAILED...",
        );

        order = await prisma.$transaction(
          async (tx) => {
            const currentOrder = await tx.order.findUnique({
              where: { id: orderId },
            });

            if (!currentOrder) {
              throw new Error(
                `Order ${orderId} tidak ditemukan saat recovery FAILED transfer.`,
              );
            }

            if (currentOrder.status === "PAID") {
              const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                  status: "TRANSFER_FAILED",
                },
                include: {
                  transfers: {
                    orderBy: {
                      requestedAt: "desc",
                    },
                  },
                },
              });

              await tx.orderEvent.create({
                data: {
                  orderId,
                  eventType: "ORDER_RECOVERY",
                  oldStatus: "PAID",
                  newStatus: "TRANSFER_FAILED",
                  description:
                    "Order direcovery berdasarkan transfer FAILED yang sudah ada.",
                  metadata: {
                    transferId: existingTransfer.id,
                    errorCode: existingTransfer.errorCode,
                    errorMessage: existingTransfer.errorMessage,
                    transferStatus: "FAILED",
                  },
                },
              });

              return updatedOrder;
            }

            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                transfers: {
                  orderBy: {
                    requestedAt: "desc",
                  },
                },
              },
            });
          },
          {
            maxWait: 30000,
            timeout: 30000,
          },
        );
        await handleTransferFailure({ orderId, origin });
      }
    }

    // ==========================================================
    // PAID + NO EXISTING TRANSFER
    // ==========================================================

    else {
      console.log(
        "📦 Tidak ada transfer → melakukan sender reservation...",
      );

      // Selalu sinkronkan saldo & limit Roblox real-time sebelum memilih sender
      try {
        await getSendersLiveEconomy();
      } catch (syncErr) {
        console.warn("⚠️ Gagal sync live economy sebelum reserve sender:", syncErr);
      }

      const reservation = await reserveSenderForOrder(orderId);

      // ========================================================
      // SENDER TIDAK TERSEDIA
      // ========================================================

      if (!reservation) {
        console.log(
          `❌ Sender tidak tersedia untuk order ${orderId}`,
        );

        const updatedOrder = await prisma.$transaction(
          async (tx) => {
            const currentOrder = await tx.order.findUnique({
              where: { id: orderId },
            });

            if (!currentOrder) {
              throw new Error(
                `Order ${orderId} tidak ditemukan saat update sender limit.`,
              );
            }

            // Jangan overwrite jika proses lain sudah mengubah status
            if (currentOrder.status !== "PAID") {
              return tx.order.findUniqueOrThrow({
                where: { id: orderId },
                include: {
                  transfers: {
                    orderBy: {
                      requestedAt: "desc",
                    },
                  },
                },
              });
            }

            const updated = await tx.order.update({
              where: { id: orderId },
              data: {
                status: "SENDER_LIMIT_ERROR",
              },
              include: {
                transfers: {
                  orderBy: {
                    requestedAt: "desc",
                  },
                },
              },
            });

            await tx.orderEvent.create({
              data: {
                orderId,
                eventType: "SENDER_LIMIT_REACHED",
                oldStatus: "PAID",
                newStatus: "SENDER_LIMIT_ERROR",
                description:
                  "Tidak ada sender yang tersedia karena limit pengiriman Robux telah tercapai.",
                metadata: {
                  reason: "SENDER_UNAVAILABLE",
                },
              },
            });

            return updated;
          },
          {
            maxWait: 30000,
            timeout: 30000,
          },
        );

        console.log(
          `⚠️ Order ${orderId} diubah menjadi SENDER_LIMIT_ERROR.`,
        );

        await notifyAdminOrder({
          orderId,
          kind: "SENDER_LIMIT",
          detail: `Tidak ada sender aktif dengan kuota minimal ${updatedOrder.robuxAmount} Robux.`,
        });

        return {
          success: false,
          reason: "SENDER_UNAVAILABLE",
          order: updatedOrder,
        };
      }

      // ========================================================
      // SENDER BERHASIL DI-RESERVE
      // ========================================================

      if (!reservation.sender) {
        throw new Error(
          `Sender reservation untuk order ${orderId} tidak memiliki sender.`,
        );
      }

      console.log(
        `✅ Sender reserved: ${reservation.sender.accountName}`,
      );

      // Refresh order setelah reservation
      order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          transfers: {
            orderBy: {
              requestedAt: "desc",
            },
          },
        },
      });

      if (!order) {
        throw new Error(
          `Order ${orderId} tidak ditemukan setelah sender reservation.`,
        );
      }
    }
  }

  // ============================================================
  // READY_TO_SEND
  // ============================================================

  if (order.status === "READY_TO_SEND") {
    console.log(
      "📦 Order READY_TO_SEND → mencari transfer PENDING...",
    );

    const pendingTransfer = order.transfers.find(
      (transfer) => transfer.status === "PENDING",
    );

    if (!pendingTransfer) {
      throw new Error(
        `Order ${orderId} READY_TO_SEND tetapi tidak memiliki transfer PENDING.`,
      );
    }

    console.log(
      `✅ Transfer PENDING ditemukan: ${pendingTransfer.id}`,
    );

    const startedTransfer = await startTransfer(orderId);

    console.log(
      `✅ Transfer started: ${startedTransfer.transfer.id}`,
    );

    const discordClientStart = getNotificationClient();
    if (discordClientStart) {
      const senderAcc = await prisma.senderAccount.findUnique({
        where: { id: startedTransfer.transfer.senderAccountId },
      });
      await sendTicketProcessingEmbed({
        client: discordClientStart,
        orderId,
        senderAccountName: senderAcc?.accountName,
        isQueued: isRobloxBrowserBusy(),
      }).catch((err) => console.error("Gagal kirim processing embed:", err));
    }

    // Refresh order
    order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        transfers: {
          orderBy: {
            requestedAt: "desc",
          },
        },
      },
    });

    if (!order) {
      throw new Error(
        `Order ${orderId} tidak ditemukan setelah transfer dimulai.`,
      );
    }
  }

  // ============================================================
  // PROCESSING
  // ============================================================

  if (order.status === "PROCESSING") {
    console.log(
      "⚙️ Order PROCESSING → mencari transfer PROCESSING...",
    );

    const processingTransfer = order.transfers.find(
      (transfer) => transfer.status === "PROCESSING",
    );

    if (!processingTransfer) {
      throw new Error(
        `Order ${orderId} PROCESSING tetapi tidak memiliki transfer PROCESSING.`,
      );
    }

    console.log(
      `🔄 Melanjutkan transfer: ${processingTransfer.id}`,
    );

    const simulateMockFailure = process.env.MOCK_TRANSFER_FAIL === "true";

    const completedTransfer = await executeTransfer(
      processingTransfer.id,
      simulateMockFailure
        ? {
            simulateFailure: true,
            failureMessage: "Simulasi transfer gagal untuk testing.",
          }
        : {},
    );

    // ==========================================================
    // TRANSFER FAILED
    // ==========================================================

    if (completedTransfer.status === "FAILED") {
      console.log(
        `❌ Transfer gagal: ${completedTransfer.id}`,
      );

      await handleTransferFailure({ orderId, origin });

      return {
        success: false,
        reason: "TRANSFER_FAILED",
        orderId,
        transfer: completedTransfer,
      };
    }

    console.log(
      `✅ Mock transfer success: ${completedTransfer.id}`,
    );

    // Refresh order
    order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        transfers: {
          orderBy: {
            requestedAt: "desc",
          },
        },
      },
    });

    if (!order) {
      throw new Error(
        `Order ${orderId} tidak ditemukan setelah mock transfer.`,
      );
    }
  }

  // ============================================================
  // VERIFYING
  // ============================================================

  if (order.status === "VERIFYING") {
    console.log(
      "🔍 Order VERIFYING → mencari transfer SUCCESS...",
    );

    const successfulTransfer = order.transfers.find(
      (transfer) => transfer.status === "SUCCESS",
    );

    if (!successfulTransfer) {
      throw new Error(
        `Order ${orderId} VERIFYING tetapi tidak memiliki transfer SUCCESS.`,
      );
    }

    console.log(
      `✅ Transfer SUCCESS ditemukan: ${successfulTransfer.id}`,
    );

    const completedOrder = await verifyTransfer(
      successfulTransfer.id,
    );

    console.log("================================");
    console.log("TRANSFER VERIFIED");
    console.log("================================");
    console.log(`Order: ${completedOrder.orderNumber}`);
    console.log(`Transfer ID: ${successfulTransfer.id}`);
    console.log(
      `External Transfer ID: ${successfulTransfer.externalTransferId}`,
    );
    console.log(`Robux: ${successfulTransfer.robuxAmount}`);
    console.log(`Status: ${completedOrder.status}`);
    console.log("================================");

    console.log(
      `🎉 Order completed: ${completedOrder.orderNumber}`,
    );
    const discordClient = getNotificationClient();
    if (discordClient) {
      await sendOrderCompletionReceipt({
        client: discordClient,
        orderId: completedOrder.id,
      }).catch((receiptErr) => {
        console.error("❌ Gagal mengirim struk digital ke pembeli:", receiptErr);
      });
    }

    console.log("========================================");
    console.log("ORDER FULFILLMENT COMPLETED");
    console.log("========================================");

    return {
      success: true,
      order: completedOrder,
      transfer: successfulTransfer,
    };
  }

  // ============================================================
  // COMPLETED
  // ============================================================

  if (order.status === "COMPLETED") {
    console.log(
      `✅ Order ${orderId} sudah COMPLETED.`,
    );

    return {
      success: true,
      order,
      reason: "COMPLETED",
    };
  }

  // ============================================================
  // SENDER LIMIT ERROR
  // ============================================================

  if (order.status === "SENDER_LIMIT_ERROR") {
    console.log(
      `⚠️ Order ${orderId} berada pada SENDER_LIMIT_ERROR.`,
    );

    return {
      success: false,
      reason: "SENDER_LIMIT_ERROR",
      order,
    };
  }

  // ============================================================
  // TRANSFER FAILED
  // ============================================================

  if (order.status === "TRANSFER_FAILED") {
    console.log(
      `❌ Order ${orderId} berada pada TRANSFER_FAILED.`,
    );

    return {
      success: false,
      reason: "TRANSFER_FAILED",
      order,
    };
  }

  // ============================================================
  // UNSUPPORTED STATUS
  // ============================================================

  console.log("⚠️ Fulfillment berhenti.");
  console.log(`Order: ${order.orderNumber}`);
  console.log(`Status: ${order.status}`);

  return {
    success: false,
    reason: "UNSUPPORTED_ORDER_STATUS",
    order,
  };
}