import "dotenv/config";
import { prisma } from "./database/prisma.js";
import { reserveSenderForOrder } from "./services/transferService.js";
import { adminCancelOrder } from "./services/adminActionService.js";

const template = await prisma.order.findFirst();

if (!template) throw new Error("Butuh template order.");

const order = await prisma.order.create({
  data: {
    userId: template.userId,
    robloxProfileId: template.robloxProfileId,
    robuxAmount: 100,
    productPrice: 0,
    totalAmount: 0,
    orderNumber: `AV-TEST-Q-${Date.now()}`,
    status: "PAID",
  },
});

const reserved = await reserveSenderForOrder(order.id);

if (!reserved?.sender) throw new Error("Tidak ada sender tersedia.");

const senderId = reserved.sender.id;

// Simulasikan transfer gagal dan order masuk review manual
await prisma.transfer.update({
  where: { id: reserved.transfer.id },
  data: { status: "FAILED", errorCode: "RECEIVER_LIMIT", attemptCount: 3 },
});

await prisma.order.update({
  where: { id: order.id },
  data: { status: "MANUAL_REVIEW" },
});

const before = await prisma.senderAccount.findUniqueOrThrow({
  where: { id: senderId },
});

await adminCancelOrder(order.id, "TEST_ADMIN", "Tes pengembalian kuota");

const after = await prisma.senderAccount.findUniqueOrThrow({
  where: { id: senderId },
});

const events = await prisma.orderEvent.count({
  where: { orderId: order.id, eventType: "QUOTA_RELEASED" },
});

const ok =
  before.dailyUsed - after.dailyUsed === 100 &&
  before.monthlyUsed - after.monthlyUsed === 100 &&
  events === 1;

console.log(
  `${ok ? "✅ LULUS" : "❌ GAGAL"}: dailyUsed ${before.dailyUsed} → ${after.dailyUsed}, ` +
    `monthlyUsed ${before.monthlyUsed} → ${after.monthlyUsed}, event=${events}`,
);

await prisma.$disconnect();