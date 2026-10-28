import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import { prisma } from "../database/prisma.js";

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

// ============================================================
// REAL ROBLOX+ / ROVALRA PLAYWRIGHT TRANSFER
// ============================================================

export async function executeRobloxPlusTransfer(
  transferId: number,
): Promise<any> {
  while (isBrowserBusy) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  isBrowserBusy = true;

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
      context = await chromium.launchPersistentContext(profileDir, {
        headless: isHeadless,
        viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          ...(isHeadless ? ["--headless=new"] : []),
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

      // Tunggu sesaat agar halaman dan ekstensi RoValra selesai diinjeksi
      console.log("⏳ Menunggu ekstensi dan halaman selesai dimuat...");
      await page.waitForTimeout(2500);

      // 1b. Cek dan tutup popup Onboarding RoValra / Roblox+ jika muncul
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
      // Jeda sebelum klik tombol menu
      await page.waitForTimeout(1200);
      await menuBtn.click({ force: true });
      console.log("⏳ Menunggu dropdown menu terbuka...");
      await page.waitForTimeout(1500);

      // 3. Klik "Send Robux" yang diinjeksi oleh ekstensi Roblox+ / RoValra
      console.log("🖱️ Mengklik menuitem 'Send Robux'...");
      const sendRobuxMenu = page
        .getByRole("menuitem", { name: /Send Robux/i })
        .or(page.locator('[role="menuitem"]:has-text("Send Robux"), button:has-text("Send Robux"), a:has-text("Send Robux")'))
        .first();
      await sendRobuxMenu.waitFor({ state: "visible", timeout: 15000 });
      // Jeda sebelum klik Send Robux
      await page.waitForTimeout(1200);
      await sendRobuxMenu.click({ force: true });
      console.log("⏳ Menunggu modal Step 1 terbuka...");
      await page.waitForTimeout(2000);

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
      const apiResponsePromise = page
        .waitForResponse(
          (res) =>
            res.url().includes("/robux-transfer/process-transfer") &&
            res.request().method() === "POST",
          { timeout: 25000 },
        )
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
              extId = rawId.startsWith("RXT-") ? rawId : `RXT-${rawId}`;
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
        const errorText =
          (await errorNoticeLocator.textContent()) ?? "Unknown transfer error";
        console.warn(`⚠️ Error notifikasi Roblox+: ${errorText}`);

        let classifiedCode = "TRANSFER_FAILED";
        const lower = errorText.toLowerCase();

        if (
          lower.includes("limit") ||
          lower.includes("2-step") ||
          lower.includes("verification")
        ) {
          classifiedCode = "RECEIVER_LIMIT";
        } else if (
          lower.includes("not enough") ||
          lower.includes("balance")
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
      transferResult = {
        success: false,
        errorCode: "AUTOMATION_BROWSER_ERROR",
        errorMessage:
          browserError instanceof Error
            ? browserError.message
            : String(browserError),
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
