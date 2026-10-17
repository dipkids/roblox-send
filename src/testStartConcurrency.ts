import "dotenv/config";
import { prisma } from "./database/prisma.js";
import { startTransfer } from "./services/transferExecutor.js";

const orderId = Number(process.argv[2]);

if (!orderId) {
  throw new Error("Gunakan: npx tsx src/testStartConcurrency.ts <orderId>");
}

const results = await Promise.allSettled([
  startTransfer(orderId),
  startTransfer(orderId),
]);

results.forEach((r, i) =>
  console.log(
    `Panggilan ${i + 1}:`,
    r.status,
    r.status === "fulfilled"
      ? `attemptCount=${r.value.transfer.attemptCount}`
      : r.reason?.message,
  ),
);

const transfers = await prisma.transfer.findMany({
  where: { orderId },
  select: { id: true, status: true, attemptCount: true },
});

console.log("Transfer:", transfers);

const ok =
  results.filter((r) => r.status === "fulfilled").length === 1 &&
  transfers.length === 1 &&
  transfers[0].attemptCount === 1;

console.log(ok ? "✅ LULUS" : "❌ GAGAL");

await prisma.$disconnect();