import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  TextChannel,
  User,
} from "discord.js";

const DB_PATH = path.resolve(process.cwd(), "database.db");

function getDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  // Pastikan tabel dasar ada sesuai schema storesystem.py
  db.exec(`
    CREATE TABLE IF NOT EXISTS buyers (
      user_id INTEGER PRIMARY KEY,
      name TEXT,
      total_spent INTEGER,
      orders INTEGER
    );
    CREATE TABLE IF NOT EXISTS buyer_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      order_number INTEGER,
      amount INTEGER,
      created_at TEXT,
      product TEXT
    );
    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      method TEXT,
      stars INTEGER,
      review TEXT,
      created_at TEXT,
      category TEXT DEFAULT 'public'
    );
  `);
  return db;
}

// =========================================================
// 1. TAMBAH / UPDATE NOMINAL BUYER DI DATABASE.DB
// =========================================================
export function recordBuyerPurchase(params: {
  discordUserId: string;
  discordUsername: string;
  amount: number;
  productName?: string;
}): { orders: number; totalSpent: number; isNewBuyer: boolean } {
  const db = getDb();
  try {
    const userIdBigInt = BigInt(params.discordUserId);
    const product = params.productName || "Robux";

    const selectStmt = db.prepare(
      "SELECT orders, total_spent FROM buyers WHERE user_id = ?",
    );
    const row = selectStmt.get(userIdBigInt) as
      | { orders: number; total_spent: number }
      | undefined;

    let orders = 1;
    let totalSpent = params.amount;
    let isNewBuyer = true;

    if (row) {
      orders = (row.orders || 0) + 1;
      totalSpent = (row.total_spent || 0) + params.amount;
      isNewBuyer = false;

      const updateStmt = db.prepare(
        "UPDATE buyers SET orders = ?, total_spent = ?, name = ? WHERE user_id = ?",
      );
      updateStmt.run(orders, totalSpent, params.discordUsername, userIdBigInt);
    } else {
      const insertStmt = db.prepare(
        "INSERT INTO buyers (user_id, name, total_spent, orders) VALUES (?, ?, ?, ?)",
      );
      insertStmt.run(
        userIdBigInt,
        params.discordUsername,
        totalSpent,
        orders,
      );
    }

    // Catat histori order di buyer_orders
    const insertOrderStmt = db.prepare(
      "INSERT INTO buyer_orders (user_id, order_number, amount, created_at, product) VALUES (?, ?, ?, ?, ?)",
    );
    insertOrderStmt.run(
      userIdBigInt,
      orders,
      params.amount,
      new Date().toISOString(),
      product,
    );

    console.log(
      `📊 Database.db updated: Buyer <@${params.discordUserId}> (${params.discordUsername}) - Order #${orders}, +Rp${params.amount.toLocaleString(
        "id-ID",
      )}, Total: Rp${totalSpent.toLocaleString("id-ID")}`,
    );

    return { orders, totalSpent, isNewBuyer };
  } finally {
    db.close();
  }
}

// =========================================================
// 2. SIMPAN RATING BUYER DI DATABASE.DB
// =========================================================
export function saveBuyerRating(params: {
  discordUserId: string;
  discordUsername: string;
  stars: number;
  review?: string;
  method?: string;
}): number {
  const db = getDb();
  try {
    const userIdBigInt = BigInt(params.discordUserId);
    const stmt = db.prepare(`
      INSERT INTO ratings (user_id, username, method, stars, review, created_at, category)
      VALUES (?, ?, ?, ?, ?, ?, 'public')
    `);
    const result = stmt.run(
      userIdBigInt,
      params.discordUsername,
      params.method || "Robux",
      params.stars,
      params.review || "",
      new Date().toISOString(),
    );
    console.log(
      `⭐ Rating tersimpan di database.db: ${params.discordUsername} memberi ${params.stars} bintang`,
    );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

// Cek apakah order/user sudah dirating
export function isOrderRated(discordUserId: string): boolean {
  const db = getDb();
  try {
    const userIdBigInt = BigInt(discordUserId);
    const row = db
      .prepare(
        "SELECT id FROM ratings WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(userIdBigInt);
    return Boolean(row);
  } finally {
    db.close();
  }
}

// =========================================================
// 3. SINKRONISASI ROLE MEMBER DISCORD
// =========================================================
export async function syncBuyerRoles(params: {
  guild: Guild;
  member: GuildMember;
  totalSpent: number;
}) {
  const { guild, member, totalSpent } = params;

  const roleCustomer =
    process.env.ROLE_CUSTOMER ||
    process.env.BUYER_ROLE_ID ||
    "1514538379784618039";
  const role500k = process.env.ROLE_500K || "1514538379784618040";
  const role1jt = process.env.ROLE_1JT || "1514538379784618041";
  const role5jt = process.env.ROLE_5JT || "1514538379784618042";
  const role25jt = process.env.ROLE_25JT || "1514538379784618043";
  const topSpenderRole =
    process.env.TOP_SPENDER_ROLE_ID || "1514538379792875621";

  // Role Customer
  if (roleCustomer && !member.roles.cache.has(roleCustomer)) {
    await member.roles.add(roleCustomer).catch(() => {});
  }

  // Role 500K+
  if (role500k) {
    if (totalSpent >= 500_000 && !member.roles.cache.has(role500k)) {
      await member.roles.add(role500k).catch(() => {});
    }
  }

  // Role 1JT+
  if (role1jt) {
    if (totalSpent >= 1_000_000 && !member.roles.cache.has(role1jt)) {
      await member.roles.add(role1jt).catch(() => {});
    }
  }

  // Role 5JT+
  if (role5jt) {
    if (totalSpent >= 5_000_000 && !member.roles.cache.has(role5jt)) {
      await member.roles.add(role5jt).catch(() => {});
    }
  }

  // Role 25JT+
  if (role25jt) {
    if (totalSpent >= 25_000_000 && !member.roles.cache.has(role25jt)) {
      await member.roles.add(role25jt).catch(() => {});
    }
  }

  // Update Top Spender Role 👑 (Rank 1 di database)
  if (topSpenderRole) {
    try {
      const db = getDb();
      const topBuyer = db
        .prepare(
          "SELECT CAST(user_id AS TEXT) AS user_id FROM buyers ORDER BY total_spent DESC LIMIT 1",
        )
        .get() as { user_id: string } | undefined;
      db.close();

      if (topBuyer) {
        const topUserId = topBuyer.user_id;
        const role = guild.roles.cache.get(topSpenderRole);
        if (role) {
          // Lepaskan dari pemegang lama jika bukan top spender lagi
          for (const [mId, m] of role.members) {
            if (mId !== topUserId) {
              await m.roles.remove(role).catch(() => {});
            }
          }
          // Berikan ke nomor 1
          const topMember = await guild.members.fetch(topUserId).catch(() => null);
          if (topMember && !topMember.roles.cache.has(topSpenderRole)) {
            await topMember.roles.add(topSpenderRole).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn("⚠️ Gagal sinkronisasi Top Spender role:", err);
    }
  }
}

// =========================================================
// 4. FORMAT DAN KIRIM EMBED VOUCH (PERSIS SEPERTI GAMBAR 3)
// =========================================================
export async function sendVouchEmbed(params: {
  client: Client;
  buyerUser: User;
  orderNumber: string;
  totalAmount: number;
  robuxAmount: number;
  stars: number;
  review?: string;
  productName?: string;
}) {
  const {
    client,
    buyerUser,
    orderNumber,
    totalAmount,
    stars,
    review,
    productName,
  } = params;

  const targetChannelId =
    process.env.TESTIMONI_CHANNEL_ID ||
    process.env.VOUCH_CHANNEL_ID ||
    process.env.ADMIN_ALERT_CHANNEL_ID ||
    "1514538380975931401";

  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(
        `⚠️ Channel testimoni ${targetChannelId} tidak ditemukan / bukan text channel.`,
      );
      return;
    }

    const shortId = crypto.randomBytes(4).toString("hex");
    const starString = "⭐".repeat(Math.max(1, Math.min(5, stars)));
    const cleanReview =
      review && review.trim().length > 0
        ? `"${review.trim()}"`
        : '"gacor"';

    const embed = new EmbedBuilder()
      .setColor(0xfee75c) // Warna Kuning/Gold persis Gambar 3
      .setAuthor({
        name: buyerUser.displayName || buyerUser.username,
        iconURL: buyerUser.displayAvatarURL(),
      })
      .setTitle("💎 New Vouch! 💎")
      .addFields(
        {
          name: "◆ Pembeli",
          value: `<@${buyerUser.id}>`,
          inline: true,
        },
        {
          name: "◆ Order",
          value: productName || "Robux",
          inline: true,
        },
        {
          name: "◆ Nominal",
          value: `Rp ${totalAmount.toLocaleString("id-ID")}`,
          inline: true,
        },
        {
          name: "◆ Rating",
          value: `${starString} (${stars}/5)`,
          inline: true,
        },
        {
          name: "◆ Status",
          value: "Selesai ✅",
          inline: true,
        },
        {
          name: "📝 Ulasan",
          value: cleanReview,
          inline: false,
        },
      )
      .setThumbnail(buyerUser.displayAvatarURL())
      .setFooter({
        text: `Terima kasih telah berbelanja di Takemi Store • ID: ${shortId}`,
      })
      .setTimestamp();

    await (channel as TextChannel).send({ embeds: [embed] });
    console.log(
      `✅ Embed vouch berhasil dikirim ke channel <#${targetChannelId}> untuk order #${orderNumber}`,
    );
  } catch (error) {
    console.error("❌ Gagal mengirim embed vouch testimoni:", error);
  }
}

// =========================================================
// 5. UPDATE BUYER LEADERBOARD MESSAGE DI DISCORD
// =========================================================
export async function refreshLeaderboardMessage(
  client: Client,
  guildId: string,
) {
  const db = getDb();
  let buyers: Array<{ user_id: string; total_spent: number; orders: number }> =
    [];
  try {
    const rows = db
      .prepare(
        "SELECT CAST(user_id AS TEXT) AS user_id, total_spent, orders FROM buyers ORDER BY total_spent DESC",
      )
      .all() as Array<{
      user_id: string;
      total_spent: number;
      orders: number;
    }>;
    buyers = rows;
  } finally {
    db.close();
  }

  const channelId = process.env.LEADERBOARD_CHANNEL_ID;
  const messageId = process.env.LEADERBOARD_MESSAGE_ID;

  if (!channelId || !messageId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const msg = await (channel as TextChannel).messages.fetch(messageId);
    if (!msg) return;

    const totalBuyers = buyers.length;
    const totalSpentAll = buyers.reduce(
      (sum, b) => sum + (Number(b.total_spent) || 0),
      0,
    );
    const totalOrdersAll = buyers.reduce(
      (sum, b) => sum + (Number(b.orders) || 0),
      0,
    );

    const formatIdr = (n: number) => n.toLocaleString("id-ID");

    const header =
      `👥 **${formatIdr(totalBuyers)}** buyer  •  ` +
      `🛒 **${formatIdr(totalOrdersAll)}** order  •  ` +
      `💰 **Rp${formatIdr(totalSpentAll)}**`;

    const medals = ["🥇", "🥈", "🥉"];
    const topRows = buyers.slice(0, 10);

    const podium: string[] = [];
    const rest: string[] = [];

    topRows.forEach((b, idx) => {
      const rank = idx + 1;
      const spent = Number(b.total_spent) || 0;
      const ord = Number(b.orders) || 0;
      if (rank <= 3) {
        podium.push(
          `${medals[rank - 1]} <@${b.user_id}>\n` +
            `╰ **Rp${formatIdr(spent)}** • ${ord} order`,
        );
      } else {
        rest.push(
          `\`${String(rank).padStart(2, " ")}.\` <@${b.user_id}>\n` +
            `╰ **Rp${formatIdr(spent)}** • ${ord} order`,
        );
      }
    });

    const parts = [header, "─────────────────────"];
    if (podium.length > 0) parts.push(podium.join("\n\n"));
    if (podium.length > 0 && rest.length > 0) parts.push("─────────────────────");
    if (rest.length > 0) parts.push(rest.join("\n"));

    const embed = new EmbedBuilder()
      .setTitle("🏆 TAKEMI STORE • TOP SPENDER")
      .setColor(0xffd700)
      .setDescription(parts.join("\n").slice(0, 4000))
      .setFooter({
        text: "Halaman 1 • Update otomatis tiap ada order • Takemi Store",
      });

    await msg.edit({ embeds: [embed] });
    console.log(`🏆 Leaderboard message #${messageId} berhasil diperbarui.`);
  } catch (err) {
    // Abaikan jika pesan leaderboard belum disetup
  }
}
