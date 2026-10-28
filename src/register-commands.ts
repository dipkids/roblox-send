import "dotenv/config";
import dns from "node:dns";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

import {
  REST,
  Routes,
} from "discord.js";

import { data as orderCommand } from "./commands/order.js";
import { data as visendRateCommand } from "./commands/visendRate.js";
import { data as visendMinCommand } from "./commands/visendMin.js";
import { data as visendCustomCommand } from "./commands/visendCustom.js";
import { data as adminReviewCommand } from "./commands/adminReview.js";
import { data as senderCommand } from "./commands/sender.js";

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
  visendMinCommand.toJSON(),
  visendCustomCommand.toJSON(),
  adminReviewCommand.toJSON(),
  senderCommand.toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    console.log(`Mendaftarkan slash commands (percobaan ${attempt})...`);

    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );

    console.log("✅ Slash commands berhasil didaftarkan.");
    break;
  } catch (error) {
    console.error(`❌ Gagal mendaftarkan slash commands (percobaan ${attempt}):`, error);
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
