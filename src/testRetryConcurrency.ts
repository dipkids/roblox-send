import { retryFailedTransfer } from "./services/transferRetryService.js";

const orderId = Number(process.argv[2]);

if (!orderId) {
  throw new Error(
    "Gunakan: npx tsx src/testRetryConcurrency.ts <orderId>",
  );
}

console.log(`🚀 Menjalankan retry 2x secara bersamaan untuk Order ${orderId}...`);

const [result1, result2] = await Promise.allSettled([
  retryFailedTransfer(orderId),
  retryFailedTransfer(orderId),
]);

console.log("\n========== RESULT 1 ==========");
console.dir(result1, { depth: null });

console.log("\n========== RESULT 2 ==========");
console.dir(result2, { depth: null });