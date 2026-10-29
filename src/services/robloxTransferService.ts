import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import { prisma } from "../database/prisma.js";
import { sendTicketTurnArrivedEmbed } from "./ticketService.js";
import { getNotificationClient } from "./adminNotificationService.js";

interface MockTransferOptions {
  simulateFailure?: boolean;
  failureMessage?: string;
}

interface TransferExecutionResult {
  success: boolean;
  externalTransferId?: string;
  errorCode?: string;
  errorMessage?: string;
}

// Mutex sederhana agar automasi browser akun Roblox tidak berjalan secara bersamaan
let isBrowserBusy = false;

export function isRobloxBrowserBusy(): boolean {
  return isBrowserBusy;
}

// ============================================================
// REAL ROBLOX+ / ROVALRA PLAYWRIGHT TRANSFER
// ============================================================

export async function executeRobloxPlusTransfer(
  transferId: number,
): Promise<any> {
  let waitedInQueue = false;
  if (isBrowserBusy) {
    waitedInQueue = true;
    console.log(`⏳ Transfer ${transferId} mengantre menunggu browser Playwright selesai...`);
  }
  while (isBrowserBusy) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  isBrowserBusy = true;

  if (waitedInQueue) {
    console.log(`🚀 Giliran tiba untuk Transfer ${transferId}! Memulai Playwright transfer...`);
    try {
      const notifClient = getNotificationClient();
      const tr = await prisma.transfer.findUnique({
        where: { id: transferId },
        select: { orderId: true },
      });
      if (notifClient && tr?.orderId) {
        await sendTicketTurnArrivedEmbed({
          client: notifClient,
          orderId: tr.orderId,
        }).catch(() => {});
      }
    } catch {}
  }

  try {
    const transfer = await prisma.transfer.findUnique({
      where: {
        id: transferId,
      },
      include: {
        order: {
          include: {
            robloxProfile: true,
            user: true,
          },
        },
        senderAccount: true,
      },
    });

    if (!transfer) {
      throw new Error(`Transfer ${transferId} tidak ditemukan.`);
    }

    if (transfer.status !== "PROCESSING") {
      throw new Error(
        `Transfer ${transferId} tidak dalam status PROCESSING. Status saat ini: ${transfer.status}`,
      );
    }

    const { recipientRobloxId, robuxAmount, senderAccount } = transfer;
    const rawExtensionPath = process.env.ROVALRA_PATH || "./rovalra/RoValra/dist";
    const extensionPath = path.resolve(process.cwd(), rawExtensionPath);

    if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
      throw new Error(
        `Folder extension RoValra tidak ditemukan atau tidak berisi manifest.json di: ${extensionPath}. Periksa konfigurasi ROVALRA_PATH di .env.`,
      );
    }

    const sessionCookie =
      process.env[`ROBLOX_COOKIE_${senderAccount.robloxUserId}`] ??
      process.env.ROBLOX_TEST_COOKIE;

    if (!sessionCookie) {
      throw new Error(
        `Cookie untuk sender ID ${senderAccount.robloxUserId} (ROBLOX_COOKIE_${senderAccount.robloxUserId}) belum diatur di .env`,
      );
    }

    const profileDir = path.resolve(
      process.env.ROBLOX_PROFILE_DIR ||
        `.browser-profile/sender-${senderAccount.robloxUserId}`,
    );
    const isHeadless = process.env.ROBLOX_BROWSER_HEADLESS !== "false";

    console.log("========================================");
    console.log("🚀 ROBLOX+ AUTOMATION TRANSFER");
    console.log("========================================");
    console.log(`Order: ${transfer.order.orderNumber}`);
    console.log(
      `Sender: ${senderAccount.accountName} (${senderAccount.robloxUserId})`,
    );
    console.log(
      `Recipient: ${transfer.order.robloxProfile.username} (${recipientRobloxId})`,
    );
    console.log(`Robux: ${robuxAmount}`);
    console.log("========================================");

    let context: BrowserContext | null = null;
    let transferResult: TransferExecutionResult;

    try {
      // Catatan penting untuk Playwright & Chromium extensions:
      // Di Playwright, 'headless: true' menggunakan mode headless lama yang menonaktifkan ekstensi.
      // Agar ekstensi Chrome (RoValra) aktif di lingkungan server/VPS tanpa GUI,
      // kita gunakan 'headless: false' yang dipadukan dengan argumen '--headless=new'.
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--headless=new",
          "--disable-blink-features=AutomationControlled",
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      await context.addCookies([
        {
          name: ".ROBLOSECURITY",
          value: sessionCookie,
          domain: ".roblox.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ]);

      const page = context.pages()[0] ?? (await context.newPage());

      // Saring log dari browser agar log terminal tetap rapi dan bebas dari spam internal ekstensi
      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("status.rovalra.com") ||
          text.includes("apis.rovalra.com") ||
          text.includes("Non-donator lazy mode") ||
          text.includes("heartbeat") ||
          text.includes("Three.js") ||
          text.includes("AngularJS") ||
          text.includes("ApolloClient") ||
          text.includes("Feature.Catalog")
        ) {
          return;
        }
        if (text.includes("RoValra Initialized") || (msg.type() === "error" && text.includes("transfer"))) {
          console.log(`[Browser Console] ${msg.type()}: ${text}`);
        }
      });
      page.on("pageerror", (err) => {
        if (!err.message.includes("signal is aborted") && !err.message.includes("maxAttemptsReached")) {
          console.error(`[Browser PageError]`, err.message);
        }
      });

      // 1. Buka halaman profil Roblox penerima
      console.log(
        `🌐 Membuka profil: https://www.roblox.com/users/${recipientRobloxId}/profile`,
      );
      await page.goto(
        `https://www.roblox.com/users/${recipientRobloxId}/profile`,
        {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        },
      );

      // Berikan jeda yang cukup agar halaman Roblox dan ekstensi RoValra selesai diinjeksi sepenuhnya
      console.log("⏳ Menunggu ekstensi dan halaman selesai dimuat (delay 5s)...");
      await page.waitForTimeout(5000);

      // 1b. Tutup popup Roblox native jika ada (seperti promo Download Roblox di browser Linux)
      try {
        await page.evaluate(() => {
          document
            .querySelectorAll(
              'button[aria-label*="Close" i], button.close, .modal-header button, [data-testid="modal-close-button"], .modal-dialog button',
            )
            .forEach((b) => (b as HTMLElement).click());
          document
            .querySelectorAll('.modal-dialog, .modal-backdrop, [role="dialog"], .download-dialog')
            .forEach((el) => {
              const text = el.textContent || "";
              if (
                text.includes("Download Roblox") ||
                text.includes("Close") ||
                text.includes("Roblox is now loading") ||
                el.classList.contains("modal-backdrop")
              ) {
                el.remove();
              }
            });
          document.body.classList.remove("modal-open");
        });
      } catch {}

      // 1c. Cek dan tutup popup Onboarding RoValra / Roblox+ jika muncul
      try {
        const onboardingBtn = page
          .locator(
            '.rovalra-global-overlay button:has-text("Got it"), .rovalra-global-overlay button:has-text("Got It"), button:has-text("Got It"), button:has-text("Got it")',
          )
          .first();
        if (await onboardingBtn.isVisible({ timeout: 2500 })) {
          console.log("ℹ️ Menutup popup onboarding RoValra...");
          await page.waitForTimeout(1000);
          await onboardingBtn.click({ force: true });
          await page.waitForTimeout(1500);
        }
      } catch {
        // Abaikan jika tidak ada onboarding
      }

      // Bersihkan overlay penghalang yang bukan modal Send Robux
      await page.evaluate(() => {
        document.querySelectorAll(".rovalra-global-overlay").forEach((el) => {
          if (!el.querySelector(".rovalra-sendrobux-content")) {
            console.log("Removing non-sendrobux overlay:", el);
            el.remove();
          }
        });
      }).catch(() => {});

      // 2. Buka menu titik tiga (contextual menu)
      console.log("🖱️ Menunggu tombol menu profil...");
      const menuBtn = page
        .locator(
          '#user-profile-header-contextual-menu-button, button[aria-label="Open contextual menu"], button:has-text("Open contextual menu")',
        )
        .first();
      await menuBtn.waitFor({ state: "visible", timeout: 15000 });
      // Jeda sebelum klik tombol menu agar listener ekstensi siap
      console.log("⏳ Jeda sebelum membuka menu profil...");
      await page.waitForTimeout(2000);
      await menuBtn.click({ force: true });
      console.log("⏳ Menunggu dropdown menu terbuka...");
      await page.waitForTimeout(2500);

      // Tunggu hingga ekstensi RoValra menambahkan tombolnya ke dalam menu
      await page.waitForSelector('div[role="menu"][data-rovalra-send-robux-btn-added="true"], div[role="menu"]', {
        timeout: 10000,
      }).catch(() => {});

      // 3. Klik "Send Robux" yang diinjeksi oleh ekstensi Roblox+ / RoValra
      console.log("🖱️ Mengklik menuitem 'Send Robux'...");
      const sendRobuxMenu = page
        .getByRole("menuitem", { name: /Send Robux/i })
        .or(page.locator('[role="menuitem"]:has-text("Send Robux"), button:has-text("Send Robux"), a:has-text("Send Robux")'))
        .first();
      await sendRobuxMenu.waitFor({ state: "visible", timeout: 15000 });
      // Jeda sebelum klik Send Robux agar halaman stabil dan tidak trigger app deep-link
      console.log("⏳ Jeda sebelum klik tombol Send Robux...");
      await page.waitForTimeout(2000);
      await sendRobuxMenu.click({ force: true });
      console.log("⏳ Menunggu modal Step 1 terbuka...");
      await page.waitForTimeout(2500);

      // Tutup download-dialog jika sempat terpemicu di background
      try {
        await page.evaluate(() => {
          document.querySelectorAll('.download-dialog, .modal-dialog').forEach((el) => {
            if (el.textContent?.includes("Roblox is now loading") || el.textContent?.includes("Download Roblox")) {
              el.remove();
            }
          });
          document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
        });
      } catch {}

      // Cek apakah ada overlay peringatan RoValra (misal 'Plus Needed' atau pesan error)
      try {
        const overlayText = await page.locator(".rovalra-global-overlay").allInnerTexts();
        const joined = overlayText.join(" | ");
        if (joined.toLowerCase().includes("error") || joined.toLowerCase().includes("needed") || joined.toLowerCase().includes("limit")) {
          console.log("ℹ️ Teks peringatan RoValra:", joined);
        }
      } catch {}

      // Tunggu hingga modal Step 1 selesai loading
      await page.waitForSelector('.rovalra-sendrobux-container:not([data-rovalra-sendrobux-loading="true"])', {
        timeout: 10000,
      }).catch(() => {});

      // 4. Masukkan nominal Robux di Modal Step 1
      console.log(`✍️ Mengisi nominal Robux: ${robuxAmount}...`);
      const amountInput = page
        .locator(
          ".rovalra-sendrobux-robuxamount-container input, input[placeholder='0']",
        )
        .first();
      await amountInput.waitFor({ state: "visible", timeout: 15000 });
      await amountInput.click({ force: true });
      await page.waitForTimeout(600);
      await amountInput.fill(String(robuxAmount));

      // Jeda setelah input nominal terisi
      console.log("⏳ Nominal terisi, jeda sebelum lanjut...");
      await page.waitForTimeout(1500);

      const nextBtn = page
        .locator("#rovalra-sendrobux-step1-nextbtn, button:has-text('Next')")
        .first();
      await nextBtn.waitFor({ state: "visible", timeout: 15000 });
      await nextBtn.click({ force: true });
      console.log("⏳ Menunggu modal konfirmasi Step 2...");
      await page.waitForTimeout(2500);

      // Tunggu hingga modal Step 2 selesai fetching relasi akun & rate limit
      await page.waitForSelector('.rovalra-sendrobux-container:not([data-rovalra-sendrobux-loading="true"])', {
        timeout: 15000,
      }).catch(() => {});

      // 5. Konfirmasi Pengiriman di Modal Step 2
      console.log("🖱️ Menunggu tombol konfirmasi Send (Step 2)...");
      const sendBtn = page
        .locator("#rovalra-sendrobux-step2-sendbtn, button:has-text('Send')")
        .first();
      await sendBtn.waitFor({ state: "visible", timeout: 15000 });

      // Monitor respon API transfer Roblox secara langsung dari jaringan browser
      let apiResponseJson: any = null;
      let apiResponseStatus: number | null = null;

      const apiResponsePromise = page
        .waitForResponse(
          (res) =>
            res.url().includes("/robux-transfer/process-transfer") &&
            res.request().method() === "POST",
          { timeout: 25000 },
        )
        .then(async (res) => {
          apiResponseStatus = res.status();
          try {
            apiResponseJson = await res.json();
          } catch {}
          return res;
        })
        .catch(() => null);

      // Jeda sebelum klik Send agar transaksi aman & rate limit check selesai
      console.log("⏳ Jeda sebelum konfirmasi pengiriman Send...");
      await page.waitForTimeout(2000);
      await sendBtn.click({ force: true });
      await page.waitForTimeout(1500);

      // 6. Tangkap hasil dialog: Sukses atau Error
      console.log("⏳ Menunggu respons pengiriman Robux...");
      const successLocator = page
        .getByText(/transfer was a success|transfer was alright/i)
        .or(page.locator('.rovalra-global-overlay').filter({ hasText: /success|alright/i }))
        .first();

      const errorNoticeLocator = page
        .locator(".rovalra-sendrobux-mutednotice.error")
        .first();

      // Parent consent modal memiliki tombol Ask ID: #rovalra-sendrobux-step3-askbtn atau class step3
      const parentConsentLocator = page
        .locator("#rovalra-sendrobux-step3-askbtn, .rovalra-sendrobux-content.step3")
        .or(page.getByText(/Ask for Permission|ask parents for perms/i))
        .first();

      const outcome = await Promise.race([
        apiResponsePromise.then(async (res) => {
          if (!res) return new Promise(() => {}); // Tetap pending jika belum selesai
          if (res.ok()) {
            console.log("📡 API process-transfer Roblox merespons status OK (200)!");
            return "SUCCESS" as const;
          }
          const json = (await res.json().catch(() => null)) as any;
          if (
            json?.ampRecourseActions &&
            json.ampRecourseActions.includes("ParentConsentRecourse")
          ) {
            return "PARENT_CONSENT" as const;
          }
          return "ERROR" as const;
        }),
        successLocator
          .waitFor({ state: "visible", timeout: 25000 })
          .then(() => "SUCCESS" as const),
        errorNoticeLocator
          .waitFor({ state: "visible", timeout: 25000 })
          .then(() => "ERROR" as const),
        parentConsentLocator
          .waitFor({ state: "visible", timeout: 25000 })
          .then(() => "PARENT_CONSENT" as const),
      ]);

      if (outcome === "SUCCESS") {
        let extId: string | null = null;
        try {
          const apiRes = await apiResponsePromise;
          if (apiRes) {
            const urlParts = apiRes.url().split("/");
            const rawId = urlParts[urlParts.length - 1];
            if (rawId && rawId.length > 5) {
              const cleanId = rawId.split("?")[0].split("#")[0].trim();
              extId = cleanId.startsWith("RXT-") ? cleanId : `RXT-${cleanId}`;
            }
          }
        } catch {}

        if (!extId) {
          extId = `RXT-${Math.floor(
            1000000000000000000 + Math.random() * 9000000000000000000,
          )}`;
        }
        console.log(`✅ Transfer berhasil terkirim! Ext ID: ${extId}`);

        // Jeda sebelum klik OK
        await page.waitForTimeout(1500);

        // Klik tombol OK jika ada untuk merapikan modal
        const okBtn = page
          .getByRole("button", { name: /OK|electric boogaloo/i })
          .or(page.locator('.rovalra-global-overlay button:has-text("OK")'))
          .first();
        if (await okBtn.isVisible().catch(() => false)) {
          await okBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(1000);
        }

        transferResult = {
          success: true,
          externalTransferId: extId,
        };
      } else if (outcome === "PARENT_CONSENT") {
        transferResult = {
          success: false,
          errorCode: "PARENT_CONSENT_REQUIRED",
          errorMessage:
            "Akun penerima membutuhkan persetujuan orang tua (Parent Consent Recourse).",
        };
      } else {
        await errorNoticeLocator
          .waitFor({ state: "visible", timeout: 4000 })
          .catch(() => {});
        const domErrorText = (
          (await errorNoticeLocator.textContent().catch(() => null)) ?? ""
        ).trim();
        const apiErrorText =
          apiResponseJson?.errorMessage || apiResponseJson?.failureReason;
        const errorText =
          domErrorText || apiErrorText || "Unknown transfer error";
        console.warn(
          `⚠️ Error notifikasi Roblox+: ${errorText} (API Status: ${apiResponseStatus})`,
        );

        let classifiedCode = "TRANSFER_FAILED";
        const combined =
          `${errorText} ${apiResponseJson?.failureReason ?? ""} ${apiResponseJson?.errorMessage ?? ""}`.toLowerCase();

        if (
          combined.includes("limit") ||
          combined.includes("2-step") ||
          combined.includes("twostep") ||
          combined.includes("verification") ||
          combined.includes("2fa") ||
          combined.includes("parent")
        ) {
          classifiedCode = "RECEIVER_LIMIT";
        } else if (
          combined.includes("not enough") ||
          combined.includes("balance") ||
          combined.includes("sender")
        ) {
          classifiedCode = "INSUFFICIENT_FUNDS";
        }

        transferResult = {
          success: false,
          errorCode: classifiedCode,
          errorMessage: errorText,
        };
      }
    } catch (browserError) {
      console.error("❌ Terjadi kegagalan automasi browser:", browserError);
      let detectedErrorCode = "AUTOMATION_BROWSER_ERROR";
      let detectedErrorMessage =
        browserError instanceof Error
          ? browserError.message
          : String(browserError);

      if (context) {
        try {
          const pages = context.pages();
          if (pages.length > 0) {
            const page0 = pages[0];
            await page0.screenshot({
              path: `transfer-error-${transfer.id}.png`,
              fullPage: true,
            });
            console.log(`📸 Screenshot browser error tersimpan di transfer-error-${transfer.id}.png`);

            const noticeText = (
              await page0
                .locator(".rovalra-sendrobux-mutednotice.error")
                .first()
                .textContent()
                .catch(() => null)
            )?.trim();

            if (noticeText) {
              const lowerNotice = noticeText.toLowerCase();
              if (
                lowerNotice.includes("limit") ||
                lowerNotice.includes("2-step") ||
                lowerNotice.includes("verification") ||
                lowerNotice.includes("2fa")
              ) {
                detectedErrorCode = "RECEIVER_LIMIT";
                detectedErrorMessage = noticeText;
              }
            }
          }
        } catch {}
      }
      transferResult = {
        success: false,
        errorCode: detectedErrorCode,
        errorMessage: detectedErrorMessage,
      };
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }

    // Update Database sesuai hasil
    if (transferResult.success) {
      const updatedTransfer = await prisma.$transaction(
        async (tx) => {
          const t = await tx.transfer.update({
            where: { id: transfer.id },
            data: {
              status: "SUCCESS",
              externalTransferId: transferResult.externalTransferId,
              completedAt: new Date(),
            },
          });

          await tx.order.update({
            where: { id: transfer.orderId },
            data: { status: "VERIFYING" },
          });

          await tx.orderEvent.create({
            data: {
              orderId: transfer.orderId,
              eventType: "TRANSFER_SUCCESS",
              oldStatus: "PROCESSING",
              newStatus: "VERIFYING",
              description:
                "Transfer Robux via fitur Send Roblox+ berhasil dikirim.",
              metadata: {
                transferId: transfer.id,
                externalTransferId: transferResult.externalTransferId,
                robuxAmount: transfer.robuxAmount,
              },
            },
          });

          return t;
        },
        {
          maxWait: 30000,
          timeout: 30000,
        },
      );

      return updatedTransfer;
    } else {
      const failedTransfer = await prisma.$transaction(
        async (tx) => {
          const t = await tx.transfer.update({
            where: { id: transfer.id },
            data: {
              status: "FAILED",
              errorCode: transferResult.errorCode ?? "TRANSFER_FAILED",
              errorMessage:
                transferResult.errorMessage ?? "Gagal mengirim Robux.",
            },
          });

          await tx.order.update({
            where: { id: transfer.orderId },
            data: { status: "TRANSFER_FAILED" },
          });

          await tx.orderEvent.create({
            data: {
              orderId: transfer.orderId,
              eventType: "TRANSFER_FAILED",
              oldStatus: "PROCESSING",
              newStatus: "TRANSFER_FAILED",
              description: `Transfer Robux via Roblox+ gagal: ${transferResult.errorMessage}`,
              metadata: {
                transferId: transfer.id,
                senderAccountId: transfer.senderAccountId,
                robuxAmount: transfer.robuxAmount,
                errorCode: transferResult.errorCode,
                errorMessage: transferResult.errorMessage,
              },
            },
          });

          return t;
        },
        {
          maxWait: 30000,
          timeout: 30000,
        },
      );

      return failedTransfer;
    }
  } finally {
    isBrowserBusy = false;
  }
}

// ============================================================
// MOCK ROBLOX TRANSFER (Untuk Testing / Fallback)
// ============================================================

export async function executeMockTransfer(
  transferId: number,
  options: MockTransferOptions = {},
) {
  const transfer = await prisma.transfer.findUnique({
    where: {
      id: transferId,
    },
    include: {
      order: true,
      senderAccount: true,
    },
  });

  if (!transfer) {
    throw new Error(`Transfer ${transferId} tidak ditemukan.`);
  }

  if (transfer.status !== "PROCESSING") {
    throw new Error(`Transfer ${transferId} tidak dalam status PROCESSING.`);
  }

  console.log("================================");
  console.log("MOCK ROBLOX TRANSFER");
  console.log("================================");
  console.log("Order:", transfer.order.orderNumber);
  console.log("Sender:", transfer.senderAccount.accountName);
  console.log("Recipient Roblox ID:", transfer.recipientRobloxId);
  console.log("Robux:", transfer.robuxAmount);
  console.log("================================");

  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (options.simulateFailure) {
    const failureMessage =
      options.failureMessage ?? "Simulasi transfer gagal.";

    const errorCode =
      process.env.MOCK_TRANSFER_FAIL_CODE ?? "MOCK_TRANSFER_FAILED";

    console.log("❌ MOCK TRANSFER GAGAL.");
    console.log("Error:", failureMessage);

    const failedTransfer = await prisma.$transaction(
      async (tx) => {
        const updatedTransfer = await tx.transfer.update({
          where: {
            id: transfer.id,
          },
          data: {
            status: "FAILED",
            errorCode,
            errorMessage: failureMessage,
          },
        });

        await tx.order.update({
          where: {
            id: transfer.orderId,
          },
          data: {
            status: "TRANSFER_FAILED",
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId: transfer.orderId,
            eventType: "TRANSFER_FAILED",
            oldStatus: "PROCESSING",
            newStatus: "TRANSFER_FAILED",
            description: "Mock transfer gagal.",
            metadata: {
              transferId: transfer.id,
              senderAccountId: transfer.senderAccountId,
              robuxAmount: transfer.robuxAmount,
              errorCode,
              errorMessage: failureMessage,
            },
          },
        });

        return updatedTransfer;
      },
      {
        maxWait: 30000,
        timeout: 30000,
      },
    );

    return failedTransfer;
  }

  const externalTransferId = `MOCK-${Date.now()}-${transfer.id}`;

  const result = await prisma.$transaction(
    async (tx) => {
      const updatedTransfer = await tx.transfer.update({
        where: {
          id: transfer.id,
        },
        data: {
          status: "SUCCESS",
          externalTransferId,
          completedAt: new Date(),
        },
      });

      await tx.order.update({
        where: {
          id: transfer.orderId,
        },
        data: {
          status: "VERIFYING",
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: transfer.orderId,
          eventType: "TRANSFER_SUCCESS",
          oldStatus: "PROCESSING",
          newStatus: "VERIFYING",
          description:
            "Mock transfer berhasil. Order masuk tahap verifikasi.",
          metadata: {
            transferId: transfer.id,
            externalTransferId,
            robuxAmount: transfer.robuxAmount,
          },
        },
      });

      return updatedTransfer;
    },
    {
      maxWait: 30000,
      timeout: 30000,
    },
  );

  console.log("✅ Mock transfer berhasil.");
  console.log("External Transfer ID:", externalTransferId);

  return result;
}

// ============================================================
// MAIN TRANSFER DISPATCHER
// ============================================================

export async function executeTransfer(
  transferId: number,
  mockOptions?: MockTransferOptions,
) {
  const isMock =
    process.env.USE_MOCK_TRANSFER === "true" ||
    process.env.MOCK_TRANSFER === "true" ||
    Boolean(mockOptions?.simulateFailure);

  if (isMock) {
    return executeMockTransfer(transferId, mockOptions);
  }

  return executeRobloxPlusTransfer(transferId);
}
