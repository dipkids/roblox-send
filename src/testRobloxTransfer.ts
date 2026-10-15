import "dotenv/config";

import {
  executeMockTransfer,
} from "./services/robloxTransferService.js";

async function main() {
  const transferId = 1;

  console.log(
    `Testing mock transfer ${transferId}...`,
  );

  const result =
    await executeMockTransfer(transferId);

  console.log("--------------------------------");
  console.log(
    "Transfer ID:",
    result.id,
  );
  console.log(
    "Transfer Status:",
    result.status,
  );
  console.log(
    "External Transfer ID:",
    result.externalTransferId,
  );
  console.log("--------------------------------");
}

main().catch((error) => {
  console.error("❌ Test error:", error);
  process.exit(1);
});