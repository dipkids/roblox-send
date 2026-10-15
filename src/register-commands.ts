import "dotenv/config";
import {
  REST,
  Routes,
} from "discord.js";

import { data as orderCommand } from "./commands/order.js";
import { data as visendRateCommand } from "./commands/visendRate.js";
import { data as adminReviewCommand } from "./commands/adminReview.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  throw new Error("DISCORD_TOKEN belum diatur.");
}

if (!clientId) {
  throw new Error("CLIENT_ID belum diatur.");
}

if (!guildId) {
  throw new Error("GUILD_ID belum diatur.");
}

const commands = [
  orderCommand.toJSON(),
  visendRateCommand.toJSON(),
  adminReviewCommand.toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);

try {
  console.log("Mendaftarkan slash commands...");

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
  );

  console.log("✅ Slash commands berhasil didaftarkan.");
} catch (error) {
  console.error("❌ Gagal mendaftarkan slash commands:", error);
}