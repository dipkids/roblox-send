import "dotenv/config";
import {
  estimateUsage,
  fetchTransferRecords,
  matchTransfer,
} from "./services/robloxTransactionService.js";

const userId = process.argv[2];

if (!userId) {
  throw new Error(
    "Gunakan: npx tsx src/testRobloxRecords.ts <senderUserId> [transferRequestId receiverId amount]",
  );
}

const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
const result = await fetchTransferRecords(userId, since);

if (!result.ok) {
  console.log("GAGAL:", result.reason);
  process.exit(1);
}

console.log(`Record 31 hari terakhir: ${result.value.length}`);
console.log("Perkiraan pemakaian:", estimateUsage(result.value));

const [, , , requestId, receiverId, amount] = process.argv;

if (requestId) {
  console.log(
    "Pencocokan:",
    matchTransfer(result.value, {
      transferRequestId: requestId,
      receiverRobloxId: receiverId ?? "",
      robuxAmount: Number(amount ?? 0),
    }),
  );
}