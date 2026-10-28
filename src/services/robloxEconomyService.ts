import "dotenv/config";
import dns from "node:dns";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { prisma } from "../database/prisma.js";

export interface RobloxSenderValidation {
  valid: boolean;
  userId?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  robuxBalance?: number;
  transferLimits?: {
    perTransferLimit: number;
    dailyLimit: number;
    monthlyLimit: number;
    dailyUsed: number;
    monthlyUsed: number;
    dailyRemaining: number;
    monthlyRemaining: number;
  };
  error?: string;
}

// ============================================================
// VALIDASI COOKIE DAN TARIK DATA ECONOMY ROBLOX SECARA OTOMATIS
// ============================================================

export async function validateAndFetchRobloxSender(
  cookie: string,
  expectedUsername?: string,
): Promise<RobloxSenderValidation> {
  const cleanCookie = cookie.trim();

  if (!cleanCookie) {
    return { valid: false, error: "Cookie .ROBLOSECURITY tidak boleh kosong." };
  }

  try {
    // 1. Ambil Identitas Akun
    const userRes = await fetch("https://users.roblox.com/v1/users/authenticated", {
      headers: {
        Cookie: `.ROBLOSECURITY=${cleanCookie}`,
        Accept: "application/json",
      },
    });

    if (!userRes.ok) {
      if (userRes.status === 401) {
        return { valid: false, error: "Cookie tidak valid atau sesi sudah kadaluarsa (401 Unauthorized)." };
      }
      return { valid: false, error: `Gagal memverifikasi user Roblox: HTTP ${userRes.status}` };
    }

    const userData = (await userRes.json()) as {
      id: number;
      name: string;
      displayName: string;
    };

    const userId = String(userData.id);
    const username = userData.name;
    const displayName = userData.displayName;

    // 2. Cocokkan Username jika diberikan
    if (expectedUsername && expectedUsername.trim()) {
      const cleanExpected = expectedUsername.trim().replace(/^@/, "").toLowerCase();
      if (username.toLowerCase() !== cleanExpected) {
        return {
          valid: false,
          error: `Username tidak cocok! Cookie terautentikasi sebagai '@${username}' (ID: ${userId}), bukan '@${expectedUsername}'.`,
        };
      }
    }

    // 3. Ambil Saldo Robux Real-Time dari API Economy Roblox
    let robuxBalance = 0;
    try {
      const economyRes = await fetch(`https://economy.roblox.com/v1/users/${userId}/currency`, {
        headers: {
          Cookie: `.ROBLOSECURITY=${cleanCookie}`,
          Accept: "application/json",
        },
      });

      if (economyRes.ok) {
        const ecoData = (await economyRes.json()) as { robux?: number };
        robuxBalance = ecoData.robux ?? 0;
      }
    } catch (e) {
      console.warn("⚠️ Gagal mengambil saldo dari Economy API:", e);
    }

    // 4. Ambil Limit Transfer Roblox Plus
    let perTransferLimit = 500;
    let dailyLimit = 500;
    let monthlyLimit = 1000;
    try {
      const limitRes = await fetch("https://apis.roblox.com/transfer/v1/robux-transfer/user-transfer-limit", {
        headers: {
          Cookie: `.ROBLOSECURITY=${cleanCookie}`,
          Accept: "application/json",
          Referer: "https://www.roblox.com/",
        },
      });

      if (limitRes.ok) {
        const limitData = (await limitRes.json()) as {
          perTransferLimit?: number;
          dailyLimit?: number;
          monthlyLimit?: number;
        };
        if (typeof limitData.perTransferLimit === "number") perTransferLimit = limitData.perTransferLimit;
        if (typeof limitData.dailyLimit === "number") dailyLimit = limitData.dailyLimit;
        if (typeof limitData.monthlyLimit === "number") monthlyLimit = limitData.monthlyLimit;
      }
    } catch (e) {
      console.warn("⚠️ Gagal mengambil user-transfer-limit:", e);
    }

    // 5. Ambil Pemakaian Otomatis dari Roblox Transaction-Totals (My Transactions)
    // Sesuai endpoint resmi: economy.roblox.com/v2/users/{userId}/transaction-totals
    let dailyUsed = 0;
    let monthlyUsed = 0;
    try {
      const [dayRes, monthRes] = await Promise.all([
        fetch(`https://economy.roblox.com/v2/users/${userId}/transaction-totals?timeFrame=Day&transactionType=summary`, {
          headers: {
            Cookie: `.ROBLOSECURITY=${cleanCookie}`,
            Accept: "application/json",
            Referer: "https://www.roblox.com/",
          },
        }),
        fetch(`https://economy.roblox.com/v2/users/${userId}/transaction-totals?timeFrame=Month&transactionType=summary`, {
          headers: {
            Cookie: `.ROBLOSECURITY=${cleanCookie}`,
            Accept: "application/json",
            Referer: "https://www.roblox.com/",
          },
        }),
      ]);

      if (dayRes.ok) {
        const dayData = (await dayRes.json()) as { outgoingRobuxTransferTotal?: number };
        dailyUsed = Math.abs(dayData.outgoingRobuxTransferTotal ?? 0);
      }

      if (monthRes.ok) {
        const monthData = (await monthRes.json()) as { outgoingRobuxTransferTotal?: number };
        monthlyUsed = Math.abs(monthData.outgoingRobuxTransferTotal ?? 0);
      }
    } catch (e) {
      console.warn("⚠️ Gagal memanggil transaction-totals:", e);
    }

    // 6. Ambil Foto Avatar
    let avatarUrl = "";
    try {
      const thumbRes = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
      );
      if (thumbRes.ok) {
        const thumbData = (await thumbRes.json()) as {
          data?: { imageUrl?: string }[];
        };
        avatarUrl = thumbData.data?.[0]?.imageUrl ?? "";
      }
    } catch {
      // Abaikan jika thumbnail gagal
    }

    const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
    const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

    return {
      valid: true,
      userId,
      username,
      displayName,
      avatarUrl,
      robuxBalance,
      transferLimits: {
        perTransferLimit,
        dailyLimit,
        monthlyLimit,
        dailyUsed,
        monthlyUsed,
        dailyRemaining,
        monthlyRemaining,
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Terjadi kesalahan saat memeriksa cookie Roblox.",
    };
  }
}

// ============================================================
// SIMPAN COOKIE KE FILE .ENV & PROCESS.ENV SECARA AMAN
// ============================================================

export function saveSenderCookie(robloxUserId: string, cookie: string): void {
  const key = `ROBLOX_COOKIE_${robloxUserId}`;
  const cleanCookie = cookie.trim();

  process.env[key] = cleanCookie;

  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  let envContent = fs.readFileSync(envPath, "utf8");
  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${cleanCookie}`);
  } else {
    envContent = envContent.trimEnd() + `\r\n${key}=${cleanCookie}\r\n`;
  }

  fs.writeFileSync(envPath, envContent, "utf8");
  console.log(`💾 Cookie untuk sender ${robloxUserId} berhasil disimpan di .env.`);
}

// ============================================================
// HAPUS COOKIE DARI FILE .ENV & PROCESS.ENV
// ============================================================

export function deleteSenderCookie(robloxUserId: string): void {
  const key = `ROBLOX_COOKIE_${robloxUserId}`;
  delete process.env[key];

  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  let envContent = fs.readFileSync(envPath, "utf8");
  const regex = new RegExp(`^${key}=.*(\r?\n)?`, "m");

  envContent = envContent.replace(regex, "");
  fs.writeFileSync(envPath, envContent, "utf8");
  console.log(`🗑️ Cookie untuk sender ${robloxUserId} berhasil dihapus dari .env.`);
}

// ============================================================
// AMBIL & SINKRONKAN SALDO REAL-TIME UNTUK SEMUA SENDER
// ============================================================

export async function getSendersLiveEconomy() {
  const senders = await prisma.senderAccount.findMany({
    orderBy: { id: "asc" },
  });

  const results = await Promise.all(
    senders.map(async (sender) => {
      const cookie =
        process.env[`ROBLOX_COOKIE_${sender.robloxUserId}`] ??
        process.env.ROBLOX_TEST_COOKIE;

      let robuxBalance: number | null = null;
      let avatarUrl = "";
      let actualDailyUsed = sender.dailyUsed;
      let actualMonthlyUsed = sender.monthlyUsed;
      let actualDailyLimit = sender.dailyLimit;
      let actualMonthlyLimit = sender.monthlyLimit;

      if (cookie) {
        // Tarik saldo
        try {
          const res = await fetch(`https://economy.roblox.com/v1/users/${sender.robloxUserId}/currency`, {
            headers: {
              Cookie: `.ROBLOSECURITY=${cookie}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(5000),
          });

          if (res.ok) {
            const data = (await res.json()) as { robux?: number };
            robuxBalance = data.robux ?? null;
          }
        } catch {
          // Abaikan
        }

        // Tarik limit resmi
        try {
          const limitRes = await fetch("https://apis.roblox.com/transfer/v1/robux-transfer/user-transfer-limit", {
            headers: {
              Cookie: `.ROBLOSECURITY=${cookie}`,
              Accept: "application/json",
              Referer: "https://www.roblox.com/",
            },
            signal: AbortSignal.timeout(5000),
          });
          if (limitRes.ok) {
            const limData = (await limitRes.json()) as { dailyLimit?: number; monthlyLimit?: number };
            if (typeof limData.dailyLimit === "number") actualDailyLimit = limData.dailyLimit;
            if (typeof limData.monthlyLimit === "number") actualMonthlyLimit = limData.monthlyLimit;
          }
        } catch {
          // Abaikan
        }

        // Tarik pemakaian harian & bulanan dari My Transactions (transaction-totals)
        try {
          const [dayRes, monthRes] = await Promise.all([
            fetch(`https://economy.roblox.com/v2/users/${sender.robloxUserId}/transaction-totals?timeFrame=Day&transactionType=summary`, {
              headers: {
                Cookie: `.ROBLOSECURITY=${cookie}`,
                Accept: "application/json",
                Referer: "https://www.roblox.com/",
              },
              signal: AbortSignal.timeout(5000),
            }),
            fetch(`https://economy.roblox.com/v2/users/${sender.robloxUserId}/transaction-totals?timeFrame=Month&transactionType=summary`, {
              headers: {
                Cookie: `.ROBLOSECURITY=${cookie}`,
                Accept: "application/json",
                Referer: "https://www.roblox.com/",
              },
              signal: AbortSignal.timeout(5000),
            }),
          ]);

          if (dayRes.ok) {
            const dayData = (await dayRes.json()) as { outgoingRobuxTransferTotal?: number };
            actualDailyUsed = Math.abs(dayData.outgoingRobuxTransferTotal ?? 0);
          }

          if (monthRes.ok) {
            const monthData = (await monthRes.json()) as { outgoingRobuxTransferTotal?: number };
            actualMonthlyUsed = Math.abs(monthData.outgoingRobuxTransferTotal ?? 0);
          }

          // Sinkronkan data aktual ke database Prisma
          await prisma.senderAccount.update({
            where: { id: sender.id },
            data: {
              dailyUsed: actualDailyUsed,
              monthlyUsed: actualMonthlyUsed,
              dailyLimit: actualDailyLimit,
              monthlyLimit: actualMonthlyLimit,
            },
          });
        } catch {
          // Abaikan jika timeout
        }
      }

      // Ambil avatar
      try {
        const thumbRes = await fetch(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${sender.robloxUserId}&size=100x100&format=Png&isCircular=false`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (thumbRes.ok) {
          const thumbData = (await thumbRes.json()) as { data?: { imageUrl?: string }[] };
          avatarUrl = thumbData.data?.[0]?.imageUrl ?? "";
        }
      } catch {
        // Abaikan
      }

      return {
        id: sender.id,
        accountName: sender.accountName,
        robloxUserId: sender.robloxUserId,
        status: sender.status,
        robuxBalance,
        avatarUrl,
        dailyUsed: actualDailyUsed,
        dailyLimit: actualDailyLimit,
        dailyRemaining: Math.max(0, actualDailyLimit - actualDailyUsed),
        monthlyUsed: actualMonthlyUsed,
        monthlyLimit: actualMonthlyLimit,
        monthlyRemaining: Math.max(0, actualMonthlyLimit - actualMonthlyUsed),
        hasCookie: Boolean(cookie),
        updatedAt: sender.updatedAt,
      };
    }),
  );

  return results;
}

// ============================================================
// RENDER GAMBAR STRUK TRANSAKSI ROBLOX (SEPERTI GAMBAR DOKJA)
// ============================================================

export async function renderRobloxReceiptCard(params: {
  senderUsername: string;
  senderAvatarUrl?: string;
  receiverUsername: string;
  receiverAvatarUrl?: string;
  robuxAmount: number;
  referenceId: string;
  dateStr?: string;
}): Promise<Buffer> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 300 },
    });

    const defaultAvatar =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="75" fill="#e8eaed"/><circle cx="75" cy="55" r="30" fill="#9aa0a6"/><ellipse cx="75" cy="130" rx="50" ry="35" fill="#9aa0a6"/></svg>',
      );
    const senderImg = params.senderAvatarUrl || defaultAvatar;
    const receiverImg = params.receiverAvatarUrl || defaultAvatar;
    const dateFormatted =
      params.dateStr ||
      new Intl.DateTimeFormat("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }).format(new Date()) + " WIB";

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  body { background: transparent; padding: 10px; display: flex; justify-content: center; }
  .receipt-card {
    background: #ffffff;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    width: 820px;
    padding: 16px 24px;
    color: #393b3d;
  }
  .table-header {
    display: grid;
    grid-template-columns: 200px 1fr 120px;
    padding-bottom: 12px;
    font-size: 14px;
    color: #606469;
    font-weight: 500;
  }
  .table-header .col-right { text-align: right; }
  .table-body {
    display: grid;
    grid-template-columns: 200px 1fr 120px;
    align-items: center;
    padding: 14px 0;
    border-top: 1px solid #f0f0f2;
    border-bottom: 1px solid #f0f0f2;
  }
  .user-cell {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    object-fit: cover;
    background: #e8eaed;
  }
  .username {
    font-size: 15px;
    font-weight: 500;
    color: #191b1d;
  }
  .desc-cell {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    color: #191b1d;
    font-weight: 400;
  }
  .desc-cell strong {
    font-weight: 600;
  }
  .amount-cell {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    font-size: 16px;
    font-weight: 600;
    color: #191b1d;
  }
  .robux-icon {
    width: 18px;
    height: 18px;
  }
  .receipt-footer {
    margin-top: 14px;
    font-size: 11px;
    color: #7b8086;
    line-height: 1.5;
  }
</style>
</head>
<body>
  <div class="receipt-card" id="card">
    <div class="table-header">
      <div>Sumber</div>
      <div>Deskripsi</div>
      <div class="col-right">Jumlah</div>
    </div>
    <div class="table-body">
      <div class="user-cell">
        <img class="avatar" src="${senderImg}" alt="${params.senderUsername}">
        <span class="username">${params.senderUsername}</span>
      </div>
      <div class="desc-cell">
        <img class="avatar" src="${receiverImg}" alt="${params.receiverUsername}">
        <span>Mengirim Robux kepada <strong>${params.receiverUsername}</strong>.</span>
      </div>
      <div class="amount-cell">
        <svg class="robux-icon" viewBox="0 0 24 24" fill="none" stroke="#191b1d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="6 2 18 2 22 12 18 22 6 22 2 12"></polygon>
          <polygon points="9 8 15 8 17 12 15 16 9 16 7 12"></polygon>
        </svg>
        <span>${params.robuxAmount.toLocaleString("id-ID")}</span>
      </div>
    </div>
    <div class="receipt-footer">
      <div>Ringkasan transaksi otomatis · ${dateFormatted}</div>
      <div>Referensi: ${params.referenceId}</div>
    </div>
  </div>
</body>
</html>
`;

    await page.setContent(html, { waitUntil: "networkidle" });
    const cardHandle = await page.$("#card");
    if (!cardHandle) {
      throw new Error("Gagal merender card elemen struk.");
    }

    const buffer = await cardHandle.screenshot({ type: "png" });
    return buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}
