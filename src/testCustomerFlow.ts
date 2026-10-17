import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { prisma } from "./database/prisma.js";
import { createOrderTicket } from "./services/ticketService.js";
import { setNotificationClient } from "./services/adminNotificationService.js";
import { fulfillPaidOrder } from "./services/orderFulfillmentService.js";

const discordUserId = process.argv[2];
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const categoryId = process.env.TICKET_CATEGORY_ID;

if (!discordUserId || !token || !guildId || !categoryId) {
  throw new Error(
    "Gunakan: npx tsx src/testCustomerFlow.ts <discordUserId> " +
      "(butuh DISCORD_TOKEN, GUILD_ID, TICKET_CATEGORY_ID di .env)",
  );
}

const template = await prisma.order.findFirst();

if (!template) throw new Error("Butuh template order untuk profil Roblox.");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ready = new Promise<void>((resolve) =>
  client.once("ready", () => resolve()),
);

await client.login(token);
await ready;
setNotificationClient(client);

const user = await prisma.user.upsert({
  where: { discordUserId },
  update: {},
  create: { discordUserId, discordUsername: "tester" },
});

const order = await prisma.order.create({
  data: {
    orderNumber: `AV-TEST-FLOW-${Date.now()}`,
    userId: user.id,
    robloxProfileId: template.robloxProfileId,
    robuxAmount: 100,
    productPrice: 16000,
    totalAmount: 16000,
    status: "PAID",
  },
});

await createOrderTicket({
  client,
  guildId,
  orderId: order.id,
  orderNumber: order.orderNumber,
  discordUserId,
  discordUsername: "tester",
  robloxUsername: "tester",
  robuxAmount: 100,
  totalAmount: 16000,
  categoryId,
});

const result = await fulfillPaidOrder(order.id);

console.log(`Order ${order.id} (${order.orderNumber}):`, {
  success: result.success,
  reason: "reason" in result ? result.reason : null,
});

await client.destroy();
await prisma.$disconnect();