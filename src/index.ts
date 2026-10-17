import "dotenv/config";
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
} from "discord.js";

import * as visendRateCommand from "./commands/visendRate.js";
import * as orderCommand from "./commands/order.js";
import * as adminReviewCommand from "./commands/adminReview.js";

import { showCustomOrderModal } from "./modals/customOrder.js";
import { showRobloxProfileModal } from "./modals/robloxProfile.js";

import { findRobloxUser } from "./services/robloxService.js";
import { showRobloxConfirmation } from "./buttons/robloxConfirm.js";

import { getRobuxRate } from "./services/rateService.js";
import { createOrder } from "./services/orderService.js";
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

import { showTransferCancelModal } from "./modals/transferCancel.js";
import {
  CustomerFlowError,
  customerCancelOrder,
  customerRequestHelp,
  customerRetryAfter2FA,
  isOrderOwner,
} from "./services/transferFailureService.js";
import { runBackgroundWorkers } from "./services/reconciliationService.js";

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
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
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
  const adminRoleId = process.env.ADMIN_ROLE_ID;

  if (!adminRoleId || !interaction.inGuild()) {
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

  setInterval(() => {
    runBackgroundWorkers().catch((error) => {
      console.error(
        "❌ Worker error:",
        error instanceof Error ? error.message : error,
      );
    });
  }, 60_000);
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
      await orderCommand.execute(interaction);
      return;
    }

    // ==============================
    // /visend_rate
    // ==============================

    if (
      interaction.commandName ===
      visendRateCommand.data.name
    ) {
      await visendRateCommand.execute(interaction);
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

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
          new ButtonBuilder()
            .setCustomId(`admin_review_cancel_${order.id}`)
            .setLabel("Batalkan & Refund")
            .setEmoji("↩️")
            .setStyle(ButtonStyle.Danger),
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

      if (
        !Number.isInteger(amount) ||
        amount < 100 ||
        amount > 5000 ||
        amount % 100 !== 0
      ) {
        await interaction.reply({
          content:
            "❌ Jumlah Robux tidak valid.",
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

      const profile =
        robloxProfileCache.get(cacheKey);

      if (!profile) {
        await interaction.reply({
          content:
            "❌ **Session Roblox sudah tidak tersedia.**\n\n" +
            "Silakan ulangi order dari `/order`.",

          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      // ==========================================
      // ACKNOWLEDGE BUTTON
      // ==========================================

      await interaction.deferUpdate();

      try {
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

        const ticketChannel =
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
        // CHECK QR CODE
        // ========================================

        if (!qris.qrCodeUrl) {
          throw new Error(
            "QRIS URL dari Midtrans tidak tersedia.",
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
            "💳 QRIS pembayaran sudah tersedia di ticket.\n" +
            "⏳ Pembayaran akan terdeteksi otomatis.",

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
        // REMOVE CACHE (CLEANUP ON FAILURE)
        // ========================================

        robloxProfileCache.delete(
          cacheKey,
        );

        // ========================================
        // SHOW ERROR
        // ========================================

        await interaction.editReply({
          content:
            "❌ **Gagal membuat order.**\n\n" +
            "Terjadi kesalahan saat membuat order atau QRIS pembayaran.\n\n" +
            "Silakan coba lagi atau hubungi admin.",

          embeds: [],

          components: [],
        });
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
          await adminCancelOrder(orderId, interaction.user.id, reason);
          content =
            `↩️ Order #${orderId} dibatalkan.\n` +
            "Lakukan refund manual ke customer, lalu simpan buktinya.";
        }

        await interaction.editReply({ content });
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

      if (
        !Number.isInteger(amount) ||
        amount < 100 ||
        amount > 5000 ||
        amount % 100 !== 0
      ) {
        await interaction.reply({
          content:
            "❌ Jumlah Robux harus merupakan kelipatan **100 Robux** dan maksimal **5000 Robux**.\n\n" +
            "Contoh yang valid: **100, 200, 500, 1000, 2500**.",

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
    if (error?.code === 10062) {
      console.warn(
        "⚠️ Interaksi kedaluwarsa sebelum sempat dibalas (10062).",
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