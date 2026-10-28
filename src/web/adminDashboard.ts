import { Router, Request, Response, NextFunction } from "express";
import { getDashboardOverview } from "../services/adminDashboardService.js";
import { addSender, SenderAdminError } from "../services/senderAdminService.js";
import {
  validateAndFetchRobloxSender,
  saveSenderCookie,
  deleteSenderCookie,
  getSendersLiveEconomy,
} from "../services/robloxEconomyService.js";
import { prisma } from "../database/prisma.js";

const router = Router();

// ======================================================
// AUTH MIDDLEWARE
// ======================================================

function requireDashboardToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const expected = process.env.ADMIN_DASHBOARD_TOKEN;

  const isLocal =
    req.ip === "127.0.0.1" ||
    req.ip === "::1" ||
    req.hostname === "localhost";

  if (!expected && !isLocal) {
    res.status(503).send("ADMIN_DASHBOARD_TOKEN belum diatur di .env.");
    return;
  }

  const provided =
    (req.query.token as string | undefined) ??
    req.header("x-dashboard-token");

  if (expected && provided !== expected && !isLocal) {
    res.status(401).send("Unauthorized: Token dashboard tidak valid.");
    return;
  }

  next();
}

router.use(requireDashboardToken);

// ======================================================
// JSON API
// ======================================================

// 1. Overview Dashboard
router.get("/api/overview", async (_req: Request, res: Response) => {
  try {
    const data = await getDashboardOverview();
    res.json(data);
  } catch (error) {
    console.error("❌ Gagal mengambil overview dashboard:", error);
    res.status(500).json({ error: "Gagal mengambil data overview." });
  }
});

// 2. Live Economy Data untuk Semua Sender
router.get("/api/senders/live-economy", async (_req: Request, res: Response) => {
  try {
    const senders = await getSendersLiveEconomy();
    res.json({ success: true, senders });
  } catch (error) {
    console.error("❌ Gagal mengambil live economy sender:", error);
    res.status(500).json({ error: "Gagal memuat saldo economy sender." });
  }
});

// 3. Verifikasi Cookie & Ambil Info Akun + Saldo + Limit Harian/Bulanan Otomatis
router.post("/api/senders/verify-cookie", async (req: Request, res: Response) => {
  try {
    const { cookie, expectedUsername } = req.body as {
      cookie?: string;
      expectedUsername?: string;
    };

    if (!cookie || !cookie.trim()) {
      res.status(400).json({ success: false, error: "Cookie .ROBLOSECURITY wajib diisi." });
      return;
    }

    const result = await validateAndFetchRobloxSender(cookie, expectedUsername);

    if (!result.valid) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ Gagal memverifikasi cookie:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Terjadi kesalahan internal.",
    });
  }
});

// 4. Tambah / Simpan Sender Lengkap dengan Cookie & Limit Otomatis
router.post("/api/senders/add-with-cookie", async (req: Request, res: Response) => {
  try {
    const {
      cookie,
      accountName,
      robloxUserId,
      dailyLimit,
      monthlyLimit,
      dailyUsed,
      monthlyUsed,
      adminLabel,
    } = req.body as {
      cookie: string;
      accountName: string;
      robloxUserId: string;
      dailyLimit?: number;
      monthlyLimit?: number;
      dailyUsed?: number;
      monthlyUsed?: number;
      adminLabel?: string;
    };

    if (!cookie || !accountName || !robloxUserId) {
      res.status(400).json({
        success: false,
        error: "Cookie, nama akun, dan Roblox User ID wajib disertakan.",
      });
      return;
    }

    const dLimit = Number(dailyLimit) > 0 ? Number(dailyLimit) : 500;
    const mLimit = Number(monthlyLimit) > 0 ? Number(monthlyLimit) : 1000;
    const dUsed = Number(dailyUsed) >= 0 ? Number(dailyUsed) : 0;
    const mUsed = Number(monthlyUsed) >= 0 ? Number(monthlyUsed) : 0;
    const label = (adminLabel ?? "WebDashboard").trim();

    // Simpan cookie ke .env & process.env
    saveSenderCookie(robloxUserId, cookie);

    // Cek apakah sender sudah ada di database
    let sender = await prisma.senderAccount.findUnique({
      where: { robloxUserId },
    });

    if (!sender) {
      sender = await addSender(
        {
          accountName: accountName.trim(),
          robloxUserId: robloxUserId.trim(),
          dailyLimit: dLimit,
          monthlyLimit: mLimit,
        },
        `WEB:${label}`,
      );

      // Update pemakaian terdeteksi
      sender = await prisma.senderAccount.update({
        where: { id: sender.id },
        data: {
          dailyUsed: dUsed,
          monthlyUsed: mUsed,
        },
      });
    } else {
      sender = await prisma.senderAccount.update({
        where: { id: sender.id },
        data: {
          accountName: accountName.trim(),
          status: "ACTIVE",
          dailyLimit: dLimit,
          monthlyLimit: mLimit,
          dailyUsed: dUsed,
          monthlyUsed: mUsed,
        },
      });
    }

    res.status(200).json({ success: true, sender });
  } catch (error) {
    if (error instanceof SenderAdminError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    console.error("❌ Gagal menyimpan sender dengan cookie:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Terjadi kesalahan internal.",
    });
  }
});

// 5. HAPUS AKUN SENDER (FITUR BARU)
router.delete("/api/senders/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const sender = await prisma.senderAccount.findUnique({
      where: { id },
      include: {
        transfers: {
          where: { status: { in: ["PENDING", "PROCESSING"] } },
        },
      },
    });

    if (!sender) {
      res.status(404).json({ success: false, error: "Akun sender tidak ditemukan." });
      return;
    }

    if (sender.transfers.length > 0) {
      res.status(400).json({
        success: false,
        error: "Tidak dapat menghapus sender yang sedang memproses order aktif (PENDING/PROCESSING).",
      });
      return;
    }

    // Hapus relasi audit log & transfer riwayat dari database
    await prisma.$transaction(async (tx) => {
      await tx.transfer.deleteMany({ where: { senderAccountId: id } });
      await tx.senderAuditLog.deleteMany({ where: { senderAccountId: id } });
      await tx.senderAccount.delete({ where: { id } });
    });

    // Hapus cookie dari file .env & memori
    deleteSenderCookie(sender.robloxUserId);

    console.log(`🗑️ Sender #${id} (@${sender.accountName}) berhasil dihapus.`);
    res.json({
      success: true,
      message: `Akun sender #${id} (@${sender.accountName}) dan cookienya berhasil dihapus.`,
    });
  } catch (error) {
    console.error("❌ Gagal menghapus sender:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Gagal menghapus sender.",
    });
  }
});

// ======================================================
// HALAMAN HTML DASHBOARD
// ======================================================

router.get("/dashboard", (req: Request, res: Response) => {
  const token = (req.query.token as string | undefined) ?? "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPage(token));
});

function renderPage(token: string): string {
  const safeToken = token.replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AutoVisend — Roblox Economy & Sender Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-border: #30363d;
    --text: #f0f6fc;
    --muted: #8b949e;
    --accent: #58a6ff;
    --green: #238636;
    --green-glow: #2ea043;
    --yellow: #d29922;
    --red: #da3633;
    --gold: #f1c40f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--panel-border);
  }
  h1 { font-size: 22px; margin: 0 0 6px; display: flex; align-items: center; gap: 10px; }
  .badge-app { background: #21262d; padding: 2px 8px; border-radius: 6px; font-size: 12px; color: var(--accent); }
  .sub { color: var(--muted); font-size: 13px; margin: 0; }
  .btn-refresh-all {
    background: #21262d;
    color: var(--text);
    border: 1px solid var(--panel-border);
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: 0.2s;
  }
  .btn-refresh-all:hover { background: #30363d; }

  /* CARDS GRID */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 14px;
    margin-bottom: 28px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 16px;
  }
  .card .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 700; color: var(--text); }
  .card .value.green { color: #3fb950; }
  .card .value.warn { color: var(--yellow); }
  .card .value.bad { color: var(--red); }
  .card .value.gold { color: var(--gold); }

  /* SECTION TITLE */
  .sec-title {
    font-size: 16px;
    font-weight: 600;
    margin: 28px 0 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ADD SENDER SECTION */
  .add-panel {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 28px;
  }
  .grid-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  @media (max-width: 800px) { .grid-2col { grid-template-columns: 1fr; } }

  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
  .field input {
    width: 100%;
    background: #0d1117;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 9px 12px;
    color: var(--text);
    font-size: 13px;
    transition: border-color 0.2s;
  }
  .field input:focus { outline: none; border-color: var(--accent); }

  .btn-action {
    background: var(--accent);
    color: #ffffff;
    border: none;
    border-radius: 6px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-action:hover { filter: brightness(1.1); }
  .btn-action:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-save { background: var(--green); }
  .btn-save:hover { background: var(--green-glow); }
  .btn-delete {
    background: rgba(218,54,51,0.15);
    color: #ff7b72;
    border: 1px solid rgba(218,54,51,0.3);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: 0.2s;
  }
  .btn-delete:hover {
    background: var(--red);
    color: #ffffff;
  }

  /* PREVIEW BOX */
  .preview-box {
    background: #0d1117;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 16px;
    display: none;
  }
  .preview-box.active { display: block; }
  .preview-header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .preview-avatar { width: 56px; height: 56px; border-radius: 50%; background: #21262d; border: 2px solid var(--panel-border); }
  .preview-info h3 { margin: 0 0 2px; font-size: 16px; }
  .preview-info p { margin: 0; color: var(--muted); font-size: 12px; }

  .robux-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(241, 196, 15, 0.15);
    color: var(--gold);
    border: 1px solid rgba(241, 196, 15, 0.3);
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 14px;
    margin-top: 6px;
  }

  .stat-badge {
    background: #21262d;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    margin-bottom: 8px;
    display: flex;
    justify-content: space-between;
  }
  .stat-badge strong { color: var(--text); }
  .stat-badge span { color: var(--muted); }

  /* TABLE */
  .table-container {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--panel-border); }
  th { background: #0d1117; color: var(--muted); font-weight: 600; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1c2128; }

  .sender-cell { display: flex; align-items: center; gap: 12px; }
  .sender-avatar { width: 38px; height: 38px; border-radius: 50%; background: #21262d; }
  .sender-names strong { display: block; font-size: 13px; }
  .sender-names span { color: var(--muted); font-size: 11px; }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .status-pill.ACTIVE { background: rgba(46,204,113,0.15); color: #3fb950; }
  .status-pill.MAINTENANCE { background: rgba(241,196,15,0.15); color: var(--yellow); }
  .status-pill.DISABLED { background: rgba(138,143,163,0.15); color: var(--muted); }

  .bar-track { background: #21262d; border-radius: 4px; height: 6px; width: 100%; overflow: hidden; margin-bottom: 4px; }
  .bar-fill { height: 100%; background: var(--accent); }
  .bar-fill.warn { background: var(--yellow); }
  .bar-fill.bad { background: var(--red); }
  .usage-text { color: var(--muted); font-size: 11px; }

  .msg-alert { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-top: 12px; display: none; }
  .msg-alert.err { background: rgba(218,54,51,0.15); color: #ff7b72; border: 1px solid rgba(218,54,51,0.4); display: block; }
  .msg-alert.ok { background: rgba(35,134,54,0.15); color: #3fb950; border: 1px solid rgba(35,134,54,0.4); display: block; }
</style>
</head>
<body>

  <header>
    <div>
      <h1>💎 AutoVisend <span class="badge-app">Roblox Economy Dashboard</span></h1>
      <p class="sub">Manajemen Akun Sender, Deteksi Limit Otomatis (My Transactions), &amp; Saldo Robux Real-time</p>
    </div>
    <button class="btn-refresh-all" onclick="loadAll()">
      <span>🔄</span> Sinkronkan Semua
    </button>
  </header>

  <!-- STATS OVERVIEW -->
  <div class="cards" id="statsGrid">
    <div class="card">
      <div class="label">Total Akun Sender</div>
      <div class="value" id="statTotalSender">-</div>
    </div>
    <div class="card">
      <div class="label">Total Saldo Robux Sender</div>
      <div class="value gold" id="statTotalRobux">⬢ -</div>
    </div>
    <div class="card">
      <div class="label">Pesanan Selesai Hari Ini</div>
      <div class="value green" id="statCompletedToday">-</div>
    </div>
    <div class="card">
      <div class="label">Robux Terkirim Hari Ini</div>
      <div class="value" id="statRobuxSentToday">-</div>
    </div>
  </div>

  <!-- SECTION: TAMBAH SENDER VIA COOKIE -->
  <div class="sec-title">➕ Hubungkan Akun Sender Baru (Deteksi Limit Otomatis)</div>
  <div class="add-panel">
    <div class="grid-2col">
      <!-- Input Form -->
      <div>
        <div class="field">
          <label>Cookie .ROBLOSECURITY Akun Sender</label>
          <input type="password" id="inputCookie" placeholder="_|WARNING:-DO-NOT-SHARE-THIS..." />
        </div>
        <div class="field">
          <label>Cocokkan Username Roblox (Opsional)</label>
          <input type="text" id="inputExpectedUsername" placeholder="Contoh: @PinkyDOKJA" />
        </div>
        <button class="btn-action" id="btnVerifyCookie" onclick="verifyCookie()">
          <span>🔍</span> Periksa Akun, Saldo, &amp; Limit My Transactions
        </button>
        <div id="verifyMsg" class="msg-alert"></div>
      </div>

      <!-- Preview Box -->
      <div class="preview-box" id="previewBox">
        <div class="preview-header">
          <img class="preview-avatar" id="prevAvatar" src="" alt="Avatar" />
          <div class="preview-info">
            <h3 id="prevDisplayName">-</h3>
            <p id="prevUsername">@-</p>
            <div class="robux-badge" id="prevRobuxBadge">⬢ 0 Robux</div>
          </div>
        </div>

        <div class="stat-badge">
          <span>Limit Harian Resmi:</span>
          <strong id="prevDailyLimit">500 R$</strong>
        </div>
        <div class="stat-badge">
          <span>Terpakai Hari Ini (My Transactions):</span>
          <strong style="color:var(--yellow)" id="prevDailyUsed">0 R$</strong>
        </div>
        <div class="stat-badge">
          <span>Sisa Kuota Hari Ini:</span>
          <strong style="color:#3fb950" id="prevDailyRemaining">500 R$</strong>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin: 12px 0;">
          <div class="field" style="margin:0">
            <label>Limit Harian (Robux)</label>
            <input type="number" id="inputDailyLimit" value="500" />
          </div>
          <div class="field" style="margin:0">
            <label>Limit Bulanan (Robux)</label>
            <input type="number" id="inputMonthlyLimit" value="1000" />
          </div>
        </div>

        <button class="btn-action btn-save" id="btnSaveSender" onclick="saveSender()">
          <span>💾</span> Simpan Akun Sender &amp; Aktifkan
        </button>
        <div id="saveMsg" class="msg-alert"></div>
      </div>
    </div>
  </div>

  <!-- SECTION: TABEL AKUN SENDER -->
  <div class="sec-title">📋 Daftar Akun Sender, Saldo, &amp; Kuota Real-Time</div>
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Akun Sender</th>
          <th>Status</th>
          <th>Saldo Robux (Live)</th>
          <th>Limit Harian (My Transactions)</th>
          <th>Limit Bulanan</th>
          <th>Aksi</th>
        </tr>
      </thead>
      <tbody id="senderRows">
        <tr><td colspan="6" style="text-align:center; padding:24px; color:var(--muted)">Memuat data sender...</td></tr>
      </tbody>
    </table>
  </div>

<script>
  const TOKEN = "${safeToken}";
  const fmt = (n) => Number(n ?? 0).toLocaleString("id-ID");
  let verifiedData = null;

  async function loadAll() {
    await Promise.all([loadOverview(), loadLiveSenders()]);
  }

  async function loadOverview() {
    try {
      const res = await fetch(\`/admin/api/overview?token=\${encodeURIComponent(TOKEN)}\`);
      if (!res.ok) return;
      const data = await res.json();
      const s = data.stats;

      document.getElementById("statTotalSender").textContent = \`\${s.activeSenderCount} Aktif / \${s.totalSenderCount}\`;
      document.getElementById("statCompletedToday").textContent = fmt(s.completedToday);
      document.getElementById("statRobuxSentToday").textContent = \`\${fmt(s.robuxSentToday)} R$\`;
    } catch (e) {
      console.error(e);
    }
  }

  async function loadLiveSenders() {
    try {
      const res = await fetch(\`/admin/api/senders/live-economy?token=\${encodeURIComponent(TOKEN)}\`);
      if (!res.ok) return;
      const data = await res.json();
      const senders = data.senders || [];

      let totalRobux = 0;
      let hasAnyRobux = false;

      const rowsHtml = senders.length ? senders.map(s => {
        if (typeof s.robuxBalance === "number") {
          totalRobux += s.robuxBalance;
          hasAnyRobux = true;
        }

        const dailyRatio = s.dailyLimit > 0 ? Math.min(s.dailyUsed / s.dailyLimit, 1) : 0;
        const monthlyRatio = s.monthlyLimit > 0 ? Math.min(s.monthlyUsed / s.monthlyLimit, 1) : 0;

        return \`
          <tr>
            <td>
              <div class="sender-cell">
                <img class="sender-avatar" src="\${s.avatarUrl || 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot-placeholder/100/100/AvatarHeadshot/Png/noFilter'}" />
                <div class="sender-names">
                  <strong>\${s.accountName}</strong>
                  <span>ID: \${s.robloxUserId}</span>
                </div>
              </div>
            </td>
            <td><span class="status-pill \${s.status}">\${s.status}</span></td>
            <td>
              <div class="robux-badge" style="font-size:13px">
                ⬢ \${s.robuxBalance !== null ? fmt(s.robuxBalance) : 'Gagal cek'} Robux
              </div>
            </td>
            <td>
              <div class="bar-track"><div class="bar-fill \${dailyRatio >= 0.9 ? 'bad' : dailyRatio >= 0.7 ? 'warn' : ''}" style="width:\${(dailyRatio * 100).toFixed(0)}%"></div></div>
              <div class="usage-text">Terpakai: \${fmt(s.dailyUsed)} / \${fmt(s.dailyLimit)} R$ (Sisa: \${fmt(s.dailyRemaining)} R$)</div>
            </td>
            <td>
              <div class="bar-track"><div class="bar-fill \${monthlyRatio >= 0.9 ? 'bad' : monthlyRatio >= 0.7 ? 'warn' : ''}" style="width:\${(monthlyRatio * 100).toFixed(0)}%"></div></div>
              <div class="usage-text">Terpakai: \${fmt(s.monthlyUsed)} / \${fmt(s.monthlyLimit)} R$ (Sisa: \${fmt(s.monthlyRemaining)} R$)</div>
            </td>
            <td>
              <button class="btn-delete" onclick="deleteSender(\${s.id}, '\${s.accountName}')">
                🗑️ Hapus
              </button>
            </td>
          </tr>
        \`;
      }).join("") : '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--muted)">Belum ada akun sender yang terdaftar.</td></tr>';

      document.getElementById("senderRows").innerHTML = rowsHtml;
      document.getElementById("statTotalRobux").textContent = hasAnyRobux ? \`⬢ \${fmt(totalRobux)}\` : "⬢ -";
    } catch (e) {
      console.error(e);
    }
  }

  async function verifyCookie() {
    const cookie = document.getElementById("inputCookie").value.trim();
    const expectedUsername = document.getElementById("inputExpectedUsername").value.trim();
    const btn = document.getElementById("btnVerifyCookie");
    const msg = document.getElementById("verifyMsg");
    const prev = document.getElementById("previewBox");

    if (!cookie) {
      msg.textContent = "Masukkan cookie .ROBLOSECURITY terlebih dahulu.";
      msg.className = "msg-alert err";
      return;
    }

    btn.disabled = true;
    msg.textContent = "Menghubungi API Roblox & mengecek My Transactions...";
    msg.className = "msg-alert ok";

    try {
      const res = await fetch(\`/admin/api/senders/verify-cookie?token=\${encodeURIComponent(TOKEN)}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie, expectedUsername }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        msg.textContent = "❌ " + (json.error || "Gagal memverifikasi cookie.");
        msg.className = "msg-alert err";
        prev.classList.remove("active");
        return;
      }

      verifiedData = json.data;
      const lim = verifiedData.transferLimits;

      msg.textContent = "✅ Akun Roblox terverifikasi! Saldo dan limit berhasil ditarik otomatis.";
      msg.className = "msg-alert ok";

      // Isi preview box
      document.getElementById("prevAvatar").src = verifiedData.avatarUrl;
      document.getElementById("prevDisplayName").textContent = verifiedData.displayName;
      document.getElementById("prevUsername").textContent = \`@\${verifiedData.username} (ID: \${verifiedData.userId})\`;
      document.getElementById("prevRobuxBadge").textContent = \`⬢ \${fmt(verifiedData.robuxBalance)} Robux\`;
      document.getElementById("prevDailyLimit").textContent = \`\${fmt(lim.dailyLimit)} R$\`;
      document.getElementById("prevDailyUsed").textContent = \`\${fmt(lim.dailyUsed)} R$\`;
      document.getElementById("prevDailyRemaining").textContent = \`\${fmt(lim.dailyRemaining)} R$\`;
      document.getElementById("inputDailyLimit").value = lim.dailyLimit;
      document.getElementById("inputMonthlyLimit").value = lim.monthlyLimit;

      prev.classList.add("active");
    } catch (e) {
      msg.textContent = "❌ Terjadi kegagalan koneksi: " + e.message;
      msg.className = "msg-alert err";
    } finally {
      btn.disabled = false;
    }
  }

  async function saveSender() {
    if (!verifiedData) return;

    const cookie = document.getElementById("inputCookie").value.trim();
    const dailyLimit = Number(document.getElementById("inputDailyLimit").value);
    const monthlyLimit = Number(document.getElementById("inputMonthlyLimit").value);
    const btn = document.getElementById("btnSaveSender");
    const msg = document.getElementById("saveMsg");

    btn.disabled = true;
    msg.textContent = "Menyimpan akun dan kuota transaksi ke database...";
    msg.className = "msg-alert ok";

    try {
      const res = await fetch(\`/admin/api/senders/add-with-cookie?token=\${encodeURIComponent(TOKEN)}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cookie,
          accountName: verifiedData.username,
          robloxUserId: verifiedData.userId,
          dailyLimit,
          monthlyLimit,
          dailyUsed: verifiedData.transferLimits.dailyUsed,
          monthlyUsed: verifiedData.transferLimits.monthlyUsed,
          adminLabel: "WebAdmin",
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        msg.textContent = "❌ " + (json.error || "Gagal menyimpan akun.");
        msg.className = "msg-alert err";
        return;
      }

      msg.textContent = \`✅ Akun @\${verifiedData.username} berhasil disimpan dan limit terdeteksi!\`;
      msg.className = "msg-alert ok";

      document.getElementById("inputCookie").value = "";
      document.getElementById("inputExpectedUsername").value = "";
      setTimeout(() => {
        document.getElementById("previewBox").classList.remove("active");
        document.getElementById("verifyMsg").className = "msg-alert";
        document.getElementById("saveMsg").className = "msg-alert";
      }, 3000);

      loadAll();
    } catch (e) {
      msg.textContent = "❌ Gagal menyimpan: " + e.message;
      msg.className = "msg-alert err";
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteSender(id, name) {
    if (!confirm(\`Apakah Anda yakin ingin menghapus akun sender @\${name} (#\${id})?\\n\\nCookie di .env juga akan dihapus.\`)) {
      return;
    }

    try {
      const res = await fetch(\`/admin/api/senders/\${id}?token=\${encodeURIComponent(TOKEN)}\`, {
        method: "DELETE",
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        alert("❌ " + (json.error || "Gagal menghapus sender."));
        return;
      }

      alert(\`✅ \${json.message}\`);
      loadAll();
    } catch (e) {
      alert("❌ Terjadi kegagalan koneksi: " + e.message);
    }
  }

  loadAll();
  setInterval(loadAll, 20000);
</script>
</body>
</html>`;
}

export default router;
