import { prisma } from "../database/prisma.js";

function generateOrderNumber(): string {
  const timestamp = Date.now();
  const random = Math.floor(1000 + Math.random() * 9000);

  return `AV-${timestamp}-${random}`;
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