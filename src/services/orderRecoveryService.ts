import { prisma } from "../database/prisma.js";
import { fulfillPaidOrder } from "./orderFulfillmentService.js";

const RECOVERABLE_STATUSES = [
  "PAID",
  "READY_TO_SEND",
  "PROCESSING",
  "VERIFYING",
] as const;

export async function recoverPendingOrders() {
  console.log("========================================");
  console.log("START ORDER RECOVERY");
  console.log("========================================");

  const orders = await prisma.order.findMany({
    where: {
      status: {
        in: [...RECOVERABLE_STATUSES],
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (orders.length === 0) {
    console.log(
      "✅ Tidak ada order yang perlu di-recovery.",
    );

    console.log("========================================");

    return;
  }

  console.log(
    `🔎 Ditemukan ${orders.length} order yang perlu di-recovery.`,
  );

  for (const order of orders) {
    console.log("----------------------------------------");
    console.log(
      "Recover order:",
      order.orderNumber,
    );
    console.log(
      "Order ID:",
      order.id,
    );
    console.log(
      "Status:",
      order.status,
    );

    try {
      const result =
        await fulfillPaidOrder(
          order.id,
        );

      if (result.success) {
        console.log(
          `✅ Recovery berhasil: ${order.orderNumber}`,
        );
      } else {
        console.log(
          `⚠️ Recovery belum selesai: ${order.orderNumber}`,
        );

        console.log(
          "Reason:",
          result.reason,
        );
      }
    } catch (error) {
      console.error(
        `❌ Recovery gagal untuk ${order.orderNumber}:`,
        error,
      );
    }
  }

  console.log("----------------------------------------");
  console.log("ORDER RECOVERY SELESAI");
  console.log("========================================");
}