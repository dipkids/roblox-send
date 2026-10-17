import { prisma } from "../database/prisma.js";
import { notifyAdminOrder } from "./adminNotificationService.js";
import { getMidtransConfig } from "./paymentService.js";
import { recoverStaleOrders } from "./orderRecoveryService.js";
import { processMidtransNotification } from "../web/midtransWebhook.js";

type StatusBody = NonNullable<
  Parameters<typeof processMidtransNotification>[0]
>;

// Beri waktu webhook normal sebelum worker ikut memeriksa.
const PENDING_STALE_MINUTES = 3;
const PENDING_BATCH = 10;

const CUSTOMER_WAIT_HOURS = Number(process.env.CUSTOMER_WAIT_HOURS ?? 12);

let running = false;

// ======================================================
// STATUS MIDTRANS
// ======================================================

async function fetchMidtransStatus(
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
// REKONSILIASI PEMBAYARAN
// ======================================================

export async function reconcilePayments() {
  const cutoff = new Date(Date.now() - PENDING_STALE_MINUTES * 60_000);

  const payments = await prisma.payment.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
      order: {
        status: { in: ["CREATED", "WAITING_PAYMENT", "PAYMENT_PENDING"] },
      },
    },
    orderBy: { createdAt: "asc" },
    take: PENDING_BATCH,
  });

  for (const payment of payments) {
    const status = await fetchMidtransStatus(payment.midtransOrderId);

    if (!status.ok) {
      console.log(
        `ℹ️ Rekonsiliasi ${payment.midtransOrderId}: ${status.reason}`,
      );
      continue;
    }

    const result = await processMidtransNotification(status.body, "RECONCILE");

    if (result.httpStatus !== 200) {
      console.warn(
        `⚠️ Rekonsiliasi ${payment.midtransOrderId} ditolak (HTTP ${result.httpStatus}).`,
      );
      continue;
    }

    if (result.body.message === "OK") {
      console.log(
        `🔁 Rekonsiliasi ${payment.midtransOrderId}: ` +
          `${status.body.transaction_status} → order ${result.body.orderStatus}`,
      );
    }

    if (result.postWork) {
      await result.postWork();
    }
  }
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
    }
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
    console.log("⏭️ Worker masih berjalan. Skip cycle ini.");
    return;
  }

  running = true;

  try {
    await runStep("recoverStaleOrders", () => recoverStaleOrders());
    await runStep("reconcilePayments", reconcilePayments);
    await runStep("escalateStaleCustomerWaits", escalateStaleCustomerWaits);
  } finally {
    running = false;
  }
}