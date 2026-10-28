import { prisma } from "../database/prisma.js";
import { notifyAdminOrder } from "./adminNotificationService.js";
import { getMidtransConfig } from "./paymentService.js";
import { recoverStaleOrders } from "./orderRecoveryService.js";
import { processMidtransNotification } from "../web/midtransWebhook.js";
import { notifyCustomerEscalated } from "./transferFailureService.js";

type StatusBody = NonNullable<
  Parameters<typeof processMidtransNotification>[0]
>;

const PENDING_BATCH = 10;
const CUSTOMER_WAIT_HOURS = Number(process.env.CUSTOMER_WAIT_HOURS ?? 12);

let running = false;
let fastReconcileRunning = false;

// ======================================================
// STATUS MIDTRANS
// ======================================================

export async function fetchMidtransStatus(
  midtransOrderId: string,
): Promise<{ ok: true; body: StatusBody } | { ok: false; reason: string }> {
  try {
    const { serverKey, baseUrl } = getMidtransConfig();

    const res = await fetch(
      `${baseUrl}/v2/${encodeURIComponent(midtransOrderId)}/status`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    const body = (await res.json()) as StatusBody;

    if (body.status_code === "404") {
      return { ok: false, reason: "belum ada di Midtrans (404)" };
    }

    if (!body.transaction_status) {
      return {
        ok: false,
        reason: `respons tanpa transaction_status (HTTP ${res.status})`,
      };
    }

    if (!body.signature_key) {
      return { ok: false, reason: "respons tanpa signature_key" };
    }

    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "error tidak diketahui",
    };
  }
}

// ======================================================
// REKONSILIASI PEMBAYARAN CEPAT (POLLING REAL-TIME)
// ======================================================

export async function reconcilePayments() {
  if (fastReconcileRunning) return;
  fastReconcileRunning = true;

  try {
    const payments = await prisma.payment.findMany({
      where: {
        status: "PENDING",
        order: {
          status: { in: ["CREATED", "WAITING_PAYMENT", "PAYMENT_PENDING"] },
        },
      },
      orderBy: { createdAt: "desc" },
      take: PENDING_BATCH,
    });

    if (payments.length === 0) return;

    for (const payment of payments) {
      const status = await fetchMidtransStatus(payment.midtransOrderId);

      if (!status.ok) {
        continue;
      }

      // Jika belum dibayar (masih pending), lanjutkan ke transaksi berikutnya
      if (status.body.transaction_status === "pending") {
        continue;
      }

      const result = await processMidtransNotification(status.body, "RECONCILE");

      if (result.httpStatus !== 200) {
        continue;
      }

      if (result.body.message === "OK") {
        console.log(
          `⚡ Pembayaran terdeteksi cepat: ${payment.midtransOrderId} ` +
            `(${status.body.transaction_status}) → order ${result.body.orderStatus}`,
        );
      }

      if (result.postWork) {
        await result.postWork();
      }
    }
  } catch (err) {
    // Abaikan error polling transien
  } finally {
    fastReconcileRunning = false;
  }
}

// ======================================================
// CEK PEMBAYARAN MANUAL (TOMBOL DISCORD)
// ======================================================

export async function checkAndFulfillOrderPayment(orderId: number): Promise<{
  paid: boolean;
  statusText: string;
  orderNumber?: string;
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true },
  });

  if (!order) {
    return { paid: false, statusText: "Order tidak ditemukan." };
  }

  if (
    [
      "PAID",
      "CHECKING_SENDER",
      "READY_TO_SEND",
      "PROCESSING",
      "VERIFYING",
      "COMPLETED",
    ].includes(order.status)
  ) {
    return {
      paid: true,
      statusText: "Pembayaran sudah terverifikasi dan pesanan sedang/telah diproses.",
      orderNumber: order.orderNumber,
    };
  }

  if (order.status === "CANCELLED") {
    return { paid: false, statusText: "Order ini sudah dibatalkan." };
  }

  if (!order.payment) {
    return { paid: false, statusText: "Data pembayaran belum dibuat." };
  }

  const status = await fetchMidtransStatus(order.payment.midtransOrderId);
  if (!status.ok) {
    return {
      paid: false,
      statusText:
        status.reason === "belum ada di Midtrans (404)"
          ? "Menunggu pembayaran dilakukan oleh pembeli..."
          : `Status: ${status.reason}`,
      orderNumber: order.orderNumber,
    };
  }

  const isPaid =
    status.body.transaction_status === "settlement" ||
    status.body.transaction_status === "capture";

  if (isPaid) {
    const result = await processMidtransNotification(
      status.body,
      "MANUAL_CHECK",
    );
    if (result.postWork) {
      await result.postWork();
    }
    return {
      paid: true,
      statusText: "✅ Pembayaran berhasil terdeteksi! Robux sedang diproses.",
      orderNumber: order.orderNumber,
    };
  }

  return {
    paid: false,
    statusText: `Pembayaran belum diterima (Status: ${status.body.transaction_status || "pending"}). Silakan selesaikan pembayaran terlebih dahulu di aplikasi Anda.`,
    orderNumber: order.orderNumber,
  };
}

// ======================================================
// CUSTOMER TIDAK MERESPONS
// ======================================================

export async function escalateStaleCustomerWaits() {
  const cutoff = new Date(Date.now() - CUSTOMER_WAIT_HOURS * 3_600_000);

  const stale = await prisma.order.findMany({
    where: { status: "TRANSFER_FAILED", updatedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });

  for (const { id } of stale) {
    const moved = await prisma.$transaction(
      async (tx): Promise<boolean> => {
        const rows = await tx.$queryRaw<Array<{ id: number; status: string }>>`
          SELECT id, status FROM "Order" WHERE id = ${id} FOR UPDATE
        `;

        if (rows.length === 0 || rows[0].status !== "TRANSFER_FAILED") {
          return false;
        }

        await tx.order.update({
          where: { id },
          data: { status: "MANUAL_REVIEW" },
        });

        await tx.orderEvent.create({
          data: {
            orderId: id,
            eventType: "CUSTOMER_WAIT_TIMEOUT",
            oldStatus: "TRANSFER_FAILED",
            newStatus: "MANUAL_REVIEW",
            description: `Customer tidak merespons selama ${CUSTOMER_WAIT_HOURS} jam setelah pengiriman gagal.`,
          },
        });

        return true;
      },
      { maxWait: 30000, timeout: 30000 },
    );

    if (moved) {
      await notifyAdminOrder({
        orderId: id,
        kind: "MANUAL_REVIEW",
        detail: `Customer tidak merespons selama ${CUSTOMER_WAIT_HOURS} jam setelah pengiriman gagal.`,
      });
      await notifyCustomerEscalated(id);
    }
  }
}

// ======================================================
// ORDER YATIM (gagal sebelum QRIS terbuat)
// ======================================================

export async function cancelAbandonedOrders() {
  const cutoff = new Date(Date.now() - 30 * 60_000);

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ["CREATED", "WAITING_PROFILE_CONFIRMATION", "WAITING_PAYMENT"] },
      payment: { is: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: 20,
  });

  for (const { id } of orders) {
    await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: number; status: string }>>`
          SELECT id, status FROM "Order" WHERE id = ${id} FOR UPDATE
        `;

        if (
          rows.length === 0 ||
          !["CREATED", "WAITING_PROFILE_CONFIRMATION", "WAITING_PAYMENT"].includes(
            rows[0].status,
          )
        ) {
          return;
        }

        await tx.order.update({
          where: { id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        await tx.orderEvent.create({
          data: {
            orderId: id,
            eventType: "ORDER_ABANDONED",
            oldStatus: rows[0].status,
            newStatus: "CANCELLED",
            description:
              "Order tidak pernah mendapat pembayaran (QRIS gagal dibuat) dan dibatalkan otomatis.",
          },
        });
      },
      { maxWait: 30000, timeout: 30000 },
    );
  }
}

// ======================================================
// PENJALAN WORKER
// ======================================================

async function runStep(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    console.error(
      `❌ Worker ${name} gagal:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function runBackgroundWorkers() {
  if (running) {
    return;
  }

  running = true;

  try {
    await runStep("recoverStaleOrders", () => recoverStaleOrders());
    await runStep("reconcilePayments", reconcilePayments);
    await runStep("escalateStaleCustomerWaits", escalateStaleCustomerWaits);
    await runStep("cancelAbandonedOrders", cancelAbandonedOrders);
  } finally {
    running = false;
  }
}
