import { prisma } from "./database/prisma.js";

async function main() {
  const orderId = 18;
  const transferId = 15;

  console.log("========================================");
  console.log("PREPARE PROCESSING RECOVERY TEST");
  console.log("========================================");

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      throw new Error(`Order ${orderId} tidak ditemukan.`);
    }

    const transfer = await tx.transfer.findUnique({
      where: {
        id: transferId,
      },
    });

    if (!transfer) {
      throw new Error(`Transfer ${transferId} tidak ditemukan.`);
    }

    if (transfer.orderId !== order.id) {
      throw new Error(
        `Transfer ${transferId} bukan milik Order ${orderId}.`,
      );
    }

    if (transfer.status !== "SUCCESS") {
      throw new Error(
        `Transfer ${transferId} harus SUCCESS. Status saat ini: ${transfer.status}`,
      );
    }

    await tx.transfer.update({
      where: {
        id: transfer.id,
      },
      data: {
        status: "PROCESSING",
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });

    await tx.order.update({
      where: {
        id: order.id,
      },
      data: {
        status: "PROCESSING",
        completedAt: null,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "RECOVERY_TEST_PREPARED",
        oldStatus: order.status,
        newStatus: "PROCESSING",
        description:
          "Test startup recovery: order disiapkan pada PROCESSING dengan transfer PROCESSING.",
        metadata: {
          transferId: transfer.id,
          test: true,
        },
      },
    });
  });

  console.log("✅ Recovery test berhasil disiapkan.");
  console.log("Order 18     → PROCESSING");
  console.log("Transfer 15  → PROCESSING");
  console.log("");
  console.log("Sekarang matikan bot dan nyalakan kembali.");
  console.log("========================================");
}

main()
  .catch((error) => {
    console.error("❌ Gagal menyiapkan test:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });