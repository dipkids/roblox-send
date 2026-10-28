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

const token = (process.env.DISCORD_TOKEN || "").trim();
const clientId = (process.env.CLIENT_ID || "").trim();
const guildId = (process.env.GUILD_ID || "").trim();

if (!token) {
  throw new Error("DISCORD_TOKEN belum diatur di file .env.");
}

if (!clientId) {
  throw new Error("CLIENT_ID belum diatur di file .env.");
}

if (!guildId) {
  throw new Error("GUILD_ID belum diatur di file .env.");
}

const commands = [
  orderCommand.toJSON(),
  visendRateCommand.toJSON(),
  visendMinCommand.toJSON(),
  visendCustomCommand.toJSON(),
  adminReviewCommand.toJSON(),
  senderCommand.toJSON(),
];

const rest = new REST({ version: "10" });

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    rest.setToken(token);
    console.log(`Mendaftarkan slash commands ke server ${guildId} (percobaan ${attempt})...`);

    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );

    console.log("✅ Slash commands berhasil didaftarkan ke Discord.");
    break;
  } catch (error: any) {
    if (error?.status === 401 || error?.rawError?.message === "401: Unauthorized") {
      console.error(
        "❌ Error 401: Unauthorized!\n" +
        "Token bot (DISCORD_TOKEN) di file .env salah atau sudah kadaluarsa.\n" +
        "Silakan buka Discord Developer Portal > Bot > Reset Token, lalu salin token baru ke .env.",
      );
      break;
    }

    console.error(`❌ Gagal mendaftarkan slash commands (percobaan ${attempt}):`, error?.message || error);
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
