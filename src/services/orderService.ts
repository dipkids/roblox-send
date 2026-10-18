import { prisma } from "../database/prisma.js";

function generateOrderNumber(): string {
  const timestamp = Date.now();
  const random = Math.floor(1000 + Math.random() * 9000);

  return `AV-${timestamp}-${random}`;
}

const MIN_ROBUX = 100;
const MAX_ROBUX = 5000;
const ROBUX_STEP = 100;
const MAX_OPEN_ORDERS = 2;

// Error yang pesannya aman ditampilkan ke customer.
export class OrderValidationError extends Error {}

export function isValidRobuxAmount(amount: number): boolean {
  return (
    Number.isInteger(amount) &&
    amount >= MIN_ROBUX &&
    amount <= MAX_ROBUX &&
    amount % ROBUX_STEP === 0
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

  if (!isValidRobuxAmount(params.robuxAmount)) {
    throw new OrderValidationError("Jumlah Robux tidak valid.");
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