import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { prisma } from "./database/prisma.js";
import {
  notifyAdminOrder,
  setNotificationClient,
  type AdminNotifyKind,
} from "./services/adminNotificationService.js";

const orderId = Number(process.argv[2]);
const kind = process.argv[3] as AdminNotifyKind;

if (!orderId || !["SENDER_LIMIT", "RECEIVER_LIMIT", "MANUAL_REVIEW"].includes(kind)) {
  throw new Error(
    "Gunakan: npx tsx src/testNotify.ts <orderId> <SENDER_LIMIT|RECEIVER_LIMIT|MANUAL_REVIEW>",
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(process.env.DISCORD_TOKEN);
setNotificationClient(client);

await notifyAdminOrder({ orderId, kind, detail: "Tes notifikasi manual" });

await client.destroy();
await prisma.$disconnect();