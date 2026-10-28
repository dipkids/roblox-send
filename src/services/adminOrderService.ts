import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";

export const ADMIN_REVIEW_STATUSES = [
  "MANUAL_REVIEW",
  "SENDER_LIMIT_ERROR",
] as const;

export const UNPAID_STATUSES = [
  "PAYMENT_PENDING",
  "WAITING_PAYMENT",
  "CREATED",
] as const;

export type AdminReviewFilter = "review" | "unpaid" | "all";

export async function getManualReviewOrders(
  filter: AdminReviewFilter = "review",
) {
  let where: Prisma.OrderWhereInput = {};

  if (filter === "unpaid") {
    where = { status: { in: [...UNPAID_STATUSES] } };
  } else if (filter === "review") {
    where = { status: { in: [...ADMIN_REVIEW_STATUSES] } };
  } else {
    // "all": tampilkan order terbaru tanpa batasan status
    where = {};
  }

  return prisma.order.findMany({
    where,
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
      updatedAt: "desc",
    },
    take: 10,
  });
}

export async function getManualReviewOrder(orderId: number) {
  return prisma.order.findFirst({
    where: {
      id: orderId,
    },
    include: {
      user: true,
      robloxProfile: true,
      payment: true,
      ticket: true,
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
  note?: string,
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });

    if (!order) {
      throw new Error("Order tidak ditemukan.");
    }

    await tx.adminAction.create({
      data: {
        orderId,
        adminDiscordId,
        action: "ACKNOWLEDGE",
        oldStatus: order.status,
        newStatus: order.status,
        reason: note,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "ADMIN_ACKNOWLEDGED",
        oldStatus: order.status,
        newStatus: order.status,
        description: "Admin telah melihat dan memeriksa order ini.",
        metadata: {
          adminDiscordId,
          note: note ?? null,
        },
      },
    });

    return { success: true };
  });
}
