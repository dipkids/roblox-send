import "dotenv/config";
import { prisma } from "./database/prisma.js";

const template = await prisma.order.findFirst();
const sender = await prisma.senderAccount.findFirst({
  where: { status: "ACTIVE" },
});

if (!template || !sender) {
  throw new Error("Butuh template order dan sender aktif.");
}

const base = {
  userId: template.userId,
  robloxProfileId: template.robloxProfileId,
  robuxAmount: 100,
  productPrice: 0,
  totalAmount: 0,
};

async function seedManualReview(label: string) {
  const order = await prisma.order.create({
    data: {
      ...base,
      orderNumber: `AV-TEST-${label}-${Date.now()}`,
      status: "MANUAL_REVIEW",
    },
  });

  await prisma.transfer.create({
    data: {
      orderId: order.id,
      senderAccountId: sender!.id,
      recipientRobloxId: "1",
      robuxAmount: 100,
      status: "FAILED",
      attemptCount: 3,
      errorCode: "RECEIVER_LIMIT",
      errorMessage: "Simulasi limit penerima",
    },
  });

  return order.id;
}

const retryId = await seedManualReview("RETRY");
const completeId = await seedManualReview("COMPLETE");
const cancelId = await seedManualReview("CANCEL");

const senderLimit = await prisma.order.create({
  data: {
    ...base,
    orderNumber: `AV-TEST-SENDER-${Date.now()}`,
    status: "SENDER_LIMIT_ERROR",
  },
});

console.log({
  retry: retryId,
  complete: completeId,
  cancel: cancelId,
  senderLimit: senderLimit.id,
});

await prisma.$disconnect();