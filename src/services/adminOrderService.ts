import { prisma } from "../database/prisma.js";

export async function getManualReviewOrders() {
  return prisma.order.findMany({
    where: {
      status: "MANUAL_REVIEW",
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
      status: "MANUAL_REVIEW",
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
        Array<{
          id: number;
          status: string;
        }>
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

      if (order.status !== "MANUAL_REVIEW") {
        throw new Error(
          `Order tidak lagi berstatus MANUAL_REVIEW. Status sekarang: ${order.status}`,
        );
      }

      const reason =
        "Admin telah memeriksa detail order MANUAL_REVIEW.";

      await tx.adminAction.create({
        data: {
          orderId,
          adminDiscordId,
          action: "REVIEW_ACKNOWLEDGED",
          oldStatus: "MANUAL_REVIEW",
          newStatus: "MANUAL_REVIEW",
          reason,
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ADMIN_REVIEW_ACKNOWLEDGED",
          oldStatus: "MANUAL_REVIEW",
          newStatus: "MANUAL_REVIEW",
          description: reason,
          metadata: {
            adminDiscordId,
          },
        },
      });

      return {
        orderId,
        status: "MANUAL_REVIEW" as const,
      };
    },
    {
      maxWait: 10000,
      timeout: 10000,
    },
  );
}