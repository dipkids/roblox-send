import "dotenv/config";
import dns from "node:dns";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

import express from "express";

import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  Interaction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import {
  saveBuyerRating,
  isOrderRated,
  sendVouchEmbed,
} from "./services/storeDatabaseService.js";

import * as visendRateCommand from "./commands/visendRate.js";
import * as visendMinCommand from "./commands/visendMin.js";
import * as visendCustomCommand from "./commands/visendCustom.js";
import * as orderCommand from "./commands/order.js";
import * as adminReviewCommand from "./commands/adminReview.js";

import { showCustomOrderModal } from "./modals/customOrder.js";
import { showRobloxProfileModal } from "./modals/robloxProfile.js";

import { findRobloxUser } from "./services/robloxService.js";
import { showRobloxConfirmation } from "./buttons/robloxConfirm.js";

import { prisma } from "./database/prisma.js";
import { getRobuxRate } from "./services/rateService.js";
import { getMinRobuxAmount } from "./services/minOrderService.js";
import { isCustomOrderEnabled } from "./services/customOrderSettingService.js";
import { getSenderStockStatus } from "./services/senderService.js";
import { OrderValidationError, createOrder, isValidRobuxAmount, } from "./services/orderService.js";
import { createOrderTicket, sendOrderTicketMessage } from "./services/ticketService.js";
import { createDynamicQris } from "./services/paymentService.js";
import { checkSenderForOrder } from "./services/senderService.js";
import { recoverPendingOrders } from "./services/orderRecoveryService.js";

import midtransWebhook, { setDiscordClient } from "./web/midtransWebhook.js";
import { acknowledgeManualReview, getManualReviewOrder } from "./services/adminOrderService.js";
import { setNotificationClient } from "./services/adminNotificationService.js";
import { showAdminActionModal, type AdminActionType } from "./modals/adminAction.js";
import { adminRetryOrder, adminMarkCompleted, adminCancelOrder, } from "./services/adminActionService.js";
import * as senderCommand from "./commands/sender.js";
import adminDashboard from "./web/adminDashboard.js";
import { getSendersLiveEconomy } from "./services/robloxEconomyService.js";
import { refreshOrderPanel } from "./services/orderPanelService.js";

import { showTransferCancelModal } from "./modals/transferCancel.js";
import {
  CustomerFlowError,
  customerCancelOrder,
  customerRequestHelp,
  customerRetryAfter2FA,
  isOrderOwner,
} from "./services/transferFailureService.js";
import {
  runBackgroundWorkers,
  reconcilePayments,
  checkAndFulfillOrderPayment,
} from "./services/reconciliationService.js";

// ==============================
// ENV
// ==============================

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error(
    "DISCORD_TOKEN belum diatur di file .env",
  );
}

// ==============================
// CLIENT
// ==============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ],
});

setDiscordClient(client);
setNotificationClient(client);

client.on("error", (error) => {
  console.error("❌ Discord client error:", error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "❌ Unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
});

function hasAdminRole(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction,
): boolean {
  if (!interaction.inGuild()) {
    return false;
  }

  // Guild Owner selalu dianggap Admin
  if (interaction.guild?.ownerId === interaction.user.id) {
    return true;
  }

  // Member dengan permission Administrator selalu dianggap Admin
  if (interaction.memberPermissions?.has("Administrator")) {
    return true;
  }

  const adminRoleId = process.env.ADMIN_ROLE_ID;

  if (!adminRoleId) {
    return false;
  }

  const roles = interaction.member?.roles;

  if (!roles) {
    return false;
  }

  return Array.isArray(roles)
    ? roles.includes(adminRoleId)
    : roles.cache.has(adminRoleId);
}

// ==============================
// TEMPORARY ROBLOX PROFILE CACHE
// ==============================

interface CachedRobloxProfile {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
}

const robloxProfileCache = new Map<
  string,
  CachedRobloxProfile
>();
const orderCreationLocks = new Set<string>();

function getProfileCacheKey(
  discordUserId: string,
  robloxUserId: number,
  amount: number,
): string {
  return `${discordUserId}:${robloxUserId}:${amount}`;
}

// ==============================
// BOT READY
// ==============================

client.once("ready", async () => {
  console.log(
    `Bot online sebagai ${client.user?.tag}`,
  );

  try {
    await recoverPendingOrders();
  } catch (error) {
    console.error(
      "❌ Gagal menjalankan order recovery:",
      error,
    );
  }

  // ==============================
  // BACKGROUND WORKERS
  // ==============================
  //
  // Menjalankan tiga tugas berurutan:
  //  - recoverStaleOrders
  //  - reconcilePayments
  //  - escalateStaleCustomerWaits
  // ==============================

  // Fast payment polling: cek pembayaran pending tiap 5 detik agar instan tanpa delay
  setInterval(() => {
    reconcilePayments().catch(() => {});
  }, 5_000);

  setInterval(() => {
    runBackgroundWorkers().catch((error) => {
      console.error(
        "❌ Worker error:",
        error instanceof Error ? error.message : error,
      );
    });
  }, 60_000);

  // 1. Sinkronisasi awal ekonomi sender Roblox & panel order Discord saat bot online
  setTimeout(async () => {
    try {
      console.log("🔄 Melakukan sinkronisasi awal limit sender Roblox & panel order Discord...");
      await getSendersLiveEconomy();
      await refreshOrderPanel(client);
    } catch (err) {
      console.warn("⚠️ Gagal sinkronisasi awal sender / panel order:", err);
    }
  }, 3_000);

  // 2. Auto-sync sender economy Roblox & perbarui panel order di Discord setiap 30 menit
  setInterval(async () => {
    try {
      console.log("⏰ [30 Menit Worker] Sinkronisasi limit Roblox & update panel order Discord...");
      await getSendersLiveEconomy();
      await refreshOrderPanel(client);
    } catch (err) {
      console.warn("⚠️ Gagal worker 30 menit panel order:", err);
    }
  }, 30 * 60 * 1_000);
});

// ==============================
// INTERACTION
// ==============================

async function handleInteraction(interaction: Interaction) {
  if (interaction.isButton()) {
    const age = Date.now() - interaction.createdTimestamp;
    console.log(
      `⏱️ ${interaction.customId} diterima ${age}ms setelah diklik`,
    );
  }

  // ==================================================
  // SLASH COMMAND
  // ==================================================

  if (interaction.isChatInputCommand()) {

    // ==============================
    // /order
    // ==============================

    if (
      interaction.commandName ===
      orderCommand.data.name
    ) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content:
            "⛔ Hanya admin yang dapat memasang atau memperbarui panel order di channel ini.\n" +
            "Untuk membeli Robux, silakan klik tombol nominal pada panel order yang sudah tersedia di channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await orderCommand.execute(interaction);
      return;
    }

    // ==============================
    // /visend_rate
    // ==============================

    if (interaction.commandName === visendRateCommand.data.name) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await visendRateCommand.execute(interaction);
      return;
    }

    // ==============================
    // /visend_min
    // ==============================

    if (interaction.commandName === visendMinCommand.data.name) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await visendMinCommand.execute(interaction);
      return;
    }

    // ==============================
    // /visend_custom
    // ==============================

    if (interaction.commandName === visendCustomCommand.data.name) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await visendCustomCommand.execute(interaction);
      return;
    }

    // ==============================
    // /admin_review
    // ==============================

    if (interaction.commandName === adminReviewCommand.data.name) {
      console.log("📥 Command admin_review diterima.");

      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      console.log("✅ Role admin valid.");

      // Akui interaction segera agar tidak timeout di Discord.
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      try {
        console.log("🔎 Menjalankan adminReviewCommand.execute...");
        await adminReviewCommand.execute(interaction);
        console.log("✅ adminReviewCommand selesai.");
      } catch (error) {
        console.error("❌ Gagal menjalankan admin review:", error);

        await interaction.editReply({
          content:
            "❌ Gagal mengambil daftar order. Periksa koneksi database dan log terminal.",
          embeds: [],
          components: [],
        }).catch(console.error);
      }

      return;
    }
    
    // ==============================
    // /sender
    // ==============================

    if (interaction.commandName === senderCommand.data.name) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await senderCommand.execute(interaction);
      } catch (error) {
        console.error(
          "❌ Gagal menjalankan /sender:",
          error instanceof Error ? error.message : error,
        );

        await interaction
          .editReply({
            content: "❌ Terjadi kesalahan pada perintah /sender. Cek log terminal.",
          })
          .catch(console.error);
      }

      return;
    }

  }

  // ==================================================
  // BUTTON
  // ==================================================

  if (interaction.isButton()) {

    // ==============================
    // ADMIN MANUAL REVIEW
    // ==============================

    if (
      interaction.customId.startsWith(
        "admin_review_",
      )
    ) {
      if (!(await hasAdminRole(interaction))) {
        await interaction.reply({
          content:
            "⛔ Tombol ini hanya dapat digunakan oleh admin.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      // ==============================
      // VIEW ORDER DETAIL
      // ==============================

      if (
        interaction.customId.startsWith(
          "admin_review_view_",
        )
      ) {
        const t0 = Date.now();

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral,
        });

        console.log(
          `⏱️ deferReply selesai dalam ${Date.now() - t0}ms`,
        );

        const orderId = Number(
          interaction.customId.replace(
            "admin_review_view_",
            "",
          ),
        );

        if (
          !Number.isSafeInteger(orderId) ||
          orderId <= 0
        ) {
          await interaction.editReply({
            content: "❌ ID order tidak valid.",
          });

          return;
        }

        let order: Awaited<ReturnType<typeof getManualReviewOrder>>;

        try {
          order = await getManualReviewOrder(orderId);
        } catch (error) {
          console.error(
            `❌ Gagal mengambil detail order ${orderId}:`,
            error instanceof Error ? error.message : error,
          );

          await interaction.editReply({
            content:
              "❌ Gagal mengambil detail order. Database mungkin sedang bermasalah, coba lagi sebentar lagi.",
          });

          return;
        }

        if (!order) {
          await interaction.editReply({
            content:
              "⚠️ Order tidak ditemukan atau sudah tidak berstatus MANUAL_REVIEW. Jalankan `/admin_review` kembali.",
          });

          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(
            `🔎 Pemeriksaan Order ${order.orderNumber}`,
          )
          .setColor(0xF1C40F)
          .addFields(
            {
              name: "Status Order",
              value: order.status,
              inline: true,
            },
            {
              name: "Jumlah Robux",
              value: order.robuxAmount.toLocaleString(
                "id-ID",
              ),
              inline: true,
            },
            {
              name: "Total Pembayaran",
              value:
                `Rp${order.totalAmount.toLocaleString("id-ID")}`,
              inline: true,
            },
            {
              name: "Pemilik Order",
              value:
                `${order.user.discordUsername ?? "Unknown"}\n` +
                `Discord ID: ${order.user.discordUserId}`,
            },
            {
              name: "Profil Roblox",
              value:
                `Username: ${order.robloxProfile.username}\n` +
                `Display Name: ${order.robloxProfile.displayName}\n` +
                `Roblox ID: ${order.robloxProfile.robloxUserId}`,
            },
            {
              name: "Pembayaran",
              value:
                `Status: ${order.payment?.status ?? "Tidak ditemukan"}\n` +
                `Provider: ${order.payment?.provider ?? "N/A"}\n` +
                `Transaction ID: ${order.payment?.transactionId ?? "N/A"}`,
            },
          );

        if (order.transfers.length === 0) {
          embed.addFields({
            name: "Riwayat Transfer",
            value: "Belum ada transfer.",
          });
        } else {
          for (const transfer of order.transfers.slice(0, 5)) {
            embed.addFields({
              name: `Transfer #${transfer.id}`,
              value: [
                `Status: ${transfer.status}`,
                `Sender: ${transfer.senderAccount.accountName}`,
                `Robux: ${transfer.robuxAmount.toLocaleString("id-ID")}`,
                `Percobaan: ${transfer.attemptCount}`,
                `External ID: ${transfer.externalTransferId ?? "N/A"}`,
                `Error: ${transfer.errorCode ?? "N/A"}`,
                `Pesan: ${(transfer.errorMessage ?? "Tidak ada").slice(0, 300)}`,
              ].join("\n"),
            });
          }
        }

        const recentEvents = order.events
          .slice(0, 5)
          .map((event) => {
            return (
              `• ${event.eventType}: ` +
              `${event.description ?? "-"}`
            );
          });

        embed.addFields({
          name: "Event Terbaru",
          value:
            recentEvents.join("\n").slice(0, 1000) ||
            "Belum ada event.",
        });

        const row = new ActionRowBuilder<ButtonBuilder>();

        const isUnpaid =
          order.status === "CREATED" ||
          order.status === "WAITING_PAYMENT" ||
          order.status === "PAYMENT_PENDING";

        const isFinished =
          order.status === "COMPLETED" || order.status === "CANCELLED";

        if (!isFinished && !isUnpaid) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`admin_review_retry_${order.id}`)
              .setLabel("Proses Ulang")
              .setEmoji("🔄")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`admin_review_complete_${order.id}`)
              .setLabel("Tandai Selesai")
              .setEmoji("✅")
              .setStyle(ButtonStyle.Success),
          );
        }

        if (!isFinished) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`admin_review_cancel_${order.id}`)
              .setLabel(isUnpaid ? "Batalkan Order" : "Batalkan & Refund")
              .setEmoji("↩️")
              .setStyle(ButtonStyle.Danger),
          );
        }

        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`admin_review_ack_${order.id}`)
            .setLabel("Catat Diperiksa")
            .setEmoji("📝")
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({
          embeds: [embed],
          components: [row],
        });

        return;
      }

      // ==============================
      // ADMIN ACTION BUTTONS
      // (retry / complete / cancel)
      // ==============================

      const actionButton = interaction.customId.match(
        /^admin_review_(retry|complete|cancel)_(\d+)$/,
      );

      if (actionButton) {
        // showModal harus jadi respons pertama, jangan di-defer.
        await showAdminActionModal(
          interaction,
          actionButton[1] as AdminActionType,
          Number(actionButton[2]),
        );

        return;
      }

      // ==============================
      // ACKNOWLEDGE REVIEW
      // ==============================

      if (
        interaction.customId.startsWith(
          "admin_review_ack_",
        )
      ) {
        const orderId = Number(
          interaction.customId.replace(
            "admin_review_ack_",
            "",
          ),
        );

        if (
          !Number.isSafeInteger(orderId) ||
          orderId <= 0
        ) {
          await interaction.reply({
            content: "❌ ID order tidak valid.",
            flags: MessageFlags.Ephemeral,
          });

          return;
        }

        await interaction.deferUpdate();

        try {
          await acknowledgeManualReview(
            orderId,
            interaction.user.id,
          );

          await interaction.editReply({
            content:
              `✅ Pemeriksaan admin untuk Order #${orderId} berhasil dicatat.\n\n` +
              "Status order tetap `MANUAL_REVIEW`. Transfer belum dianggap selesai.",
            embeds: [],
            components: [],
          });
        } catch (error) {
          console.error(
            `❌ Gagal mencatat pemeriksaan admin untuk order ${orderId}:`, error instanceof Error ? error.message : error,
          );

          await interaction.followUp({
            content:
              error instanceof Error
                ? `⚠️ ${error.message}`
                : "❌ Gagal mencatat pemeriksaan admin.",
            flags: MessageFlags.Ephemeral,
          }).catch(console.error);
        }

        return;
      }

      return;
    }

    // ==============================
    // CUSTOM ORDER
    // ==============================

    if (
      interaction.customId === "custom_order"
    ) {
      const isEnabled = await isCustomOrderEnabled();
      if (!isEnabled) {
        await interaction.reply({
          content: "❌ Fitur Custom Order saat ini sedang dinonaktifkan oleh admin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const stock = await getSenderStockStatus();
      if (stock.allLimitReached) {
        await interaction.reply({
          content: "❌ Semua akun sender telah mencapai batas limit harian/bulanan. Pembelian ditutup sementara.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await showCustomOrderModal(interaction);
      return;
    }

    // ==============================
    // CUSTOM ORDER → ROBLOX PROFILE
    // ==============================

    if (
      interaction.customId.startsWith(
        "custom_roblox_profile_",
      )
    ) {
      const amount = Number(
        interaction.customId.replace(
          "custom_roblox_profile_",
          "",
        ),
      );

      const stock = await getSenderStockStatus();
      if (stock.allLimitReached) {
        await interaction.reply({
          content: "❌ Semua akun sender telah mencapai batas limit harian/bulanan. Pembelian ditutup sementara.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (stock.maxAvailableRobux < amount) {
        await interaction.reply({
          content: `❌ Stok Robux sender saat ini tidak mencukupi untuk order sebesar **${amount.toLocaleString("id-ID")} Robux** (Tersedia: **${stock.maxAvailableRobux.toLocaleString("id-ID")} Robux**).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!(await isValidRobuxAmount(amount))) {
        const minRobux = await getMinRobuxAmount();
        await interaction.reply({
          content:
            `❌ Jumlah Robux minimal adalah **${minRobux} Robux** dan maksimal **5000 Robux**.`,
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      await showRobloxProfileModal(
        interaction,
        amount,
      );

      return;
    }

    // ==============================
    // FIXED ROBUX AMOUNT
    // ==============================

    if (
      interaction.customId.startsWith(
        "robux_",
      )
    ) {
      const amount = Number(
        interaction.customId.replace(
          "robux_",
          "",
        ),
      );

      const stock = await getSenderStockStatus();
      if (stock.allLimitReached) {
        await interaction.reply({
          content: "❌ Semua akun sender telah mencapai batas limit harian/bulanan. Pembelian ditutup sementara.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (stock.maxAvailableRobux < amount) {
        await interaction.reply({
          content: `❌ Stok Robux sender saat ini tidak mencukupi untuk paket **${amount.toLocaleString("id-ID")} Robux** (Tersedia: **${stock.maxAvailableRobux.toLocaleString("id-ID")} Robux**).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!(await isValidRobuxAmount(amount))) {
        const minRobux = await getMinRobuxAmount();
        await interaction.reply({
          content: `❌ Jumlah Robux tidak valid. Minimal **${minRobux} Robux**.`,
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      await showRobloxProfileModal(
        interaction,
        amount,
      );

      return;
    }

    // ==============================
    // ROBLOX CONFIRM
    // ==============================

    if (
      interaction.customId.startsWith(
        "roblox_confirm_",
      )
    ) {
      const parts =
        interaction.customId.split("_");

      const robloxUserId = Number(parts[2]);
      const amount = Number(parts[3]);

      // ==========================================
      // CACHE KEY
      // ==========================================

      const cacheKey =
        getProfileCacheKey(
          interaction.user.id,
          robloxUserId,
          amount,
        );

      // ==========================================
      // GET PROFILE FROM CACHE
      // ==========================================

      if (orderCreationLocks.has(interaction.user.id)) {
        await interaction.reply({
          content: "⏳ Order kamu sedang dibuat, mohon tunggu sebentar...",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const profile =
        robloxProfileCache.get(cacheKey);

      if (!profile) {
        await interaction.reply({
          content:
            "❌ **Session Roblox sudah tidak tersedia atau order sudah dibuat.**\n\n" +
            "Silakan ulangi order dari `/order`.",

          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      // Hapus cache segera & pasang lock user untuk mencegah tiket duplikat akibat double-click
      robloxProfileCache.delete(cacheKey);
      orderCreationLocks.add(interaction.user.id);

      // ==========================================
      // ACKNOWLEDGE BUTTON
      // ==========================================

      await interaction.deferUpdate();

      let ticketChannel: any = null;
      let createdOrderId: number | null = null;

      try {
        // ========================================
        // CHECK SENDER STOCK & LIMIT
        // ========================================

        const stock = await getSenderStockStatus();
        if (stock.allLimitReached || stock.maxAvailableRobux < amount) {
          await interaction.followUp({
            content:
              "❌ **Stok limit Robux sender telah habis atau tidak mencukupi untuk order ini.**\n\n" +
              "Silakan tunggu reset limit atau hubungi admin.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // ========================================
        // GET CURRENT RATE
        // ========================================

        const rate =
          await getRobuxRate();

        // ========================================
        // CREATE ORDER
        // ========================================

        const result =
          await createOrder({
            discordUserId:
              interaction.user.id,

            discordUsername:
              interaction.user.username,

            robloxUserId:
              profile.id,

            robloxUsername:
              profile.username,

            robloxDisplayName:
              profile.displayName,

            avatarUrl:
              profile.avatarUrl,

            robuxAmount:
              amount,

            rate,
          });

        createdOrderId = result.order.id;

        // ========================================
        // CATEGORY
        // ========================================

        const categoryId =
          process.env.TICKET_CATEGORY_ID;

        if (!categoryId) {
          throw new Error(
            "TICKET_CATEGORY_ID belum diatur di .env",
          );
        }

        // ========================================
        // CHECK GUILD
        // ========================================

        if (!interaction.guildId) {
          throw new Error(
            "Order hanya dapat dibuat di dalam server Discord.",
          );
        }

        // ========================================
        // CREATE DISCORD TICKET
        // ========================================

        ticketChannel =
          await createOrderTicket({
            client,

            guildId:
              interaction.guildId,

            orderId:
              result.order.id,

            orderNumber:
              result.order.orderNumber,

            discordUserId:
              interaction.user.id,

            discordUsername:
              interaction.user.username,

            robloxUsername:
              profile.username,

            robuxAmount:
              amount,

            totalAmount:
              result.order.totalAmount,

            categoryId,
          });

        // ========================================
        // CREATE MIDTRANS DYNAMIC QRIS
        // ========================================

        const qris =
          await createDynamicQris({
            orderId:
              result.order.id,

            orderNumber:
              result.order.orderNumber,

            totalAmount:
              result.order.totalAmount,
          });

        // ========================================
        // CHECK PAYMENT URL / QR CODE
        // ========================================

        if (!qris.qrCodeUrl && !qris.paymentUrl) {
          throw new Error(
            "URL pembayaran QRIS dari Midtrans tidak tersedia.",
          );
        }

        // ========================================
        // SEND QRIS TO TICKET
        // ========================================

        await sendOrderTicketMessage({
          channel:
            ticketChannel,

          orderId:
            result.order.id,

          orderNumber:
            result.order.orderNumber,

          discordUserId:
            interaction.user.id,

          discordUsername:
            interaction.user.username,

          robloxUsername:
            profile.username,

          robuxAmount:
              amount,

          totalAmount:
            result.order.totalAmount,

          qrCodeUrl:
            qris.qrCodeUrl,

          paymentUrl:
            qris.paymentUrl,

          expiredAt:
            qris.expiredAt,
        });

        // ========================================
        // REMOVE CACHE (SETELAH SEMUA SUKSES)
        // ========================================

        robloxProfileCache.delete(
          cacheKey,
        );

        // ========================================
        // UPDATE ORIGINAL INTERACTION
        // ========================================

        const paymentNotice = qris.paymentUrl
          ? "💳 Tombol pembayaran QRIS sudah tersedia di ticket.\n" +
            "⏳ Pembayaran akan terdeteksi otomatis."
          : "💳 QRIS pembayaran sudah tersedia di ticket.\n" +
            "⏳ Pembayaran akan terdeteksi otomatis.";

        await interaction.editReply({
          content:
            "✅ **Order berhasil dibuat!**\n\n" +
            `Order ID: **${result.order.orderNumber}**\n` +
            `Roblox Username: **${profile.username}**\n` +
            `Robux: **${amount.toLocaleString(
              "id-ID",
            )} Robux**\n` +
            `Rate: **Rp${rate.toLocaleString(
              "id-ID",
            )} / Robux**\n` +
            `Harga: **Rp${result.order.totalAmount.toLocaleString(
              "id-ID",
            )}**\n\n` +
            `🎫 **Ticket:** <#${ticketChannel.id}>\n\n` +
            paymentNotice,

          embeds: [],

          components: [],
        });

        console.log(
          `Order created: ${result.order.orderNumber}`,
        );
      } catch (error) {
        console.error(
          "Create Order / Payment Error:",
          error,
        );

        // ========================================
        // CLEANUP ORPHAN TICKET CHANNEL
        // ========================================

        if (ticketChannel && typeof ticketChannel.delete === "function") {
          await ticketChannel
            .delete("Gagal membuat QRIS pembayaran.")
            .catch(() => {});
        }

        // ========================================
        // CANCEL UNPAID ORDER IN DATABASE
        // ========================================

        if (createdOrderId) {
          try {
            await prisma.order.update({
              where: { id: createdOrderId },
              data: { status: "CANCELLED" },
            });
            await prisma.orderEvent.create({
              data: {
                orderId: createdOrderId,
                eventType: "CANCELLED",
                oldStatus: "CREATED",
                newStatus: "CANCELLED",
                description: "Order otomatis dibatalkan karena gagal membuat QRIS pembayaran.",
              },
            });
            console.log(`🧹 Order ${createdOrderId} otomatis dibatalkan karena pembuatan QRIS gagal.`);
          } catch (cancelErr) {
            console.error(`⚠️ Gagal membatalkan order ${createdOrderId}:`, cancelErr);
          }
        }

        // ========================================
        // REMOVE CACHE (CLEANUP ON FAILURE)
        // ========================================

        robloxProfileCache.delete(
          cacheKey,
        );

        // ========================================
        // SHOW ERROR
        // ========================================

        const errorMessage =
          error instanceof Error
            ? error.message
            : "Terjadi kesalahan saat membuat order atau QRIS pembayaran.";

        await interaction.editReply({
          content:
            `❌ **Gagal membuat order.**\n\n${errorMessage}\n\n` +
            "Silakan periksa kembali atau hubungi admin.",

          embeds: [],

          components: [],
        });
      } finally {
        orderCreationLocks.delete(interaction.user.id);
      }

      return;
    }

    // ==============================
    // ROBLOX CANCEL
    // ==============================

    if (
      interaction.customId ===
      "roblox_cancel"
    ) {
      await interaction.update({
        content:
          "❌ **Order dibatalkan.**\n\n" +
          "Silakan gunakan `/order` untuk membuat order baru.",

        embeds: [],

        components: [],
      });

      return;
    }

    // ==============================
    // CUSTOMER: PENGIRIMAN GAGAL
    // ==============================

    const transferButton = interaction.customId.match(
      /^transfer_(2fa|help|cancel)_(\d+)$/,
    );

    if (transferButton) {
      const action = transferButton[1];
      const orderId = Number(transferButton[2]);

      if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        await interaction.reply({
          content: "❌ ID order tidak valid.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      // Cancel membuka modal, jadi harus jadi respons pertama.
      if (action === "cancel") {
        await showTransferCancelModal(interaction, orderId);
        return;
      }

      await interaction.deferUpdate();

      // Hanya pemilik order. Pesan asli tidak diubah untuk orang lain.
      if (!(await isOrderOwner(orderId, interaction.user.id))) {
        await interaction.followUp({
          content: "⛔ Tombol ini hanya bisa dipakai oleh pemilik order.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      try {
        if (action === "2fa") {
          await interaction.editReply({
            content: "⏳ Mencoba mengirim ulang Robux...",
            embeds: [],
            components: [],
          });

          const result = await customerRetryAfter2FA(
            orderId,
            interaction.user.id,
          );

          await interaction.editReply({
            content: result.success
              ? "✅ Pengiriman ulang berhasil."
              : "❌ Pengiriman ulang belum berhasil. Lihat pesan di bawah.",
            embeds: [],
            components: [],
          });
        } else {
          await customerRequestHelp(orderId, interaction.user.id);

          await interaction.editReply({
            content: "🙋 Permintaan bantuan sudah dikirim ke admin.",
            embeds: [],
            components: [],
          });
        }
      } catch (error) {
        const message =
          error instanceof CustomerFlowError
            ? `⚠️ ${error.message}`
            : "❌ Terjadi kesalahan. Coba lagi atau hubungi admin.";

        if (!(error instanceof CustomerFlowError)) {
          console.error(
            `❌ Aksi customer ${action} gagal untuk order ${orderId}:`,
            error instanceof Error ? error.message : error,
          );
        }

        await interaction
          .editReply({ content: message, embeds: [], components: [] })
          .catch(console.error);
      }

      return;
    }

    // ==================================================
    // CHECK PAYMENT BUTTON (CEK PEMBAYARAN INSTAN)
    // ==================================================

    if (interaction.customId.startsWith("check_payment_")) {
      const orderId = Number(
        interaction.customId.replace("check_payment_", ""),
      );
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const res = await checkAndFulfillOrderPayment(orderId);
        if (res.paid) {
          await interaction.editReply({
            content: `✅ **Pembayaran Berhasil Terverifikasi!**\n\nPesanan **${res.orderNumber ?? `#${orderId}`}** telah lunas. Robux sedang segera dikirimkan ke akun kamu!`,
          });
        } else {
          await interaction.editReply({
            content: `⏳ **Status Pembayaran:**\n\n${res.statusText}\n\n*Jika kamu baru saja scan QRIS, tunggu beberapa detik lalu klik tombol **Cek Pembayaran** kembali.*`,
          });
        }
      } catch (err: any) {
        await interaction.editReply({
          content: `⚠️ Kendala saat memeriksa pembayaran: ${err?.message || "Silakan coba lagi beberapa saat lagi."}`,
        });
      }

      return;
    }

    // ==================================================
    // SUPPORT BUTTON
    // ==================================================

    if (
      interaction.customId.startsWith(
        "support_",
      )
    ) {
      await interaction.reply({
        content:
          "🆘 **Bantuan**\n\n" +
          "Permintaan bantuan akan diteruskan ke admin.",

        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ==================================================
    // CANCEL ORDER
    // ==================================================

    // ==================================================
    // RATING STARS (1 - 5 BINTANG)
    // ==================================================

    if (interaction.customId.startsWith("rate_")) {
      const parts = interaction.customId.split("_");
      const stars = Number(parts[1]);
      const orderId = Number(parts[2]);

      const modal = new ModalBuilder()
        .setCustomId(`review_modal_${stars}_${orderId}`)
        .setTitle(`Beri Rating ⭐ ${stars}/5`);

      const reviewInput = new TextInputBuilder()
        .setCustomId("review_text")
        .setLabel("Ulasan (Opsional)")
        .setPlaceholder("Tulis ulasan pengalamanmu (contoh: gacor / cepat)...")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(reviewInput),
      );

      await interaction.showModal(modal);
      return;
    }

    // ==================================================
    // CLOSE TICKET BUTTON
    // ==================================================

    if (interaction.customId.startsWith("close_ticket_")) {
      const orderId = Number(interaction.customId.replace("close_ticket_", ""));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const triggerBotDone = process.env.TRIGGER_BOT_DONE !== "false";

      if (!triggerBotDone) {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { user: true },
        });

        if (order) {
          // Jika pembeli belum memberi rating, otomatis beri rating 5 bintang
          if (!isOrderRated(order.user.discordUserId)) {
            saveBuyerRating({
              discordUserId: order.user.discordUserId,
              discordUsername:
                order.user.discordUsername || interaction.user.username,
              stars: 5,
              review: "",
              method: "Robux",
            });

            await sendVouchEmbed({
              client,
              buyerUser: interaction.user,
              orderNumber: order.orderNumber,
              totalAmount: order.totalAmount,
              robuxAmount: order.robuxAmount,
              stars: 5,
              review: "",
            });
          }
        }
      }

      await interaction.editReply({
        content:
          "🔒 **Ticket Ditutup**\n\nTerima kasih telah berbelanja di Takemi Store! Tiket ini akan dihapus dalam 3 detik.",
      });

      setTimeout(async () => {
        try {
          if (interaction.channel && "delete" in interaction.channel) {
            await interaction.channel.delete("Tiket ditutup oleh pengguna.");
          }
        } catch {}
      }, 3000);

      return;
    }

    if (
      interaction.customId.startsWith(
        "cancel_order_",
      )
    ) {
      await interaction.reply({
        content:
          "❌ **Pembatalan Order**\n\n" +
          "Fitur pembatalan order akan diproses pada tahap berikutnya.",

        flags: MessageFlags.Ephemeral,
      });

      return;
    }
  }

  // ==================================================
  // MODAL
  // ==================================================

  if (interaction.isModalSubmit()) {

    // ==============================
    // REVIEW / RATING MODAL
    // ==============================

    if (interaction.customId.startsWith("review_modal_")) {
      const parts = interaction.customId.split("_");
      const stars = Number(parts[2]);
      const orderId = Number(parts[3]);
      const reviewText =
        interaction.fields.getTextInputValue("review_text")?.trim() || "";

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Simpan rating ke database.db
      saveBuyerRating({
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.username,
        stars,
        review: reviewText,
        method: "Robux",
      });

      const order = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (order) {
        await sendVouchEmbed({
          client,
          buyerUser: interaction.user,
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          robuxAmount: order.robuxAmount,
          stars,
          review: reviewText,
        });
      }

      await interaction.editReply({
        content: `✅ Terima kasih atas rating **⭐ ${stars}/5** dan ulasanmu!\nTiket ini akan ditutup dalam 5 detik.`,
      });

      setTimeout(async () => {
        try {
          if (interaction.channel && "delete" in interaction.channel) {
            await interaction.channel.delete(
              "Tiket ditutup setelah ulasan diberikan.",
            );
          }
        } catch {}
      }, 5000);

      return;
    }

    // ==============================
    // CUSTOMER CANCEL MODAL
    // ==============================

    const cancelModal = interaction.customId.match(
      /^transfer_cancel_modal_(\d+)$/,
    );

    if (cancelModal) {
      const orderId = Number(cancelModal[1]);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await customerCancelOrder(orderId, interaction.user.id, {
          refundDestination:
            interaction.fields.getTextInputValue("refund_destination"),
          reason: interaction.fields.getTextInputValue("cancel_reason"),
        });

        await interaction.editReply({
          content:
            "✅ Order dibatalkan. Admin akan memproses refund ke tujuan yang kamu isi " +
            "dan menghubungi kamu di ticket ini.",
        });
      } catch (error) {
        if (!(error instanceof CustomerFlowError)) {
          console.error(
            `❌ Cancel order ${orderId} gagal:`,
            error instanceof Error ? error.message : error,
          );
        }

        await interaction
          .editReply({
            content:
              error instanceof CustomerFlowError
                ? `⚠️ ${error.message}`
                : "❌ Terjadi kesalahan. Coba lagi atau hubungi admin.",
          })
          .catch(console.error);
      }

      return;
    }

    // ==============================
    // ADMIN ACTION MODAL
    // ==============================

    const adminModal = interaction.customId.match(
      /^admin_action_(retry|complete|cancel)_(\d+)$/,
    );

    if (adminModal) {
      if (!hasAdminRole(interaction)) {
        await interaction.reply({
          content: "⛔ Kamu tidak memiliki akses admin.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      const action = adminModal[1] as AdminActionType;
      const orderId = Number(adminModal[2]);
      const reason = interaction.fields
        .getTextInputValue("reason")
        .trim();

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        let content: string;

        if (action === "retry") {
          const r = await adminRetryOrder(
            orderId,
            interaction.user.id,
            reason,
          );

          if (r.error) {
            content =
              `⚠️ Order #${orderId} sudah disiapkan untuk diproses ulang, tetapi prosesnya terhenti karena error:\n` +
              `${r.error.slice(0, 300)}\n\n` +
              "Sistem akan mencoba lagi otomatis dalam beberapa menit. Cek log terminal jika berulang.";
          } else if (r.success) {
            content = `✅ Order #${orderId} diproses ulang dan berhasil.`;
          } else {
            content =
              `⚠️ Order #${orderId} sudah diproses ulang tetapi belum selesai ` +
              `(${r.reason ?? "alasan tidak diketahui"}). Cek \`/admin_review\`.`;
          }
        } else if (action === "complete") {
          await adminMarkCompleted(orderId, interaction.user.id, reason);
          content = `✅ Order #${orderId} ditandai selesai (manual).`;
        } else {
          const ord = await prisma.order.findUnique({
            where: { id: orderId },
            include: { ticket: true },
          });
          const wasPaid =
            ord?.status !== "CREATED" &&
            ord?.status !== "WAITING_PAYMENT" &&
            ord?.status !== "PAYMENT_PENDING";

          await adminCancelOrder(orderId, interaction.user.id, reason);

          content = wasPaid
            ? `↩️ Order #${orderId} dibatalkan.\nLakukan refund manual ke customer, lalu simpan buktinya.`
            : `↩️ Order #${orderId} dibatalkan.\nKarena order belum dibayar, refund tidak diperlukan.`;

          if (ord?.ticket?.channelId) {
            try {
              const ch = await interaction.client.channels.fetch(
                ord.ticket.channelId,
              );
              if (ch && "send" in ch) {
                await (ch as any).send(
                  `🔒 **Order #${orderId} telah dibatalkan oleh admin.**\nAlasan: ${reason}\nTiket ini akan ditutup dalam 5 detik.`,
                );
                setTimeout(() => {
                  (ch as any).delete("Dibatalkan oleh admin").catch(() => {});
                }, 5000);
              }
            } catch {}
          }
        }

        await interaction.editReply({ content }).catch((err) => {
          console.warn("⚠️ Gagal edit reply modal interaction:", err?.message || err);
        });
      } catch (error) {
        console.error(
          `❌ Aksi admin ${action} gagal untuk order ${orderId}:`,
          error instanceof Error ? error.message : error,
        );

        await interaction
          .editReply({
            content:
              error instanceof Error
                ? `⚠️ ${error.message.slice(0, 300)}`
                : "❌ Aksi admin gagal.",
          })
          .catch(console.error);
      }

      return;
    }

    // ==============================
    // CUSTOM ORDER
    // ==============================

    if (
      interaction.customId ===
      "custom_order_modal"
    ) {
      const amountText =
        interaction.fields.getTextInputValue(
          "robux_amount",
        );

      const amount =
        Number(amountText);

      // ==============================
      // VALIDASI JUMLAH ROBUX
      // ==============================

      if (!(await isValidRobuxAmount(amount))) {
        const minRobux = await getMinRobuxAmount();
        await interaction.reply({
          content:
            `❌ Jumlah Robux minimal adalah **${minRobux} Robux** dan maksimal **5000 Robux**.\n\n` +
            `Contoh yang valid: **${minRobux}, 100, 250, 500, 1000, 2500**.`,

          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      // ==============================
      // VALIDASI STOK / LIMIT SENDER
      // ==============================

      const stock = await getSenderStockStatus();
      if (stock.allLimitReached) {
        await interaction.reply({
          content: "❌ Semua akun sender telah mencapai batas limit harian/bulanan. Pembelian ditutup sementara.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (stock.maxAvailableRobux < amount) {
        await interaction.reply({
          content: `❌ Stok Robux sender saat ini tidak mencukupi untuk order sebesar **${amount.toLocaleString("id-ID")} Robux** (Maksimum saat ini: **${stock.maxAvailableRobux.toLocaleString("id-ID")} Robux**).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // ==============================
      // TAMPILKAN TOMBOL
      // ==============================
      // KE ROBLOX PROFILE
      // ==============================

      await interaction.reply({
        content:
          `✅ Jumlah order: **${amount.toLocaleString(
            "id-ID",
          )} Robux**.\n\n` +
          "Klik tombol di bawah untuk memasukkan Roblox Profile.",

        components: [
          new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(
                  `custom_roblox_profile_${amount}`,
                )
                .setLabel(
                  "Lanjut Isi Roblox Profile",
                )
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary,
                ),
            ),
        ],

        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ==============================
    // ROBLOX PROFILE
    // ==============================

    if (
      interaction.customId.startsWith(
        "roblox_profile_modal_",
      )
    ) {
      const amount = Number(
        interaction.customId.replace(
          "roblox_profile_modal_",
          "",
        ),
      );

      const username =
        interaction.fields.getTextInputValue(
          "roblox_username",
        );

      const displayName =
        interaction.fields.getTextInputValue(
          "roblox_display_name",
        );

      // ==============================
      // DEFER RESPONSE
      // ==============================

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      try {

        // ==============================
        // CEK ROBLOX USERNAME
        // ==============================

        const profile =
          await findRobloxUser(
            username,
          );

        // ==============================
        // USERNAME TIDAK DITEMUKAN
        // ==============================

        if (!profile) {
          await interaction.editReply({
            content:
              "❌ Roblox username tidak ditemukan.\n\n" +
              "Pastikan username yang kamu masukkan benar.",
          });

          return;
        }

        // ==============================
        // VALIDASI DISPLAY NAME
        // ==============================

        if (
          profile.displayName.toLowerCase() !==
          displayName.toLowerCase()
        ) {
          await interaction.editReply({
            content:
              "❌ **Display Username tidak cocok.**\n\n" +
              `Username: **${profile.username}**\n` +
              `Display Username Roblox: **${profile.displayName}**\n\n` +
              "Silakan masukkan data yang sesuai.",
          });

          return;
        }

        // ==============================
        // SIMPAN PROFILE SEMENTARA
        // ==============================

        const cacheKey =
          getProfileCacheKey(
            interaction.user.id,
            profile.id,
            amount,
          );

        robloxProfileCache.set(
          cacheKey,
          {
            id: profile.id,
            username: profile.username,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
          },
        );

        // ==============================
        // AMBIL RATE
        // ==============================

        const rate =
          await getRobuxRate();

        // ==============================
        // TAMPILKAN KONFIRMASI
        // ==============================

        await showRobloxConfirmation(
          interaction,
          profile,
          amount,
          rate,
        );

      } catch (error) {

        console.error(
          "Roblox API Error:",
          error,
        );

        await interaction.editReply({
          content:
            "❌ Terjadi kesalahan saat mengecek Roblox Profile.\n" +
            "Silakan coba lagi beberapa saat lagi.",
        });
      }

      return;
    }
  }
}

client.on("interactionCreate", (interaction) => {
  handleInteraction(interaction).catch((error) => {
    if ([10062, 10008, 10003].includes(error?.code)) {
      console.warn(
        `⚠️ Interaksi tidak bisa dibalas (kode ${error.code}): kedaluwarsa, pesan, atau channel sudah dihapus.`,
      );
      return;
    }

    console.error("❌ Error pada interaksi:", error);
  });
});

// ==============================
// HTTP SERVER
// ==============================

const app = express();

app.use(express.json());

app.use(
  "/webhook",
  midtransWebhook,
);

app.use("/admin", adminDashboard);
app.use("/screenshots", express.static(process.cwd()));

const PORT =
  Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(
    `Webhook server berjalan di port ${PORT}`,
  );
});

// ==============================
// LOGIN
// ==============================

client.login(token);