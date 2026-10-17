import "dotenv/config";
import { prisma } from "./database/prisma.js";
import { recoverPendingOrders } from "./services/orderRecoveryService.js";

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

// Skenario A: PAID tanpa transfer
const paidOrder = await prisma.order.create({
  data: { ...base, orderNumber: `AV-TEST-A-${Date.now()}`, status: "PAID" },
});

// Skenario B: VERIFYING dengan transfer SUCCESS
const verifyingOrder = await prisma.order.create({
  data: { ...base, orderNumber: `AV-TEST-B-${Date.now()}`, status: "VERIFYING" },
});

await prisma.transfer.create({
  data: {
    orderId: verifyingOrder.id,
    senderAccountId: sender.id,
    recipientRobloxId: "1",
    robuxAmount: 100,
    status: "SUCCESS",
    externalTransferId: `TEST-${Date.now()}`,
    attemptCount: 1,
    completedAt: new Date(),
  },
});

const before = await prisma.senderAccount.findUnique({
  where: { id: sender.id },
});

console.log(`Order A (PAID): ${paidOrder.id}`);
console.log(`Order B (VERIFYING): ${verifyingOrder.id}`);

// Recovery pertama
await recoverPendingOrders();

// Recovery kedua: order yang sudah COMPLETED tidak boleh diproses lagi
console.log("\n===== RECOVERY KEDUA =====\n");
await recoverPendingOrders();

const after = await prisma.senderAccount.findUnique({
  where: { id: sender.id },
});

let allOk = true;

for (const [label, id] of [
  ["A (PAID)", paidOrder.id],
  ["B (VERIFYING)", verifyingOrder.id],
] as const) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id } });
  const transfers = await prisma.transfer.count({ where: { orderId: id } });
  const completedEvents = await prisma.orderEvent.count({
    where: { orderId: id, eventType: "ORDER_COMPLETED" },
  });

  const ok =
    order.status === "COMPLETED" && transfers === 1 && completedEvents === 1;
  allOk &&= ok;

  console.log(
    `${ok ? "✅" : "❌"} Order ${label}: status=${order.status}, ` +
      `transfer=${transfers}, ORDER_COMPLETED=${completedEvents}`,
  );
}

const delta = (after?.dailyUsed ?? 0) - (before?.dailyUsed ?? 0);
const deltaOk = delta === 100;
allOk &&= deltaOk;

console.log(
  `${deltaOk ? "✅" : "❌"} dailyUsed sender naik ${delta} (harus 100, hanya order A)`,
);
console.log(allOk ? "\n✅ SEMUA LULUS" : "\n❌ ADA YANG GAGAL");

await prisma.$disconnect();