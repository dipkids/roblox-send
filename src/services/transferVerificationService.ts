import { prisma } from "../database/prisma.js";

export async function verifyTransfer(
  transferId: number,
) {
  const transfer = await prisma.transfer.findUnique({
    where: {
      id: transferId,
    },
    include: {
      order: true,
    },
  });

  if (!transfer) {
    throw new Error(
      `Transfer ${transferId} tidak ditemukan.`,
    );
  }

  if (transfer.status !== "SUCCESS") {
    throw new Error(
      `Transfer ${transferId} belum berhasil. Status: ${transfer.status}`,
    );
  }

  if (!transfer.externalTransferId) {
    throw new Error(
      `Transfer ${transferId} tidak memiliki externalTransferId.`,
    );
  }

  if (transfer.robuxAmount <= 0) {
    throw new Error(
      `Jumlah Robux transfer ${transferId} tidak valid.`,
    );
  }

  if (transfer.order.status !== "VERIFYING") {
    throw new Error(
      `Order ${transfer.order.orderNumber} tidak dalam status VERIFYING. Status: ${transfer.order.status}`,
    );
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const updatedOrder =
        await tx.order.update({
          where: {
            id: transfer.orderId,
          },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
          },
        });

      await tx.orderEvent.create({
        data: {
          orderId: transfer.orderId,
          eventType: "ORDER_COMPLETED",
          oldStatus: "VERIFYING",
          newStatus: "COMPLETED",
          description:
            "Transfer berhasil diverifikasi dan order selesai.",
          metadata: {
            transferId: transfer.id,
            externalTransferId:
              transfer.externalTransferId,
            robuxAmount:
              transfer.robuxAmount,
          },
        },
      });

      return updatedOrder;
    },
    {
      maxWait: 30000,
      timeout: 30000,
    },
  );

  console.log("================================");
  console.log("TRANSFER VERIFIED");
  console.log("================================");
  console.log(
    "Order:",
    result.orderNumber,
  );
  console.log(
    "Transfer ID:",
    transfer.id,
  );
  console.log(
    "External Transfer ID:",
    transfer.externalTransferId,
  );
  console.log(
    "Robux:",
    transfer.robuxAmount,
  );
  console.log("Status: COMPLETED");
  console.log("================================");

  return result;
}