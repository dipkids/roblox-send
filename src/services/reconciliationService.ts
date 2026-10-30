import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { prisma } from "../database/prisma.js";
import { notifyAdminOrder } from "./adminNotificationService.js";
import { getMidtransConfig } from "./paymentService.js";
import { recoverStaleOrders } from "./orderRecoveryService.js";
import { processMidtransNotification } from "../web/midtransWebhook.js";
import { notifyCustomerEscalated } from "./transferFailureService.js";
import { releaseQuotaForOrder } from "./senderAdminService.js";
import { refreshOrderPanel } from "./orderPanelService.js";

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
// AUTO CLOSE TIKET KEDALUWARSA (15 MENIT TANPA PEMBAYARAN)
// ======================================================

export async function autoCloseExpiredTickets(client: Client) {
  const now = new Date();
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000);

  // 1. Cari order yang menunggu pembayaran & sudah melebihi 15 menit
  const expiredOrders = await prisma.order.findMany({
    where: {
      status: {
        in: [
          "CREATED",
          "WAITING_PROFILE_CONFIRMATION",
          "WAITING_PAYMENT",
          "PAYMENT_PENDING",
        ],
      },
      OR: [
        {
          payment: {
            expiredAt: { lt: now },
            status: "PENDING",
          },
        },
        {
          payment: { is: null },
          createdAt: { lt: fifteenMinutesAgo },
        },
        {
          createdAt: { lt: fifteenMinutesAgo },
        },
      ],
    },
    include: {
      payment: true,
      ticket: true,
      user: true,
    },
    take: 15,
  });

  if (expiredOrders.length > 0) {
    for (const order of expiredOrders) {
      try {
        // SAFETY CHECK: Sebelum tutup tiket, cek status ke Midtrans terlebih dahulu!
        // Jangan sampai customer bayar di menit 14:55 dan webhook sedikit delay.
        if (order.payment?.midtransOrderId) {
          const midtransRes = await fetchMidtransStatus(order.payment.midtransOrderId);
          if (midtransRes.ok) {
            const isPaid =
              midtransRes.body.transaction_status === "settlement" ||
              midtransRes.body.transaction_status === "capture";

            if (isPaid) {
              console.log(
                `⚡ [AutoClose Safeguard] Order #${order.orderNumber} ternyata lunas di Midtrans! Memproses fulfillment alih-alih menutup tiket...`,
              );
              const result = await processMidtransNotification(midtransRes.body, "RECONCILE");
              if (result.postWork) {
                await result.postWork();
              }
              continue;
            }
          }
        }

        console.log(
          `⏰ [AutoClose] Menutup tiket #${order.orderNumber} karena melebihi batas waktu 15 menit tanpa pembayaran.`,
        );

        // Batalkan order di database & lepas kuota sender
        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: "PAYMENT_TIMEOUT",
              cancelledAt: new Date(),
            },
          });

          if (order.payment) {
            await tx.payment.update({
              where: { id: order.payment.id },
              data: { status: "EXPIRED" },
            });
          }

          if (order.ticket) {
            await tx.ticket.update({
              where: { id: order.ticket.id },
              data: { status: "CLOSED", closedAt: new Date() },
            });
          }

          await releaseQuotaForOrder(tx, order.id);

          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "PAYMENT_TIMEOUT",
              oldStatus: order.status,
              newStatus: "PAYMENT_TIMEOUT",
              description:
                "Tiket otomatis ditutup karena tidak ada aktivitas pembayaran selama 15 menit.",
            },
          });
        });

        // Notifikasi dan hapus channel Discord jika channel masih ada
        if (order.ticket?.channelId) {
          try {
            const channel = await client.channels.fetch(order.ticket.channelId).catch(() => null);
            if (channel && channel.isTextBased()) {
              const textCh = channel as TextChannel;
              const timeoutEmbed = new EmbedBuilder()
                .setTitle("⏳ Batas Waktu Pembayaran Habis (15 Menit)")
                .setColor(0xe74c3c)
                .setDescription(
                  `Halo <@${order.user.discordUserId}>,\n\n` +
                    `Tiket pesanan **#${order.orderNumber}** otomatis ditutup karena tidak ada pembayaran atau aktivitas selama 15 menit.\n\n` +
                    `🔒 Room tiket ini akan dihapus dalam **5 detik**. Jika kamu masih ingin melakukan pembelian, silakan buka tiket baru di panel order.`,
                )
                .setFooter({ text: "AutoVisend • Auto Close Timeout" })
                .setTimestamp();

              await textCh.send({ embeds: [timeoutEmbed] }).catch(() => null);

              setTimeout(async () => {
                try {
                  await textCh.delete("Tiket otomatis ditutup: batas waktu pembayaran 15 menit habis.");
                } catch {}
              }, 5000);
            }
          } catch (chErr) {
            console.warn(`⚠️ Gagal menghapus channel tiket #${order.ticket.channelId}:`, chErr);
          }
        }

        // Kirim DM ramah ke pembeli
        try {
          const discordUser = await client.users.fetch(order.user.discordUserId).catch(() => null);
          if (discordUser) {
            await discordUser.send({
              content: `ℹ️ Halo! Tiket pesanan Robux kamu (**#${order.orderNumber}**) otomatis ditutup karena melebihi batas waktu pembayaran 15 menit. Silakan buka tiket baru di Discord Takemi Store jika ingin memesan kembali ya!`,
            }).catch(() => null);
          }
        } catch {}
      } catch (orderErr) {
        console.error(`❌ Gagal memproses auto close untuk order #${order.id}:`, orderErr);
      }
    }

    refreshOrderPanel(client).catch(() => {});
  }

  // 2. Bersihkan juga tiket COMPLETED yang belum ditutup lebih dari 15 menit setelah selesai
  const oldCompletedTickets = await prisma.ticket.findMany({
    where: {
      status: "OPEN",
      order: {
        status: "COMPLETED",
        completedAt: { lt: fifteenMinutesAgo },
      },
    },
    take: 10,
  });

  for (const t of oldCompletedTickets) {
    try {
      await prisma.ticket.update({
        where: { id: t.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });
      const ch = await client.channels.fetch(t.channelId).catch(() => null);
      if (ch && "delete" in ch) {
        await (ch as TextChannel)
          .delete("Tiket selesai ditutup otomatis setelah 15 menit.")
          .catch(() => {});
      }
    } catch {}
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

export async function runBackgroundWorkers(client?: Client) {
  if (running) {
    return;
  }

  running = true;

  try {
    await runStep("recoverStaleOrders", () => recoverStaleOrders());
    await runStep("reconcilePayments", reconcilePayments);
    await runStep("escalateStaleCustomerWaits", escalateStaleCustomerWaits);
    await runStep("cancelAbandonedOrders", cancelAbandonedOrders);
    if (client) {
      await runStep("autoCloseExpiredTickets", () => autoCloseExpiredTickets(client));
    }
  } finally {
    running = false;
  }
}
