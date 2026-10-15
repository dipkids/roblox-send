import "dotenv/config";

import {
  findAvailableSender,
} from "./services/senderService.js";

async function main() {
  const robuxAmount = 5000;

  console.log(
    `Mencari sender untuk ${robuxAmount} Robux...`,
  );

  const result =
    await findAvailableSender(
      robuxAmount,
    );

  if (!result) {
    console.log(
      "❌ Tidak ada sender yang tersedia.",
    );
    return;
  }

  console.log("✅ Sender ditemukan!");
  console.log("--------------------------------");

  console.log(
    "Sender:",
    result.sender.accountName,
  );

  console.log(
    "Roblox User ID:",
    result.sender.robloxUserId,
  );

  console.log(
    "Status:",
    result.sender.status,
  );

  console.log(
    "Daily Limit:",
    result.sender.dailyLimit,
  );

  console.log(
    "Daily Used:",
    result.dailyUsed,
  );

  console.log(
    "Daily Remaining:",
    result.dailyRemaining,
  );

  console.log(
    "Monthly Limit:",
    result.sender.monthlyLimit,
  );

  console.log(
    "Monthly Used:",
    result.monthlyUsed,
  );

  console.log(
    "Monthly Remaining:",
    result.monthlyRemaining,
  );

  console.log("--------------------------------");
}

main().catch((error) => {
  console.error(
    "❌ Test error:",
    error,
  );

  process.exit(1);
});