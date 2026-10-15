import crypto from "node:crypto";

import { Prisma, } from "@prisma/client";

import {
  Router,
  Request,
  Response,
} from "express";

import { prisma } from "../database/prisma.js";

import {
  updateTicketPaymentSuccess,
} from "../services/ticketService.js";

import {
  fulfillPaidOrder,
} from "../services/orderFulfillmentService.js";

const router = Router();

let discordClient:
  import("discord.js").Client | null =
  null;

export function setDiscordClient(
  client: import("discord.js").Client,
) {
  discordClient = client;
}

interface MidtransNotification {
  transaction_time?: string;
  transaction_status?: string;
  transaction_id?: string;
  status_message?: string;
  status_code?: string;
  signature_key?: string;
  payment_type?: string;
  order_id?: string;
  merchant_id?: string;
  gross_amount?: string;
  fraud_status?: string;
  settlement_time?: string;
  expiry_time?: string;
}

// ======================================================
// VERIFY MIDTRANS SIGNATURE
// ======================================================

function verifySignature(
  notification: MidtransNotification,
): boolean {
  const serverKey =
    process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    throw new Error(
      "MIDTRANS_SERVER_KEY belum diatur di .env",
    );
  }

  if (
    !notification.order_id ||
    !notification.status_code ||
    !notification.gross_amount ||
    !notification.signature_key
  ) {
    return false;
  }

  const rawSignature =
    notification.order_id +
    notification.status_code +
    notification.gross_amount +
    serverKey;

  const calculatedSignature =
    crypto
      .createHash("sha512")
      .update(rawSignature)
      .digest("hex");

  return calculatedSignature ===
    notification.signature_key;
}

// ======================================================
// ORDER STATUS HELPERS
// ======================================================

type OrderStatus =
  | "CREATED"
  | "WAITING_PROFILE_CONFIRMATION"
  | "WAITING_PAYMENT"
  | "PAYMENT_PENDING"
  | "PAID"
  | "CHECKING_SENDER"
  | "READY_TO_SEND"
  | "PROCESSING"
  | "VERIFYING"
  | "COMPLETED"
  | "PAYMENT_TIMEOUT"
  | "PAYMENT_FAILED"
  | "SENDER_LIMIT_ERROR"
  | "TRANSFER_FAILED"
  | "MANUAL_REVIEW"
  | "CANCELLED";

/**
 * Hanya status payment-related yang boleh diubah
 * langsung oleh webhook pembayaran.
 *
 * Status fulfillment yang sudah lebih maju TIDAK
 * boleh diturunkan kembali menjadi PAID.
 */
function resolveOrderStatus(
  currentStatus: OrderStatus,
  paymentStatus:
    | "PENDING"
    | "PAID"
    | "EXPIRED"
    | "FAILED"
    | "REFUNDED",
  requestedOrderStatus:
    | "PAYMENT_PENDING"
    | "PAID"
    | "PAYMENT_TIMEOUT"
    | "PAYMENT_FAILED",
): OrderStatus {
  // ====================================================
  // PAYMENT PAID
  // ====================================================

  if (paymentStatus === "PAID") {
    switch (currentStatus) {
      // Order masih berada di tahap pembayaran.
      // Aman untuk berubah menjadi PAID.
      case "CREATED":
      case "WAITING_PROFILE_CONFIRMATION":
      case "WAITING_PAYMENT":
      case "PAYMENT_PENDING":
      case "PAID":
        return requestedOrderStatus === "PAID"
          ? "PAID"
          : currentStatus;

      // =================================================
      // FULFILLMENT SUDAH BERJALAN
      // =================================================
      //
      // JANGAN pernah downgrade ke PAID.
      //
      case "CHECKING_SENDER":
      case "READY_TO_SEND":
      case "PROCESSING":
      case "VERIFYING":
      case "COMPLETED":
      case "SENDER_LIMIT_ERROR":
      case "TRANSFER_FAILED":
      case "MANUAL_REVIEW":
      case "CANCELLED":
        return currentStatus;

      default:
        return currentStatus;
    }
  }

  // ====================================================
  // PAYMENT PENDING
  // ====================================================

  if (paymentStatus === "PENDING") {
    // Kalau fulfillment sudah berjalan, jangan mundur.
    if (
      currentStatus === "CHECKING_SENDER" ||
      currentStatus === "READY_TO_SEND" ||
      currentStatus === "PROCESSING" ||
      currentStatus === "VERIFYING" ||
      currentStatus === "COMPLETED" ||
      currentStatus === "SENDER_LIMIT_ERROR" ||
      currentStatus === "TRANSFER_FAILED" ||
      currentStatus === "MANUAL_REVIEW" ||
      currentStatus === "CANCELLED"
    ) {
      return currentStatus;
    }

    return requestedOrderStatus ===
      "PAYMENT_PENDING"
      ? "PAYMENT_PENDING"
      : currentStatus;
  }

  // ====================================================
  // PAYMENT EXPIRED
  // ====================================================

  if (paymentStatus === "EXPIRED") {
    // Payment expired tidak boleh membatalkan fulfillment
    // yang sudah berhasil/berjalan.
    if (
      currentStatus === "CHECKING_SENDER" ||
      currentStatus === "READY_TO_SEND" ||
      currentStatus === "PROCESSING" ||
      currentStatus === "VERIFYING" ||
      currentStatus === "COMPLETED" ||
      currentStatus === "SENDER_LIMIT_ERROR" ||
      currentStatus === "TRANSFER_FAILED" ||
      currentStatus === "MANUAL_REVIEW" ||
      currentStatus === "CANCELLED"
    ) {
      return currentStatus;
    }

    return requestedOrderStatus ===
      "PAYMENT_TIMEOUT"
      ? "PAYMENT_TIMEOUT"
      : currentStatus;
  }

  // ====================================================
  // PAYMENT FAILED
  // ====================================================

  if (paymentStatus === "FAILED") {
    // Jangan merusak fulfillment yang sudah berjalan.
    if (
      currentStatus === "CHECKING_SENDER" ||
      currentStatus === "READY_TO_SEND" ||
      currentStatus === "PROCESSING" ||
      currentStatus === "VERIFYING" ||
      currentStatus === "COMPLETED" ||
      currentStatus === "SENDER_LIMIT_ERROR" ||
      currentStatus === "TRANSFER_FAILED" ||
      currentStatus === "MANUAL_REVIEW" ||
      currentStatus === "CANCELLED"
    ) {
      return currentStatus;
    }

    return requestedOrderStatus ===
      "PAYMENT_FAILED"
      ? "PAYMENT_FAILED"
      : currentStatus;
  }

  // ====================================================
  // REFUNDED
  // ====================================================
  //
  // Payment bisa berubah menjadi REFUNDED, tetapi
  // status fulfillment tidak kita ubah di sini.
  // ====================================================

  if (paymentStatus === "REFUNDED") {
    return currentStatus;
  }

  return currentStatus;
}

// ======================================================
// MIDTRANS WEBHOOK
// ======================================================

router.post(
  "/midtrans",
  async (
    req: Request,
    res: Response,
  ) => {
    try {
      const notification =
        req.body as MidtransNotification;

      console.log(
        "========================================",
      );

      console.log(
        "Midtrans Notification Received",
      );

      console.log(
        notification,
      );

      console.log(
        "========================================",
      );

      // ==========================================
      // VERIFY SIGNATURE
      // ==========================================

      const signatureValid =
        verifySignature(notification);

      if (!signatureValid) {
        console.error(
          "❌ Invalid Midtrans signature.",
        );

        return res.status(401).json({
          success: false,
          message: "Invalid signature",
        });
      }

      console.log(
        "✅ Midtrans signature valid.",
      );

      // ==========================================
      // VALIDATE ORDER ID
      // ==========================================

      if (!notification.order_id) {
        return res.status(400).json({
          success: false,
          message: "Missing order_id",
        });
      }

      // ==========================================
      // VALIDATE GROSS AMOUNT
      // ==========================================

      if (!notification.gross_amount) {
        return res.status(400).json({
          success: false,
          message: "Missing gross_amount",
        });
      }

      // ==========================================
      // FIND PAYMENT
      // ==========================================

      const payment =
        await prisma.payment.findUnique({
          where: {
            midtransOrderId:
              notification.order_id,
          },

          include: {
            order: true,
          },
        });

      if (!payment) {
        console.error(
          `❌ Payment tidak ditemukan: ${notification.order_id}`,
        );

        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      // ==========================================
      // CHECK AMOUNT
      // ==========================================

      const notificationAmount =
        Number(
          notification.gross_amount,
        );

      if (
        !Number.isFinite(
          notificationAmount,
        ) ||
        notificationAmount !==
          payment.grossAmount
      ) {
        console.error(
          "❌ Gross amount tidak cocok.",
        );

        console.error({
          expected:
            payment.grossAmount,

          received:
            notification.gross_amount,
        });

        return res.status(400).json({
          success: false,
          message:
            "Gross amount mismatch",
        });
      }

      // ==========================================
      // DETERMINE PAYMENT STATUS
      // ==========================================

      const transactionStatus =
        notification.transaction_status;

      let paymentStatus:
        | "PENDING"
        | "PAID"
        | "EXPIRED"
        | "FAILED"
        | "REFUNDED" =
        "PENDING";

      let requestedOrderStatus:
        | "PAYMENT_PENDING"
        | "PAID"
        | "PAYMENT_TIMEOUT"
        | "PAYMENT_FAILED" =
        "PAYMENT_PENDING";

      // ==========================================
      // SUCCESS
      // ==========================================

      if (
        transactionStatus ===
        "settlement"
      ) {
        paymentStatus = "PAID";
        requestedOrderStatus = "PAID";
      }

      // ==========================================
      // QRIS / PAYMENT PENDING
      // ==========================================

      else if (
        transactionStatus ===
        "pending"
      ) {
        paymentStatus = "PENDING";
        requestedOrderStatus =
          "PAYMENT_PENDING";
      }

      // ==========================================
      // EXPIRED
      // ==========================================

      else if (
        transactionStatus ===
        "expire"
      ) {
        paymentStatus = "EXPIRED";
        requestedOrderStatus =
          "PAYMENT_TIMEOUT";
      }

      // ==========================================
      // FAILED
      // ==========================================

      else if (
        transactionStatus ===
          "deny" ||
        transactionStatus ===
          "cancel" ||
        transactionStatus ===
          "failure"
      ) {
        paymentStatus = "FAILED";
        requestedOrderStatus =
          "PAYMENT_FAILED";
      }

      // ==========================================
      // REFUND
      // ==========================================

      else if (
        transactionStatus ===
          "refund" ||
        transactionStatus ===
          "partial_refund"
      ) {
        paymentStatus = "REFUNDED";
      }

      // ==========================================
      // UNKNOWN STATUS
      // ==========================================

      else {
        console.log(
          `ℹ️ Status Midtrans belum ditangani: ${transactionStatus}`,
        );

        return res.status(200).json({
          success: true,
          message:
            "Notification received",
        });
      }

      // ==========================================
      // RESOLVE ORDER STATUS
      // ==========================================

      const resolvedOrderStatus =
        resolveOrderStatus(
          payment.order.status as OrderStatus,
          paymentStatus,
          requestedOrderStatus,
        );

      console.log(
        "Webhook status resolution:",
      );

      console.log({
        currentOrderStatus:
          payment.order.status,

        requestedOrderStatus,

        resolvedOrderStatus,

        currentPaymentStatus:
          payment.status,

        incomingPaymentStatus:
          paymentStatus,
      });

      // ==========================================
      // IDEMPOTENCY
      // ==========================================
      //
      // Payment dan Order sekarang dicek terpisah.
      //
      // Contoh:
      //
      // Payment PAID
      // Order COMPLETED
      //
      // webhook settlement datang lagi.
      //
      // Payment tetap PAID.
      // Order tetap COMPLETED.
      //
      // Tidak perlu dianggap sebagai perubahan state.
      // ==========================================

      const paymentAlreadyProcessed =
        payment.status ===
        paymentStatus;

      const orderAlreadyCorrect =
        payment.order.status ===
        resolvedOrderStatus;

      if (
        paymentAlreadyProcessed &&
        orderAlreadyCorrect
      ) {
        console.log(
          "ℹ️ Notification sudah pernah diproses.",
        );

        return res.status(200).json({
          success: true,
          message:
            "Already processed",
        });
      }

      // ==========================================
      // DATABASE TRANSACTION
      // ==========================================

      let finalOrderStatus:
        | OrderStatus
        | undefined;

      await prisma.$transaction(
        async (tx) => {
          // ======================================
          // RE-FETCH ORDER + PAYMENT
          // ======================================
          //
          // Penting untuk mengurangi kemungkinan
          // memakai state lama ketika ada webhook
          // atau worker lain yang berjalan bersamaan.
          // ======================================

          const currentPayment =
            await tx.payment.findUnique({
              where: {
                id: payment.id,
              },

              include: {
                order: true,
              },
            });

          if (!currentPayment) {
            throw new Error(
              `Payment ${payment.id} tidak ditemukan saat transaction.`,
            );
          }

          const currentOrderStatus =
            currentPayment.order
              .status as OrderStatus;

          // ======================================
          // RESOLVE ULANG BERDASARKAN STATE TERKINI
          // ======================================

          const transactionOrderStatus =
            resolveOrderStatus(
              currentOrderStatus,
              paymentStatus,
              requestedOrderStatus,
            );

          const oldPaymentStatus =
            currentPayment.status;

          const oldOrderStatus =
            currentOrderStatus;

          // ======================================
          // UPDATE PAYMENT
          // ======================================

          const paymentUpdateData: {
            status:
              | "PENDING"
              | "PAID"
              | "EXPIRED"
              | "FAILED"
              | "REFUNDED";

            transactionId?: string;
            paymentMethod?: string;
            signatureValid: boolean;
            rawNotification: Prisma.InputJsonValue;
            paidAt?: Date;
          } = {
            status:
              paymentStatus,

            signatureValid:
              true,

            rawNotification:
              JSON.parse(
                JSON.stringify(
                  notification,
                ),
              ),
          };

          if (
            notification.transaction_id
          ) {
            paymentUpdateData.transactionId =
              notification.transaction_id;
          }

          if (
            notification.payment_type
          ) {
            paymentUpdateData.paymentMethod =
              notification.payment_type;
          }

          if (
            paymentStatus === "PAID" &&
            !currentPayment.paidAt
          ) {
            paymentUpdateData.paidAt =
              new Date();
          }

          await tx.payment.update({
            where: {
              id: currentPayment.id,
            },

            data:
              paymentUpdateData,
          });

          // ======================================
          // UPDATE ORDER
          // ======================================
          //
          // Hanya update status jika memang berbeda.
          //
          // Yang paling penting:
          //
          // PROCESSING → settlement
          // tetap PROCESSING
          //
          // VERIFYING → settlement
          // tetap VERIFYING
          //
          // COMPLETED → settlement
          // tetap COMPLETED
          // ======================================

          const orderUpdateData: {
            status: OrderStatus;
            paidAt?: Date;
          } = {
            status:
              transactionOrderStatus,
          };

          if (
            paymentStatus === "PAID" &&
            !currentPayment.order.paidAt
          ) {
            orderUpdateData.paidAt =
              new Date();
          }

          const shouldUpdateOrder =
            currentOrderStatus !==
              transactionOrderStatus ||
            (
              paymentStatus === "PAID" &&
              !currentPayment.order.paidAt
            );

          if (shouldUpdateOrder) {
            await tx.order.update({
              where: {
                id:
                  currentPayment.order.id,
              },

              data:
                orderUpdateData,
            });
          }

          // ======================================
          // ORDER EVENT
          // ======================================
          //
          // Buat event jika payment state berubah
          // atau order state berubah.
          // ======================================

          const paymentChanged =
            oldPaymentStatus !==
            paymentStatus;

          const orderChanged =
            oldOrderStatus !==
            transactionOrderStatus;

          if (
            paymentChanged ||
            orderChanged
          ) {
            await tx.orderEvent.create({
              data: {
                orderId:
                  currentPayment.order.id,

                eventType:
                  `PAYMENT_${paymentStatus}`,

                oldStatus:
                  oldOrderStatus,

                newStatus:
                  transactionOrderStatus,

                description:
                  `Midtrans notification: ${transactionStatus}`,

                metadata:
                  JSON.parse(
                    JSON.stringify({
                      ...notification,

                      paymentChanged,

                      orderChanged,

                      currentPaymentStatus:
                        oldPaymentStatus,

                      incomingPaymentStatus:
                        paymentStatus,

                      currentOrderStatus:
                        oldOrderStatus,

                      requestedOrderStatus,

                      resolvedOrderStatus:
                        transactionOrderStatus,
                    }),
                  ),
              },
            });
          }

          // ======================================
          // LOG
          // ======================================

          console.log({
            oldPaymentStatus,
            newPaymentStatus:
              paymentStatus,

            oldOrderStatus,
            newOrderStatus:
              transactionOrderStatus,

            paymentChanged,
            orderChanged,
          });

          finalOrderStatus =
            transactionOrderStatus;
        },
      );

      console.log(
        "✅ Payment berhasil diperbarui.",
      );

      // ==========================================
      // UPDATE DISCORD TICKET
      // ==========================================

      if (
        paymentStatus === "PAID" &&
        discordClient
      ) {
        try {
          await updateTicketPaymentSuccess({
            client:
              discordClient,

            orderId:
              payment.orderId,
          });
        } catch (error) {
          console.error(
            "❌ Gagal update ticket Discord:",
            error,
          );
        }
      }

      // ==========================================
      // AUTO FULFILLMENT
      // ==========================================
      //
      // Tetap jalankan fulfillment untuk PAID.
      //
      // Kalau Order sudah:
      //
      // PROCESSING
      // VERIFYING
      // COMPLETED
      //
      // fulfillPaidOrder() akan melakukan
      // reconciliation berdasarkan transfer yang ada.
      //
      // Yang penting webhook tidak lagi
      // mengubah status order menjadi PAID.
      // ==========================================

      if (
        paymentStatus === "PAID"
      ) {
        try {
          console.log(
            `🚀 Memulai fulfillment order ${payment.orderId}...`,
          );

          const result =
            await fulfillPaidOrder(
              payment.orderId,
            );

          console.log(
            `✅ Fulfillment order ${payment.orderId} selesai.`,
          );

          console.log(
            "Fulfillment result:",
            result,
          );
        } catch (error) {
          console.error(
            `❌ Fulfillment order ${payment.orderId} gagal:`,
            error,
          );
        }
      }

      // ==========================================
      // RESPONSE MIDTRANS
      // ==========================================

      return res.status(200).json({
        success: true,

        orderStatus:
          finalOrderStatus,

        paymentStatus,
      });
    } catch (error) {
      console.error(
        "❌ Midtrans Webhook Error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message:
          "Internal server error",
      });
    }
  },
);

export default router;