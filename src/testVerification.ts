import "dotenv/config";

import {
  verifyTransfer,
} from "./services/transferVerificationService.js";

async function main() {
  const transferId = 12;

  console.log(
    `Testing verification untuk transfer ${transferId}...`,
  );

  const result =
    await verifyTransfer(transferId);

  console.log("--------------------------------");
  console.log(
    "Order:",
    result.orderNumber,
  );
  console.log(
    "Order Status:",
    result.status,
  );
  console.log(
    "Completed At:",
    result.completedAt,
  );
  console.log("--------------------------------");
}

main().catch((error) => {
  console.error("❌ Test error:", error);
  process.exit(1);
});