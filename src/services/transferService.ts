import { prisma } from "../database/prisma.js";

export async function reserveSenderForOrder(
  orderId: number,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      // ==========================================
      // AMBIL ORDER
      // ==========================================

      const order = await tx.order.findUnique({
        where: {
          id: orderId,
        },
        include: {
          robloxProfile: true,
          transfers: true,
        },
      });

      if (!order) {
        throw new Error(
          `Order ${orderId} tidak ditemukan.`,
        );
      }

      // ==========================================
      // IDEMPOTENCY CHECK
      // ==========================================

      const existingTransfer =
        order.transfers.find(
          (transfer) =>
            transfer.status !== "FAILED",
        );

      if (existingTransfer) {
        console.log(
          `ℹ️ Order ${order.orderNumber} sudah memiliki transfer ${existingTransfer.id}.`,
        );

        return {
          order,
          sender:
            await tx.senderAccount.findUnique({
              where: {
                id: existingTransfer.senderAccountId,
              },
            }),
          transfer: existingTransfer,
          alreadyReserved: true,
        };
      }

      if (order.status !== "PAID") {
        throw new Error(
          `Order ${order.orderNumber} belum berstatus PAID. Status sekarang: ${order.status}`,
        );
      }

      // ==========================================
      // WAKTU SEKARANG
      // ==========================================

      const now = new Date();

      // ==========================================
      // CARI SENDER AKTIF
      // LOCK ROW DENGAN FOR UPDATE
      // ==========================================

      const senders =
        await tx.$queryRaw<
          {
            id: number;
            accountName: string;
            robloxUserId: string;
            status: string;
            dailyLimit: number;
            monthlyLimit: number;
            dailyUsed: number;
            monthlyUsed: number;
            dailyResetAt: Date | null;
            monthlyResetAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
          }[]
        >`
          SELECT
            "id",
            "accountName",
            "robloxUserId",
            "status",
            "dailyLimit",
            "monthlyLimit",
            "dailyUsed",
            "monthlyUsed",
            "dailyResetAt",
            "monthlyResetAt",
            "createdAt",
            "updatedAt"
          FROM "SenderAccount"
          WHERE "status" = 'ACTIVE'
          ORDER BY "dailyUsed" ASC
          FOR UPDATE
        `;

      if (senders.length === 0) {
        await tx.order.update({
          where: {
            id: order.id,
          },
          data: {
            status: "SENDER_LIMIT_ERROR",
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType:
              "SENDER_NOT_AVAILABLE",
            oldStatus: "PAID",
            newStatus:
              "SENDER_LIMIT_ERROR",
            description:
              "Tidak ada sender aktif.",
          },
        });

        return null;
      }

      // ==========================================
      // CARI SENDER DENGAN KUOTA
      // ==========================================

      let selectedSender:
        | (typeof senders)[number]
        | null = null;

      let selectedDailyUsed = 0;
      let selectedMonthlyUsed = 0;

      let selectedDailyResetAt:
        | Date
        | null = null;

      let selectedMonthlyResetAt:
        | Date
        | null = null;

      for (const sender of senders) {
        let dailyUsed =
          sender.dailyUsed;

        let monthlyUsed =
          sender.monthlyUsed;

        let dailyResetAt =
          sender.dailyResetAt;

        let monthlyResetAt =
          sender.monthlyResetAt;

        // ========================================
        // DAILY RESET
        // ========================================

        if (
          dailyResetAt &&
          now >= dailyResetAt
        ) {
          dailyUsed = 0;

          dailyResetAt =
            getNextDailyReset(now);
        }

        // ========================================
        // INITIAL DAILY RESET
        // ========================================

        if (!dailyResetAt) {
          dailyResetAt =
            getNextDailyReset(now);
        }

        // ========================================
        // MONTHLY RESET
        // ========================================

        if (
          monthlyResetAt &&
          now >= monthlyResetAt
        ) {
          monthlyUsed = 0;

          monthlyResetAt =
            getNextMonthlyReset(now);
        }

        // ========================================
        // INITIAL MONTHLY RESET
        // ========================================

        if (!monthlyResetAt) {
          monthlyResetAt =
            getNextMonthlyReset(now);
        }

        const dailyRemaining =
          sender.dailyLimit -
          dailyUsed;

        const monthlyRemaining =
          sender.monthlyLimit -
          monthlyUsed;

        if (
          dailyRemaining >=
            order.robuxAmount &&
          monthlyRemaining >=
            order.robuxAmount
        ) {
          selectedSender =
            sender;

          selectedDailyUsed =
            dailyUsed;

          selectedMonthlyUsed =
            monthlyUsed;

          selectedDailyResetAt =
            dailyResetAt;

          selectedMonthlyResetAt =
            monthlyResetAt;

          break;
        }
      }

      // ==========================================
      // TIDAK ADA SENDER
      // ==========================================

      if (!selectedSender) {
        await tx.order.update({
          where: {
            id: order.id,
          },
          data: {
            status:
              "SENDER_LIMIT_ERROR",
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType:
              "SENDER_LIMIT_ERROR",
            oldStatus: "PAID",
            newStatus:
              "SENDER_LIMIT_ERROR",
            description:
              "Tidak ada sender dengan kuota yang cukup.",
            metadata: {
              requiredRobux:
                order.robuxAmount,
            },
          },
        });

        return null;
      }

      // ==========================================
      // HITUNG KUOTA BARU
      // ==========================================

      const newDailyUsed =
        selectedDailyUsed +
        order.robuxAmount;

      const newMonthlyUsed =
        selectedMonthlyUsed +
        order.robuxAmount;

      // ==========================================
      // UPDATE SENDER
      // ==========================================

      const updatedSender =
        await tx.senderAccount.update({
          where: {
            id: selectedSender.id,
          },
          data: {
            dailyUsed:
              newDailyUsed,

            monthlyUsed:
              newMonthlyUsed,

            dailyResetAt:
              selectedDailyResetAt,

            monthlyResetAt:
              selectedMonthlyResetAt,
          },
        });

      // ==========================================
      // BUAT TRANSFER
      // ==========================================

      const transfer =
        await tx.transfer.create({
          data: {
            orderId:
              order.id,

            senderAccountId:
              selectedSender.id,

            recipientRobloxId:
              order.robloxProfile.robloxUserId,

            robuxAmount:
              order.robuxAmount,

            status: "PENDING",

            attemptCount: 0,
          },
        });

      // ==========================================
      // ORDER → READY_TO_SEND
      // ==========================================

      const updatedOrder =
        await tx.order.update({
          where: {
            id: order.id,
          },
          data: {
            status:
              "READY_TO_SEND",
          },
        });

      // ==========================================
      // EVENT
      // ==========================================

      await tx.orderEvent.create({
        data: {
          orderId:
            order.id,

          eventType:
            "SENDER_RESERVED",

          oldStatus:
            "PAID",

          newStatus:
            "READY_TO_SEND",

          description:
            `Sender ${selectedSender.accountName} berhasil di-reserve untuk order.`,

          metadata: {
            senderAccountId:
              updatedSender.id,

            senderAccountName:
              updatedSender.accountName,

            robuxAmount:
              order.robuxAmount,

            dailyUsed:
              newDailyUsed,

            monthlyUsed:
              newMonthlyUsed,

            transferId:
              transfer.id,
          },
        },
      });

      return {
        order: updatedOrder,
        sender: updatedSender,
        transfer,
        alreadyReserved: false,
      };
    },
    {
      maxWait: 60000,
      timeout: 60000,
    },
  );
}

// ==========================================
// NEXT DAILY RESET
// ==========================================

export function getNextDailyReset(
  now: Date,
): Date {
  const next = new Date(now);

  next.setDate(
    next.getDate() + 1,
  );

  next.setHours(
    0,
    0,
    0,
    0,
  );

  return next;
}

// ==========================================
// NEXT MONTHLY RESET
// ==========================================

export function getNextMonthlyReset(
  now: Date,
): Date {
  const next = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
    0,
    0,
    0,
    0,
  );

  return next;
}