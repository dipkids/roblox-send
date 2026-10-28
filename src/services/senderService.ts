import { prisma } from "../database/prisma.js";

export async function findAvailableSender(
  robuxAmount: number,
) {
  if (
    !Number.isInteger(robuxAmount) ||
    robuxAmount <= 0
  ) {
    throw new Error(
      "Jumlah Robux tidak valid.",
    );
  }

  const senders =
    await prisma.senderAccount.findMany({
      where: {
        status: "ACTIVE",
      },
      orderBy: {
        dailyUsed: "asc",
      },
    });

  if (senders.length === 0) {
    return null;
  }

  const now = new Date();

  for (const sender of senders) {
    let dailyUsed =
      sender.dailyUsed;

    let monthlyUsed =
      sender.monthlyUsed;

    // ==========================================
    // RESET DAILY
    // ==========================================

    if (
      sender.dailyResetAt &&
      now >= sender.dailyResetAt
    ) {
      dailyUsed = 0;
    }

    // ==========================================
    // RESET MONTHLY
    // ==========================================

    if (
      sender.monthlyResetAt &&
      now >= sender.monthlyResetAt
    ) {
      monthlyUsed = 0;
    }

    // ==========================================
    // CHECK DAILY LIMIT
    // ==========================================

    const dailyRemaining =
      sender.dailyLimit -
      dailyUsed;

    if (
      dailyRemaining <
      robuxAmount
    ) {
      continue;
    }

    // ==========================================
    // CHECK MONTHLY LIMIT
    // ==========================================

    const monthlyRemaining =
      sender.monthlyLimit -
      monthlyUsed;

    if (
      monthlyRemaining <
      robuxAmount
    ) {
      continue;
    }

    return {
      sender,
      dailyUsed,
      monthlyUsed,
      dailyRemaining,
      monthlyRemaining,
    };
  }

  return null;
}


export async function getSenderStockStatus(): Promise<{
  hasActiveSenders: boolean;
  allLimitReached: boolean;
  maxAvailableRobux: number;
  totalRemainingRobux: number;
}> {
  const senders = await prisma.senderAccount.findMany({
    where: {
      status: "ACTIVE",
    },
  });

  if (senders.length === 0) {
    return {
      hasActiveSenders: false,
      allLimitReached: true,
      maxAvailableRobux: 0,
      totalRemainingRobux: 0,
    };
  }

  const now = new Date();
  let maxAvailable = 0;
  let totalRemaining = 0;
  let anyAvailable = false;

  for (const sender of senders) {
    let dailyUsed = sender.dailyUsed;
    let monthlyUsed = sender.monthlyUsed;

    if (sender.dailyResetAt && now >= sender.dailyResetAt) {
      dailyUsed = 0;
    }
    if (sender.monthlyResetAt && now >= sender.monthlyResetAt) {
      monthlyUsed = 0;
    }

    const dailyRemaining = Math.max(0, sender.dailyLimit - dailyUsed);
    const monthlyRemaining = Math.max(0, sender.monthlyLimit - monthlyUsed);
    const available = Math.min(dailyRemaining, monthlyRemaining);

    if (available > 0) {
      anyAvailable = true;
    }
    if (available > maxAvailable) {
      maxAvailable = available;
    }
    totalRemaining += available;
  }

  return {
    hasActiveSenders: true,
    allLimitReached: !anyAvailable,
    maxAvailableRobux: maxAvailable,
    totalRemainingRobux: totalRemaining,
  };
}

export async function checkSenderForOrder(
  orderId: number,
) {
  const order =
    await prisma.order.findUnique({
      where: {
        id: orderId,
      },
    });

  if (!order) {
    throw new Error(
      `Order ${orderId} tidak ditemukan.`,
    );
  }

  if (
    order.status !== "PAID"
  ) {
    throw new Error(
      `Order ${order.orderNumber} belum PAID.`,
    );
  }

  const result =
    await findAvailableSender(
      order.robuxAmount,
    );

  if (!result) {
    await prisma.order.update({
      where: {
        id: order.id,
      },

      data: {
        status:
          "SENDER_LIMIT_ERROR",
      },
    });

    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType:
          "SENDER_NOT_AVAILABLE",
        oldStatus: "PAID",
        newStatus:
          "SENDER_LIMIT_ERROR",
        description:
          "Tidak ada sender account yang memiliki kuota cukup.",
        metadata: {
          robuxAmount:
            order.robuxAmount,
        },
      },
    });

    return null;
  }

  await prisma.order.update({
    where: {
      id: order.id,
    },

    data: {
      status:
        "CHECKING_SENDER",
    },
  });

  await prisma.orderEvent.create({
    data: {
      orderId: order.id,
      eventType:
        "SENDER_CHECKED",
      oldStatus: "PAID",
      newStatus:
        "CHECKING_SENDER",
      description:
        `Sender ${result.sender.accountName} memiliki kuota yang cukup.`,
      metadata: {
        senderAccountId:
          result.sender.id,

        senderAccountName:
          result.sender.accountName,

        robuxAmount:
          order.robuxAmount,

        dailyRemaining:
          result.dailyRemaining,

        monthlyRemaining:
          result.monthlyRemaining,
      },
    },
  });

  return result;
}