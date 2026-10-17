import { prisma } from "../database/prisma.js";

export async function startTransfer(orderId: number) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: {
          id: orderId,
        },
        include: {
          transfers: true,
          robloxProfile: true,
        },
      });

      if (!order) {
        throw new Error(
          `Order ${orderId} tidak ditemukan.`,
        );
      }

      if (order.status !== "READY_TO_SEND") {
        throw new Error(
          `Order ${order.orderNumber} tidak siap dikirim. Status: ${order.status}`,
        );
      }

      const transfer = order.transfers.find(
        (item) =>
          item.status === "PENDING",
      );

      if (!transfer) {
        throw new Error(
          `Transfer PENDING untuk order ${order.orderNumber} tidak ditemukan.`,
        );
      }

      await tx.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: "PROCESSING",
        },
      });

      const updatedTransfer =
        await tx.transfer.update({
          where: {
            id: transfer.id,
          },
          data: {
            status: "PROCESSING",
            attemptCount: {
              increment: 1,
            },
          },
        });

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "TRANSFER_STARTED",
          oldStatus: "READY_TO_SEND",
          newStatus: "PROCESSING",
          description:
            "Transfer Robux mulai diproses.",
          metadata: {
            transferId: transfer.id,
            senderAccountId:
              transfer.senderAccountId,
            recipientRobloxId:
              transfer.recipientRobloxId,
            robuxAmount:
              transfer.robuxAmount,
            attemptCount:
              updatedTransfer.attemptCount,
          },
        },
      });

      return {
        order,
        transfer: updatedTransfer,
      };
    },
    {
      maxWait: 30000,
      timeout: 30000,
    },
  );
}