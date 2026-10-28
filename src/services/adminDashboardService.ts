import { prisma } from "../database/prisma.js";
import { listSenders, effectiveUsage } from "./senderAdminService.js";

// ======================================================
// OVERVIEW UNTUK DASHBOARD INTERNAL
// ======================================================
//
// Semua data di sini berasal dari sender account & order milik
// toko sendiri (bukan input cookie dari luar). Dashboard ini
// read-only: tidak ada endpoint yang menerima cookie Roblox.
// ======================================================

export async function getDashboardOverview() {
  const senders = await listSenders();

  const sendersWithUsage = senders.map((sender) => {
    const usage = effectiveUsage(sender);

    return {
      id: sender.id,
      accountName: sender.accountName,
      robloxUserId: sender.robloxUserId,
      status: sender.status,
      dailyUsed: usage.dailyUsed,
      dailyLimit: sender.dailyLimit,
      monthlyUsed: usage.monthlyUsed,
      monthlyLimit: sender.monthlyLimit,
      activeTransfers: sender.activeTransfers,
      inFlightRobux: sender.inFlightRobux,
      updatedAt: sender.updatedAt,
    };
  });

  const [
    manualReviewCount,
    senderLimitErrorCount,
    activeSenderCount,
    todayStart,
  ] = await Promise.all([
    prisma.order.count({ where: { status: "MANUAL_REVIEW" } }),
    prisma.order.count({ where: { status: "SENDER_LIMIT_ERROR" } }),
    prisma.senderAccount.count({ where: { status: "ACTIVE" } }),
    Promise.resolve(
      new Date(new Date().setHours(0, 0, 0, 0)),
    ),
  ]);

  const [completedToday, robuxSentTodayAgg] = await Promise.all([
    prisma.order.count({
      where: { status: "COMPLETED", completedAt: { gte: todayStart } },
    }),
    prisma.transfer.aggregate({
      where: { status: "SUCCESS", completedAt: { gte: todayStart } },
      _sum: { robuxAmount: true },
    }),
  ]);

  return {
    senders: sendersWithUsage,
    stats: {
      activeSenderCount,
      totalSenderCount: senders.length,
      manualReviewCount,
      senderLimitErrorCount,
      completedToday,
      robuxSentToday: robuxSentTodayAgg._sum.robuxAmount ?? 0,
    },
    generatedAt: new Date().toISOString(),
  };
}