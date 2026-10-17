import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import {
  estimateUsage,
  fetchTransferRecords,
} from "./robloxTransactionService.js";
import { getNextDailyReset, getNextMonthlyReset } from "./transferService.js";

const TX_OPTIONS = { maxWait: 30000, timeout: 30000 };

export const ADMIN_SETTABLE_STATUSES = [
  "ACTIVE",
  "DISABLED",
  "MAINTENANCE",
] as const;

export type AdminSettableStatus = (typeof ADMIN_SETTABLE_STATUSES)[number];

// Error yang pesannya aman ditampilkan langsung ke admin.
export class SenderAdminError extends Error {}

function validateLimits(daily: number, monthly: number) {
  if (!Number.isInteger(daily) || !Number.isInteger(monthly)) {
    throw new SenderAdminError("Limit harus berupa bilangan bulat.");
  }

  if (daily <= 0 || monthly <= 0) {
    throw new SenderAdminError("Limit harus lebih besar dari 0.");
  }

  if (monthly < daily) {
    throw new SenderAdminError(
      "Limit bulanan tidak boleh lebih kecil dari limit harian.",
    );
  }
}

async function lockSender(tx: Prisma.TransactionClient, senderId: number) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "SenderAccount" WHERE id = ${senderId} FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new SenderAdminError(`Sender #${senderId} tidak ditemukan.`);
  }

  return tx.senderAccount.findUniqueOrThrow({ where: { id: senderId } });
}

async function audit(
  tx: Prisma.TransactionClient,
  senderAccountId: number,
  adminDiscordId: string,
  action: string,
  details: Prisma.InputJsonValue,
) {
  await tx.senderAuditLog.create({
    data: { senderAccountId, adminDiscordId, action, details },
  });
}

// Pemakaian yang ditampilkan memperhitungkan reset yang sudah lewat.
export function effectiveUsage(
  sender: {
    dailyUsed: number;
    monthlyUsed: number;
    dailyResetAt: Date | null;
    monthlyResetAt: Date | null;
  },
  now = new Date(),
) {
  return {
    dailyUsed:
      sender.dailyResetAt && now >= sender.dailyResetAt ? 0 : sender.dailyUsed,
    monthlyUsed:
      sender.monthlyResetAt && now >= sender.monthlyResetAt
        ? 0
        : sender.monthlyUsed,
  };
}

// ======================================================
// LIST
// ======================================================

export async function listSenders() {
  const senders = await prisma.senderAccount.findMany({
    orderBy: { id: "asc" },
  });

  const inFlight = await prisma.transfer.groupBy({
    by: ["senderAccountId"],
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    _count: { _all: true },
    _sum: { robuxAmount: true },
  });

  return senders.map((sender) => {
    const flight = inFlight.find((f) => f.senderAccountId === sender.id);

    return {
      ...sender,
      activeTransfers: flight?._count._all ?? 0,
      inFlightRobux: flight?._sum.robuxAmount ?? 0,
    };
  });
}

// ======================================================
// ADD
// ======================================================

export async function addSender(
  input: {
    accountName: string;
    robloxUserId: string;
    dailyLimit: number;
    monthlyLimit: number;
  },
  adminDiscordId: string,
) {
  const accountName = input.accountName.trim();
  const robloxUserId = input.robloxUserId.trim();

  if (accountName.length === 0 || accountName.length > 50) {
    throw new SenderAdminError("Nama sender harus 1 sampai 50 karakter.");
  }

  if (!/^\d{1,20}$/.test(robloxUserId)) {
    throw new SenderAdminError("Roblox user ID harus berupa angka.");
  }

  validateLimits(input.dailyLimit, input.monthlyLimit);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.senderAccount.findUnique({
      where: { robloxUserId },
    });

    if (existing) {
      throw new SenderAdminError(
        `Roblox user ID itu sudah terdaftar sebagai sender #${existing.id}.`,
      );
    }

    const sender = await tx.senderAccount.create({
      data: {
        accountName,
        robloxUserId,
        status: "ACTIVE",
        dailyLimit: input.dailyLimit,
        monthlyLimit: input.monthlyLimit,
      },
    });

    await audit(tx, sender.id, adminDiscordId, "SENDER_ADDED", {
      accountName,
      robloxUserId,
      dailyLimit: input.dailyLimit,
      monthlyLimit: input.monthlyLimit,
    });

    return sender;
  }, TX_OPTIONS);
}

// ======================================================
// LIMIT
// ======================================================

export async function updateLimits(
  senderId: number,
  input: { dailyLimit?: number; monthlyLimit?: number },
  adminDiscordId: string,
) {
  if (input.dailyLimit === undefined && input.monthlyLimit === undefined) {
    throw new SenderAdminError("Isi minimal satu limit yang ingin diubah.");
  }

  return prisma.$transaction(async (tx) => {
    const sender = await lockSender(tx, senderId);

    const dailyLimit = input.dailyLimit ?? sender.dailyLimit;
    const monthlyLimit = input.monthlyLimit ?? sender.monthlyLimit;

    validateLimits(dailyLimit, monthlyLimit);

    // Limit boleh diturunkan di bawah pemakaian saat ini:
    // efeknya hanya menolak order baru, order berjalan tidak disentuh.
    const updated = await tx.senderAccount.update({
      where: { id: senderId },
      data: { dailyLimit, monthlyLimit },
    });

    await audit(tx, senderId, adminDiscordId, "LIMIT_CHANGED", {
      before: {
        dailyLimit: sender.dailyLimit,
        monthlyLimit: sender.monthlyLimit,
      },
      after: { dailyLimit, monthlyLimit },
    });

    return { before: sender, after: updated };
  }, TX_OPTIONS);
}

// ======================================================
// STATUS
// ======================================================

export async function setSenderStatus(
  senderId: number,
  status: AdminSettableStatus,
  adminDiscordId: string,
) {
  return prisma.$transaction(async (tx) => {
    const sender = await lockSender(tx, senderId);

    if (status !== "ACTIVE") {
      const active = await tx.transfer.count({
        where: {
          senderAccountId: senderId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });

      if (active > 0) {
        throw new SenderAdminError(
          `Sender #${senderId} masih punya ${active} transfer berjalan. ` +
            "Selesaikan atau batalkan order terkait dulu sebelum menonaktifkannya.",
        );
      }
    }

    const updated = await tx.senderAccount.update({
      where: { id: senderId },
      data: { status },
    });

    await audit(tx, senderId, adminDiscordId, "STATUS_CHANGED", {
      before: sender.status,
      after: status,
    });

    return { before: sender, after: updated };
  }, TX_OPTIONS);
}

// ======================================================
// SYNC PEMAKAIAN
// ======================================================

export async function syncSenderUsage(
  senderId: number,
  adminDiscordId: string,
  manual?: { dailyUsed: number; monthlyUsed: number },
) {
  const sender = await prisma.senderAccount.findUnique({
    where: { id: senderId },
  });

  if (!sender) {
    throw new SenderAdminError(`Sender #${senderId} tidak ditemukan.`);
  }

  // Panggilan jaringan dilakukan SEBELUM transaksi dan kunci database.
  let base: { dailyUsed: number; monthlyUsed: number };
  let detail: Record<string, number> | null = null;

  if (manual) {
    base = manual;
  } else {
    const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const result = await fetchTransferRecords(sender.robloxUserId, since);

    if (!result.ok) {
      throw new SenderAdminError(
        `Gagal membaca data Roblox: ${result.reason}\n` +
          "Isi manual dengan `harian_terpakai` dan `bulanan_terpakai`.",
      );
    }

    const estimate = estimateUsage(result.value);

    base = {
      dailyUsed: estimate.dailyUsed,
      monthlyUsed: estimate.monthlyUsed,
    };
    detail = estimate.detail;
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockSender(tx, senderId);
    const now = new Date();

    // Transfer yang sudah di-reserve tetapi belum tercatat di Roblox
    // tetap dihitung, supaya kuota tidak terlalu longgar.
    const inFlight = await tx.transfer.aggregate({
      where: {
        senderAccountId: senderId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      _sum: { robuxAmount: true },
    });

    const reserved = inFlight._sum.robuxAmount ?? 0;
    const dailyUsed = base.dailyUsed + reserved;
    const monthlyUsed = base.monthlyUsed + reserved;

    const before = effectiveUsage(locked, now);

    await tx.senderAccount.update({
      where: { id: senderId },
      data: {
        dailyUsed,
        monthlyUsed,
        dailyResetAt:
          locked.dailyResetAt && locked.dailyResetAt > now
            ? locked.dailyResetAt
            : getNextDailyReset(now),
        monthlyResetAt:
          locked.monthlyResetAt && locked.monthlyResetAt > now
            ? locked.monthlyResetAt
            : getNextMonthlyReset(now),
      },
    });

    await audit(tx, senderId, adminDiscordId, "USAGE_SYNCED", {
      source: manual ? "MANUAL" : "ROBLOX",
      before,
      after: { dailyUsed, monthlyUsed },
      reserved,
      detail,
    });

    return {
      source: manual ? ("MANUAL" as const) : ("ROBLOX" as const),
      before,
      after: { dailyUsed, monthlyUsed },
      reserved,
      detail,
    };
  }, TX_OPTIONS);
}

// ======================================================
// PENGEMBALIAN KUOTA
// ======================================================
//
// Dipanggil di dalam transaksi aksi admin (batalkan / tandai selesai
// manual). Hanya transfer PENDING dan FAILED yang dikembalikan.
// Transfer PROCESSING tidak dikembalikan karena Robux mungkin sudah terkirim.
// Idempotent: sebuah transfer hanya dikembalikan sekali (event QUOTA_RELEASED).

export async function releaseQuotaForOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
) {
  const transfers = await tx.transfer.findMany({
    where: { orderId, status: { in: ["PENDING", "FAILED"] } },
  });

  for (const transfer of transfers) {
    const already = await tx.orderEvent.findFirst({
      where: {
        orderId,
        eventType: "QUOTA_RELEASED",
        metadata: { path: ["transferId"], equals: transfer.id },
      },
      select: { id: true },
    });

    if (already) continue;

    await tx.$executeRaw`
      UPDATE "SenderAccount"
      SET
        "dailyUsed" = GREATEST("dailyUsed" - ${transfer.robuxAmount}, 0),
        "monthlyUsed" = GREATEST("monthlyUsed" - ${transfer.robuxAmount}, 0),
        "updatedAt" = NOW()
      WHERE id = ${transfer.senderAccountId}
    `;

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "QUOTA_RELEASED",
        description: "Kuota sender dikembalikan karena transfer tidak dikirim.",
        metadata: {
          transferId: transfer.id,
          senderAccountId: transfer.senderAccountId,
          robuxAmount: transfer.robuxAmount,
        },
      },
    });
  }
}