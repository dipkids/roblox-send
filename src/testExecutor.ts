import "dotenv/config";

import { startTransfer } from "./services/transferExecutor.js";

async function main() {
  const orderId = 8;

  console.log(
    `Testing transfer executor untuk order ${orderId}...`,
  );

  const result =
    await startTransfer(orderId);

  console.log("✅ Transfer berhasil dimulai!");
  console.log("--------------------------------");
  console.log(
    "Order:",
    result.order.orderNumber,
  );
  console.log(
    "Transfer ID:",
    result.transfer.id,
  );
  console.log(
    "Transfer Status:",
    result.transfer.status,
  );
  console.log(
    "Attempt:",
    result.transfer.attemptCount,
  );
  console.log("--------------------------------");
}

main().catch((error) => {
  console.error("❌ Test error:", error);
  process.exit(1);
});