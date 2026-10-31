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
    });

  if (senders.length === 0) {
    return null;
  }

  const now = new Date();
  const candidates: Array<{
    sender: (typeof senders)[number];
    dailyUsed: number;
    monthlyUsed: number;
    dailyRemaining: number;
    monthlyRemaining: number;
    balanceRemaining: number;
    remainingQuota: number;
  }> = [];

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
    // CHECK DAILY & MONTHLY LIMIT & ROBUX BALANCE
    // ==========================================

    const dailyRemaining =
      sender.dailyLimit -
      dailyUsed;

    const monthlyRemaining =
      sender.monthlyLimit -
      monthlyUsed;

    const balanceRemaining =
      sender.robuxBalance ?? 0;

    const remainingQuota = Math.min(dailyRemaining, monthlyRemaining, balanceRemaining);

    if (
      dailyRemaining >= robuxAmount &&
      monthlyRemaining >= robuxAmount &&
      balanceRemaining >= robuxAmount
    ) {
      candidates.push({
        sender,
        dailyUsed,
        monthlyUsed,
        dailyRemaining,
        monthlyRemaining,
        balanceRemaining,
        remainingQuota,
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Urutkan sender dari sisa limit PALING SEDIKIT (ASC),
  // agar sender 1 dihabiskan sampai limit dulu sebelum beralih ke sender 2.
  // Jika sisa limit sama, pilih sender dengan limit total terkecil atau ID terkecil.
  candidates.sort((a, b) => {
    if (a.remainingQuota !== b.remainingQuota) {
      return a.remainingQuota - b.remainingQuota;
    }
    if (a.sender.dailyLimit !== b.sender.dailyLimit) {
      return a.sender.dailyLimit - b.sender.dailyLimit;
    }
    return a.sender.id - b.sender.id;
  });

  const best = candidates[0];
  return {
    sender: best.sender,
    dailyUsed: best.dailyUsed,
    monthlyUsed: best.monthlyUsed,
    dailyRemaining: best.dailyRemaining,
    monthlyRemaining: best.monthlyRemaining,
  };
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
    const balanceRemaining = Math.max(0, sender.robuxBalance ?? 0);
    const available = Math.min(dailyRemaining, monthlyRemaining, balanceRemaining);

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