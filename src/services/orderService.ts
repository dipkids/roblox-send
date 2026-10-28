import { prisma } from "../database/prisma.js";
import { getMinRobuxAmount } from "./minOrderService.js";

function generateOrderNumber(): string {
  const timestamp = Date.now();
  const random = Math.floor(1000 + Math.random() * 9000);

  return `AV-${timestamp}-${random}`;
}

export const MAX_ROBUX = 5000;
const MAX_OPEN_ORDERS = 2;

// Error yang pesannya aman ditampilkan ke customer.
export class OrderValidationError extends Error {}

export async function isValidRobuxAmount(amount: number): Promise<boolean> {
  const minRobux = await getMinRobuxAmount();
  return (
    Number.isInteger(amount) &&
    amount >= minRobux &&
    amount <= MAX_ROBUX 
  );
}

export async function createOrder(params: {
  discordUserId: string;
  discordUsername: string;
  robloxUserId: number;
  robloxUsername: string;
  robloxDisplayName: string;
  avatarUrl: string;
  robuxAmount: number;
  rate: number;
}) {

  if (!(await isValidRobuxAmount(params.robuxAmount))) {
    const minRobux = await getMinRobuxAmount();
    throw new OrderValidationError(
      `Jumlah Robux tidak valid. Minimal ${minRobux} Robux dan maksimal ${MAX_ROBUX} Robux.`,
    );
  }

  if (!Number.isInteger(params.rate) || params.rate <= 0) {
    throw new OrderValidationError("Rate harga tidak valid.");
  }

  const totalAmount =
    params.robuxAmount * params.rate;

  const orderNumber = generateOrderNumber();

  const result = await prisma.$transaction(
    async (tx) => {
      // ==============================
      // USER
      // ==============================
      const user = await tx.user.upsert({
        where: {
          discordUserId: params.discordUserId,
        },
        update: {
          discordUsername: params.discordUsername,
        },
        create: {
          discordUserId: params.discordUserId,
          discordUsername: params.discordUsername,
        },
      });

      // Kunci baris user supaya klik ganda tidak lolos dari batas.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

      // 1. Bersihkan order CREATED yang tersangkut tanpa pembayaran (> 3 menit)
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
      await tx.order.updateMany({
        where: {
          userId: user.id,
          status: "CREATED",
          createdAt: { lt: threeMinutesAgo },
        },
        data: {
          status: "CANCELLED",
        },
      });

      // 2. Bersihkan order PAYMENT_PENDING yang QRIS-nya sudah kedaluwarsa
      const now = new Date();
      const expiredPayments = await tx.payment.findMany({
        where: {
          order: {
            userId: user.id,
            status: "PAYMENT_PENDING",
          },
          status: "PENDING",
          expiredAt: { lt: now },
        },
        select: { orderId: true },
      });

      if (expiredPayments.length > 0) {
        const expiredOrderIds = expiredPayments.map((p) => p.orderId);
        await tx.order.updateMany({
          where: { id: { in: expiredOrderIds } },
          data: { status: "PAYMENT_TIMEOUT" },
        });
        await tx.payment.updateMany({
          where: { orderId: { in: expiredOrderIds } },
          data: { status: "EXPIRED" },
        });
      }

      const openOrders = await tx.order.count({
        where: {
          userId: user.id,
          status: {
            in: [
              "CREATED",
              "WAITING_PROFILE_CONFIRMATION",
              "WAITING_PAYMENT",
              "PAYMENT_PENDING",
            ],
          },
        },
      });

      if (openOrders >= MAX_OPEN_ORDERS) {
        throw new OrderValidationError(
          `Kamu masih punya ${openOrders} order yang belum dibayar. ` +
            "Selesaikan atau tunggu order itu kedaluwarsa dulu.",
        );
      }

      // ==============================
      // ROBLOX PROFILE
      // ==============================
      const robloxProfile =
        await tx.robloxProfile.upsert({
          where: {
            robloxUserId: params.robloxUserId.toString(),
          },
          update: {
            username: params.robloxUsername,
            displayName: params.robloxDisplayName,
            avatarUrl: params.avatarUrl,
            lastChecked: new Date(),
          },
          create: {
            robloxUserId: params.robloxUserId.toString(),
            username: params.robloxUsername,
            displayName: params.robloxDisplayName,
            avatarUrl: params.avatarUrl,
            lastChecked: new Date(),
          },
        });

      // ==============================
      // ORDER
      // ==============================
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId: user.id,
          robloxProfileId: robloxProfile.id,

          robuxAmount: params.robuxAmount,

          productPrice: totalAmount,
          paymentFee: 0,
          totalAmount,

          status: "CREATED",
        },
      });

      // ==============================
      // ORDER EVENT
      // ==============================
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "ORDER_CREATED",

          oldStatus: null,
          newStatus: "CREATED",

          description:
            "Order berhasil dibuat setelah Roblox Profile dikonfirmasi.",

          metadata: {
            rate: params.rate,
            robuxAmount: params.robuxAmount,
            totalAmount,
          },
        },
      });

      return {
        order,
        user,
        robloxProfile,
      };
    },
  );

  return result;
}