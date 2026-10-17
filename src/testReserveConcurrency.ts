import "dotenv/config";
import { prisma } from "./database/prisma.js";
import { reserveSenderForOrder } from "./services/transferService.js";

// Pinjam user & profil Roblox dari order yang sudah ada
const template = await prisma.order.findFirst();

if (!template) {
  throw new Error("Tidak ada order sebagai template user/profil.");
}

const order = await prisma.order.create({
  data: {
    orderNumber: `AV-TEST-${Date.now()}`,
    userId: template.userId,
    robloxProfileId: template.robloxProfileId,
    robuxAmount: 100,
    productPrice: 0,
    totalAmount: 0,
    status: "PAID",
  },
});

const sendersBefore = await prisma.senderAccount.findMany({
  where: { status: "ACTIVE" },
  select: { id: true, accountName: true, dailyUsed: true, monthlyUsed: true },
});

console.log(`Order uji: ${order.orderNumber} (ID ${order.id})`);
console.log("Sender SEBELUM:", sendersBefore);

const results = await Promise.allSettled([
  reserveSenderForOrder(order.id),
  reserveSenderForOrder(order.id),
]);

results.forEach((r, i) =>
  console.log(
    `Panggilan ${i + 1}:`,
    r.status,
    r.status === "fulfilled"
      ? `alreadyReserved=${r.value?.alreadyReserved}`
      : r.reason?.message,
  ),
);

const transfers = await prisma.transfer.count({
  where: { orderId: order.id },
});

const sendersAfter = await prisma.senderAccount.findMany({
  where: { status: "ACTIVE" },
  select: { id: true, accountName: true, dailyUsed: true, monthlyUsed: true },
});

console.log("Sender SESUDAH:", sendersAfter);
console.log(`Jumlah transfer untuk order uji: ${transfers}`);
console.log(transfers === 1 ? "✅ LULUS" : "❌ GAGAL: transfer ganda");

await prisma.$disconnect();