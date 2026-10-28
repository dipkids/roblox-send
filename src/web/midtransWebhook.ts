import crypto from "node:crypto";

import { Prisma } from "@prisma/client";
import { Router, Request, Response } from "express";

import { prisma } from "../database/prisma.js";
import { updateTicketPaymentSuccess } from "../services/ticketService.js";
import { fulfillPaidOrder } from "../services/orderFulfillmentService.js";
import { notifyAdminOrder } from "../services/adminNotificationService.js";

const router = Router();

let discordClient: import("discord.js").Client | null = null;

export function setDiscordClient(client: import("discord.js").Client) {
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

type PaymentStatusValue =
  | "PENDING"
  | "PAID"
  | "EXPIRED"
  | "FAILED"
  | "REFUNDED";

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

// ======================================================
// SIGNATURE
// ======================================================

function verifySignature(notification: MidtransNotification): boolean {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    throw new Error("MIDTRANS_SERVER_KEY belum diatur di .env");
  }

  if (
    !notification.order_id ||
    !notification.status_code ||
    !notification.gross_amount ||
    !notification.signature_key
  ) {
    return false;
  }

  const calculated = crypto
    .createHash("sha512")
    .update(
      notification.order_id +
        notification.status_code +
        notification.gross_amount +
        serverKey,
    )
    .digest("hex");

  const expected = Buffer.from(calculated);
  const received = Buffer.from(notification.signature_key);

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

// ======================================================
// ATURAN STATUS
// ======================================================

// Order yang masih berada di tahap pembayaran.
const PAYMENT_STAGE: readonly OrderStatus[] = [
  "CREATED",
  "WAITING_PROFILE_CONFIRMATION",
  "WAITING_PAYMENT",
  "PAYMENT_PENDING",
];

// Order yang sudah dianggap selesai tanpa pembayaran.
const DEAD_STATUSES: readonly OrderStatus[] = [
  "PAYMENT_TIMEOUT",
  "PAYMENT_FAILED",
  "CANCELLED",
];

// Status pembayaran hanya boleh maju, tidak pernah mundur.
const PAYMENT_RANK: Record<PaymentStatusValue, number> = {
  PENDING: 0,
  EXPIRED: 1,
  FAILED: 1,
  PAID: 2,
  REFUNDED: 3,
};

function resolvePaymentStatus(
  current: PaymentStatusValue,
  incoming: PaymentStatusValue,
): PaymentStatusValue {
  return PAYMENT_RANK[incoming] >= PAYMENT_RANK[current] ? incoming : current;
}

function resolveOrderStatus(
  currentOrder: OrderStatus,
  effectivePayment: PaymentStatusValue,
  previousPayment: PaymentStatusValue,
): OrderStatus {
  const inPaymentStage = PAYMENT_STAGE.includes(currentOrder);

  switch (effectivePayment) {
    case "PAID":
      if (inPaymentStage) return "PAID";

      // Uang masuk untuk order yang sudah dianggap mati:
      // jangan diam-diam diabaikan, minta admin memeriksa.
      // Hanya saat pembayaran baru berubah jadi PAID, supaya
      // notifikasi duplikat tidak membuka kembali order yang
      // sudah dibatalkan admin.
      if (DEAD_STATUSES.includes(currentOrder) && previousPayment !== "PAID") {
        return "MANUAL_REVIEW";
      }

      return currentOrder;

    case "PENDING":
      return inPaymentStage ? "PAYMENT_PENDING" : currentOrder;

    case "EXPIRED":
      return inPaymentStage ? "PAYMENT_TIMEOUT" : currentOrder;

    case "FAILED":
      return inPaymentStage ? "PAYMENT_FAILED" : currentOrder;

    default:
      // REFUNDED: status fulfillment tidak diubah di sini.
      return currentOrder;
  }
}

function mapTransactionStatus(status?: string): PaymentStatusValue | null {
  switch (status) {
    case "settlement":
      return "PAID";
    case "pending":
      return "PENDING";
    case "expire":
      return "EXPIRED";
    case "deny":
    case "cancel":
    case "failure":
      return "FAILED";
    case "refund":
    case "partial_refund":
      return "REFUNDED";
    default:
      return null;
  }
}

// ======================================================
// PEKERJAAN SETELAH MIDTRANS DIBALAS
// ======================================================

async function runPostWork(params: {
  orderId: number;
  incoming: PaymentStatusValue;
  nextOrder: OrderStatus;
  previousOrder: OrderStatus;
  latePayment: boolean;
}) {
  if (params.latePayment) {
    await notifyAdminOrder({
      orderId: params.orderId,
      kind: "MANUAL_REVIEW",
      detail:
        `Pembayaran diterima saat order berstatus ${params.previousOrder}. ` +
        "Periksa lalu proses ulang atau refund.",
    });

    return;
  }

  const fulfillable =
    params.incoming === "PAID" &&
    params.nextOrder !== "MANUAL_REVIEW" &&
    !DEAD_STATUSES.includes(params.nextOrder);

  if (!fulfillable) return;

  if (discordClient) {
    try {
      await updateTicketPaymentSuccess({
        client: discordClient,
        orderId: params.orderId,
      });
    } catch (error) {
      console.error(
        "❌ Gagal update ticket Discord:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  try {
    console.log(`🚀 Memulai fulfillment order ${params.orderId}...`);

    const result = await fulfillPaidOrder(params.orderId);

    console.log(`✅ Fulfillment order ${params.orderId} selesai.`, result);
  } catch (error) {
    console.error(
      `❌ Fulfillment order ${params.orderId} gagal:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// ======================================================
// PEMROSESAN NOTIFIKASI
// ======================================================
// Dipakai oleh webhook dan worker rekonsiliasi.

export interface NotificationResult {
  httpStatus: number;
  body: Record<string, unknown>;
  postWork?: () => Promise<void>;
}

export async function processMidtransNotification(
  notification: MidtransNotification | undefined,
  source: "WEBHOOK" | "RECONCILE" | "MANUAL_CHECK" = "WEBHOOK",
): Promise<NotificationResult> {
  if (!notification || typeof notification !== "object") {
    return {
      httpStatus: 400,
      body: { success: false, message: "Invalid body" },
    };
  }

  if (source === "WEBHOOK") {
    // Jangan cetak seluruh notifikasi (termasuk signature_key).
    console.log("Midtrans notification:", {
      order_id: notification.order_id,
      transaction_status: notification.transaction_status,
      status_code: notification.status_code,
      gross_amount: notification.gross_amount,
    });
  }

  if (!verifySignature(notification)) {
    console.error(`❌ Invalid Midtrans signature (${notification.order_id}).`);

    return {
      httpStatus: 401,
      body: { success: false, message: "Invalid signature" },
    };
  }

  const midtransOrderId = notification.order_id as string;

  const payment = await prisma.payment.findUnique({
    where: { midtransOrderId },
  });

  if (!payment) {
    console.error(`❌ Payment tidak ditemukan: ${midtransOrderId}`);

    return {
      httpStatus: 404,
      body: { success: false, message: "Payment not found" },
    };
  }

  const amount = Number(notification.gross_amount);

  if (!Number.isFinite(amount) || amount !== payment.grossAmount) {
    console.error("❌ Gross amount tidak cocok.", {
      expected: payment.grossAmount,
      received: notification.gross_amount,
    });

    return {
      httpStatus: 400,
      body: { success: false, message: "Gross amount mismatch" },
    };
  }

  const incoming = mapTransactionStatus(notification.transaction_status);

  if (!incoming) {
    console.log(
      `ℹ️ Status Midtrans belum ditangani: ${notification.transaction_status}`,
    );

    return {
      httpStatus: 200,
      body: { success: true, message: "Notification received" },
    };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Kunci order dulu: notifikasi yang datang bersamaan
    // diproses berurutan dan melihat keadaan terbaru.
    await tx.$queryRaw`
      SELECT id FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE
    `;

    const current = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { order: true },
    });

    const previousPayment = current.status as PaymentStatusValue;
    const previousOrder = current.order.status as OrderStatus;

    const effectivePayment = resolvePaymentStatus(previousPayment, incoming);
    const nextOrder = resolveOrderStatus(
      previousOrder,
      effectivePayment,
      previousPayment,
    );

    const paymentChanged = previousPayment !== effectivePayment;
    const orderChanged = previousOrder !== nextOrder;
    const needsPaymentPaidAt = effectivePayment === "PAID" && !current.paidAt;
    const needsOrderPaidAt =
      effectivePayment === "PAID" && !current.order.paidAt;

    const latePayment =
      effectivePayment === "PAID" &&
      paymentChanged &&
      nextOrder === "MANUAL_REVIEW" &&
      previousOrder !== "MANUAL_REVIEW";

    if (
      !paymentChanged &&
      !orderChanged &&
      !needsPaymentPaidAt &&
      !needsOrderPaidAt
    ) {
      return {
        changed: false,
        effectivePayment,
        nextOrder,
        previousOrder,
        latePayment: false,
      };
    }

    const paymentData: Prisma.PaymentUpdateInput = {
      status: effectivePayment,
      signatureValid: true,
      rawNotification: JSON.parse(JSON.stringify(notification)),
    };

    if (notification.transaction_id) {
      paymentData.transactionId = notification.transaction_id;
    }

    if (notification.payment_type) {
      paymentData.paymentMethod = notification.payment_type;
    }

    if (needsPaymentPaidAt) {
      paymentData.paidAt = new Date();
    }

    await tx.payment.update({
      where: { id: current.id },
      data: paymentData,
    });

    if (orderChanged || needsOrderPaidAt) {
      await tx.order.update({
        where: { id: current.orderId },
        data: {
          status: nextOrder,
          ...(needsOrderPaidAt ? { paidAt: new Date() } : {}),
        },
      });
    }

    if (paymentChanged || orderChanged) {
      await tx.orderEvent.create({
        data: {
          orderId: current.orderId,
          eventType: latePayment
            ? "LATE_PAYMENT"
            : `PAYMENT_${effectivePayment}`,
          oldStatus: previousOrder,
          newStatus: nextOrder,
          description: latePayment
            ? `Pembayaran diterima setelah order berstatus ${previousOrder}. Butuh pemeriksaan admin.`
            : `Midtrans ${source === "RECONCILE" ? "status check" : "notification"}: ${notification.transaction_status}`,
          metadata: {
            source,
            transactionStatus: notification.transaction_status ?? null,
            transactionId: notification.transaction_id ?? null,
            statusCode: notification.status_code ?? null,
            previousPaymentStatus: previousPayment,
            incomingPaymentStatus: incoming,
            effectivePaymentStatus: effectivePayment,
            previousOrderStatus: previousOrder,
            resolvedOrderStatus: nextOrder,
          },
        },
      });
    }

    return {
      changed: true,
      effectivePayment,
      nextOrder,
      previousOrder,
      latePayment,
    };
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      message: outcome.changed ? "OK" : "Already processed",
      orderStatus: outcome.nextOrder,
      paymentStatus: outcome.effectivePayment,
    },
    postWork: () =>
      runPostWork({
        orderId: payment.orderId,
        incoming,
        nextOrder: outcome.nextOrder,
        previousOrder: outcome.previousOrder,
        latePayment: outcome.latePayment,
      }),
  };
}

// ======================================================
// ROUTE
// ======================================================

router.post("/midtrans", async (req: Request, res: Response) => {
  try {
    const result = await processMidtransNotification(
      req.body as MidtransNotification | undefined,
    );

    // Balas Midtrans SEKARANG, sebelum pekerjaan yang lebih lambat.
    res.status(result.httpStatus).json(result.body);

    if (result.postWork) {
      await result.postWork();
    }
  } catch (error) {
    console.error(
      "❌ Midtrans Webhook Error:",
      error instanceof Error ? error.message : error,
    );

    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  }
});

export default router;