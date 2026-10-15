import "dotenv/config";

import {
  reserveSenderForOrder,
} from "./services/transferService.js";

async function main() {
  const orderId = 8;

  console.log(
    `Testing reservation untuk order ${orderId}...`,
  );

  const result =
    await reserveSenderForOrder(
      orderId,
    );

  if (!result) {
    console.log("❌ Sender tidak tersedia.");
    process.exit(1);
  }

  if (!result.sender) {
    throw new Error(
      "Sender tidak ditemukan pada hasil reservation.",
    );
  }

  console.log(
    "✅ Sender berhasil di-reserve!",
  );

  console.log(
    "--------------------------------",
  );

  console.log(
    "Order:",
    result.order.orderNumber,
  );

  console.log(
    "Sender:",
    result.sender.accountName,
  );

  console.log(
    "Robux:",
    result.transfer.robuxAmount,
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
    "Daily Used:",
    result.sender.dailyUsed,
  );

  console.log(
    "Monthly Used:",
    result.sender.monthlyUsed,
  );

  console.log(
    "Order Status:",
    result.order.status,
  );

  console.log(
    "--------------------------------",
  );
}

main().catch((error) => {
  console.error(
    "❌ Test error:",
    error,
  );

  process.exit(1);
});