import { prisma } from "../database/prisma.js";

export const ADMIN_REVIEW_STATUSES = [
  "MANUAL_REVIEW",
  "SENDER_LIMIT_ERROR",
] as const;

export async function getManualReviewOrders() {
  return prisma.order.findMany({
    where: {
      status: { in: [...ADMIN_REVIEW_STATUSES] },
    },
    include: {
      user: true,
      robloxProfile: true,
      payment: true,
      transfers: {
        orderBy: {
          requestedAt: "desc",
        },
      },
    },
    orderBy: {
      updatedAt: "asc",
    },
    take: 10,
  });
}

export async function getManualReviewOrder(
  orderId: number,
) {
  return prisma.order.findFirst({
    where: {
      id: orderId,
      status: { in: [...ADMIN_REVIEW_STATUSES] },
    },
    include: {
      user: true,
      robloxProfile: true,
      payment: true,
      transfers: {
        include: {
          senderAccount: true,
        },
        orderBy: {
          requestedAt: "desc",
        },
      },
      events: {
        orderBy: {
          createdAt: "desc",
        },
        take: 8,
      },
      adminActions: {
        orderBy: {
          createdAt: "desc",
        },
        take: 8,
      },
    },
  });
}

export async function acknowledgeManualReview(
  orderId: number,
  adminDiscordId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const lockedOrders = await tx.$queryRaw<
        Array<{ id: number; status: string }>
      >`
        SELECT id, status
        FROM "Order"
        WHERE id = ${orderId}
        FOR UPDATE
      `;

      if (lockedOrders.length === 0) {
        throw new Error("Order tidak ditemukan.");
      }

      const order = lockedOrders[0];

      if (
        !(ADMIN_REVIEW_STATUSES as readonly string[]).includes(order.status)
      ) {
        throw new Error(
          `Order tidak lagi membutuhkan pemeriksaan admin. Status sekarang: ${order.status}`,
        );
      }

      const reason = "Admin telah memeriksa detail order.";

      await tx.adminAction.create({
        data: {
          orderId,
          adminDiscordId,
          action: "REVIEW_ACKNOWLEDGED",
          oldStatus: order.status,
          newStatus: order.status,
          reason,
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ADMIN_REVIEW_ACKNOWLEDGED",
          oldStatus: order.status,
          newStatus: order.status,
          description: reason,
          metadata: { adminDiscordId },
        },
      });

      return { orderId, status: order.status };
    },
    { maxWait: 30000, timeout: 30000 },
  );
}