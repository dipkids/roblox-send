import "dotenv/config";
import { prisma } from "./database/prisma.js";
import { createOrder, OrderValidationError } from "./services/orderService.js";

const base = {
  discordUserId: `test-limit-${Date.now()}`,
  discordUsername: "tester",
  robloxUserId: 1,
  robloxUsername: "Roblox",
  robloxDisplayName: "Roblox",
  avatarUrl: "",
  rate: 160,
};

async function expectReject(name: string, robuxAmount: number) {
  try {
    await createOrder({ ...base, robuxAmount });
    console.log(`❌ ${name}: seharusnya ditolak`);
  } catch (error) {
    console.log(
      error instanceof OrderValidationError
        ? `✅ ${name}`
        : `❌ ${name}: error lain → ${error}`,
    );
  }
}

await expectReject("1 Robux ditolak", 1);
await expectReject("150 Robux ditolak", 150);
await expectReject("6000 Robux ditolak", 6000);

await createOrder({ ...base, robuxAmount: 100 });
await createOrder({ ...base, robuxAmount: 100 });

await expectReject("Order ketiga ditolak (batas order terbuka)", 100);

await prisma.$disconnect();