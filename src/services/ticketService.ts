import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";

import { prisma } from "../database/prisma.js";
import { renderRobloxReceiptCard, getSendersLiveEconomy } from "./robloxEconomyService.js";
import { refreshOrderPanel } from "./orderPanelService.js";
import { releaseQuotaForOrder } from "./senderAdminService.js";
import {
  recordBuyerPurchase,
  saveBuyerRating,
  isOrderRated,
  syncBuyerRoles,
  refreshLeaderboardMessage,
  sendVouchEmbed,
} from "./storeDatabaseService.js";

async function sendChannelWithRetry<T>(
  sendFn: () => Promise<T>,
  retries = 3,
  delayMs = 1500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sendFn();
    } catch (err: any) {
      lastError = err;
      const isNetworkError =
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.message?.includes("ECONNRESET") ||
        err?.status === 502 ||
        err?.status === 503;

      if (isNetworkError && attempt < retries) {
        console.warn(
          `⚠️ Network error saat komunikasi dengan Discord API (${err?.code || err?.message}), mencoba ulang (${attempt}/${retries}) dalam ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function createOrderTicket(params: {
  client: Client;
  guildId: string;
  orderId: number;
  orderNumber: string;
  discordUserId: string;
  discordUsername: string;
  robloxUsername: string;
  robuxAmount: number;
  totalAmount: number;
  categoryId: string;
}) {
  const guild = await params.client.guilds.fetch(params.guildId);
  const botMember = guild.members.me;
  const adminRoleId = process.env.ADMIN_ROLE_ID;

  if (!botMember) {
    throw new Error("Bot member tidak ditemukan di server.");
  }

  // ==========================================
  // CREATE DISCORD CHANNEL
  // ==========================================

  const channel = await guild.channels.create({
    name: `order-${params.orderNumber.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: params.categoryId,
    topic: `Order #${params.orderNumber} | Robux`,

    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: params.discordUserId,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        deny: [
          PermissionFlagsBits.SendMessages,
        ],
      },
      {
        id: botMember.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      },
      ...(adminRoleId
        ? [
            {
              id: adminRoleId,
              type: OverwriteType.Role,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ]
        : []),
    ],
  });

  // ==========================================
  // SAVE TICKET TO DATABASE
  // ==========================================

  await prisma.ticket.create({
    data: {
      orderId: params.orderId,
      guildId: params.guildId,
      channelId: channel.id,
      status: "OPEN",
    },
  });

  return channel;
}

// ======================================================
// SEND INITIAL ORDER TICKET MESSAGE (QRIS)
// ======================================================

export async function sendOrderTicketMessage(params: {
  channel: TextChannel;
  orderId: number;
  orderNumber: string;
  discordUserId: string;
  discordUsername: string;
  robloxUsername: string;
  robuxAmount: number;
  totalAmount: number;
  qrCodeUrl?: string | null;
  paymentUrl?: string | null;
  expiredAt: Date | null;
}) {
  let paymentStatus = "🟡 Menunggu Pembayaran";

  if (params.expiredAt) {
    paymentStatus =
      "🟡 Menunggu Pembayaran\n" +
      `Batas waktu pembayaran sampai <t:${Math.floor(params.expiredAt.getTime() / 1000)}:F>`;
  }

  const description = params.paymentUrl
    ? "Order kamu berhasil dibuat.\n\n" +
      "Silakan klik tombol **Bayar Sekarang (QRIS)** di bawah untuk melakukan pembayaran via **QRIS / GoPay / E-Wallet**.\n\n" +
      "Pembayaran akan terdeteksi otomatis setelah berhasil.\n\n" +
      "💡 *Butuh bantuan staf? Klik tombol **Butuh Bantuan** di bawah untuk membuka akses chat dan memanggil admin.*"
    : "Order kamu berhasil dibuat.\n\n" +
      "Silakan scan QRIS di bawah untuk melakukan pembayaran.\n\n" +
      "Pembayaran akan terdeteksi otomatis setelah berhasil.\n\n" +
      "💡 *Butuh bantuan staf? Klik tombol **Butuh Bantuan** di bawah untuk membuka akses chat dan memanggil admin.*";

  const paymentInstruction = params.paymentUrl
    ? "Klik tombol **Bayar Sekarang (QRIS)** di bawah untuk membayar."
    : "Scan QRIS di bawah untuk membayar.";

  const embed = new EmbedBuilder()
    .setTitle("🛒 AutoVisend — Order Ticket")
    .setDescription(description)
    .addFields(
      {
        name: "📦 Order ID",
        value: `\`${params.orderNumber}\``,
        inline: false,
      },
      {
        name: "👤 Roblox Username",
        value: params.robloxUsername,
        inline: true,
      },
      {
        name: "💎 Robux",
        value: `${params.robuxAmount.toLocaleString("id-ID")} Robux`,
        inline: true,
      },
      {
        name: "💰 Total Harga",
        value: `Rp${params.totalAmount.toLocaleString("id-ID")}`,
        inline: true,
      },
      {
        name: "💳 Pembayaran",
        value: paymentInstruction,
        inline: false,
      },
      {
        name: "📊 Status",
        value: paymentStatus,
        inline: false,
      },
    )
    .setFooter({
      text: `AutoVisend • ${params.discordUsername}`,
    })
    .setTimestamp();

  if (params.qrCodeUrl) {
    embed.setImage(params.qrCodeUrl);
  }

  const row = new ActionRowBuilder<ButtonBuilder>();

  if (params.paymentUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("💳 Bayar Sekarang (QRIS)")
        .setURL(params.paymentUrl)
        .setStyle(ButtonStyle.Link),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`check_payment_${params.orderId}`)
      .setLabel("Cek Pembayaran")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`support_${params.orderId}`)
      .setLabel("Butuh Bantuan")
      .setEmoji("🆘")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`admin_close_ticket_${params.orderId}`)
      .setLabel("Tutup Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger),
  );

  await sendChannelWithRetry(() =>
    params.channel.send({
      content: `<@${params.discordUserId}>`,
      embeds: [embed],
      components: [row],
    }),
  );

  await prisma.order.update({
    where: { id: params.orderId },
    data: { status: "PAYMENT_PENDING" },
  });

  await prisma.orderEvent.create({
    data: {
      orderId: params.orderId,
      eventType: "PAYMENT_PENDING",
      oldStatus: "CREATED",
      newStatus: "PAYMENT_PENDING",
      description: "Link pembayaran QRIS Midtrans berhasil dibuat dan order menunggu pembayaran.",
      metadata: {
        channelId: params.channel.id,
        qrCodeUrl: params.qrCodeUrl ?? null,
        paymentUrl: params.paymentUrl ?? null,
        expiredAt: params.expiredAt?.toISOString() ?? null,
      },
    },
  });

  // ==========================================
  // IN-MEMORY TIMERS: PERINGATAN (13m) & AUTO-CLOSE (15m)
  // ==========================================
  const orderId = params.orderId;
  const channelId = params.channel.id;
  const discordUserId = params.discordUserId;
  const orderNumber = params.orderNumber;
  const client = params.channel.client;

  // 1. Peringatan di menit ke-13 (2 menit sebelum hangus)
  setTimeout(async () => {
    try {
      const currentOrder = await prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (
        currentOrder &&
        ["CREATED", "WAITING_PAYMENT", "PAYMENT_PENDING"].includes(currentOrder.status)
      ) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          await (ch as TextChannel).send({
            content: `⚠️ <@${discordUserId}> **Peringatan Batas Waktu Pembayaran:** Waktu tersisa sekitar **2 menit lagi**. Jika tidak ada pembayaran, tiket ini akan ditutup otomatis oleh sistem.`,
          }).catch(() => null);
        }
      }
    } catch {}
  }, 13 * 60 * 1000);

  // 2. Auto-close tepat di menit ke-15
  setTimeout(async () => {
    try {
      const currentOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { payment: true, ticket: true, user: true },
      });

      if (
        currentOrder &&
        ["CREATED", "WAITING_PAYMENT", "PAYMENT_PENDING"].includes(currentOrder.status)
      ) {
        await cancelOrderAndCloseTicket({
          orderId,
          closedBy: "System (Timeout 15 Menit)",
          reason: "Batas waktu pembayaran 15 menit habis.",
        });

        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const textCh = ch as TextChannel;
          const timeoutEmbed = new EmbedBuilder()
            .setTitle("⏳ Batas Waktu Pembayaran Habis (15 Menit)")
            .setColor(0xe74c3c)
            .setDescription(
              `Halo <@${discordUserId}>,\n\n` +
                `Tiket pesanan **#${orderNumber}** otomatis ditutup karena tidak ada aktivitas pembayaran selama 15 menit.\n\n` +
                `🔒 Room tiket ini akan dihapus dalam **5 detik**. Silakan buat tiket baru jika ingin memesan kembali.`,
            )
            .setFooter({ text: "AutoVisend • Auto Close Timeout" })
            .setTimestamp();

          await textCh.send({ embeds: [timeoutEmbed] }).catch(() => null);
          setTimeout(async () => {
            try {
              await textCh.delete("Tiket otomatis ditutup: batas waktu pembayaran 15 menit habis.");
            } catch {}
          }, 5000);
        }

        refreshOrderPanel(client).catch(() => {});
      }
    } catch {}
  }, 15 * 60 * 1000);
}

// ======================================================
// BATALKAN ORDER & TUTUP TIKET (ADMIN ATAU AUTO-CLOSE)
// ======================================================

export async function cancelOrderAndCloseTicket(params: {
  orderId: number;
  closedBy?: string;
  reason?: string;
}) {
  return await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: params.orderId },
      include: { payment: true, ticket: true },
    });

    if (!order) return null;

    if (
      [
        "PAID",
        "CHECKING_SENDER",
        "READY_TO_SEND",
        "PROCESSING",
        "VERIFYING",
        "COMPLETED",
      ].includes(order.status)
    ) {
      return order;
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });

    if (order.payment && order.payment.status === "PENDING") {
      await tx.payment.update({
        where: { id: order.payment.id },
        data: { status: "EXPIRED" },
      });
    }

    if (order.ticket) {
      await tx.ticket.update({
        where: { id: order.ticket.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });
    }

    await releaseQuotaForOrder(tx, order.id);

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "ORDER_CANCELLED",
        oldStatus: order.status,
        newStatus: "CANCELLED",
        description:
          params.reason ||
          `Tiket ditutup manual oleh ${params.closedBy || "Admin"}.`,
      },
    });

    return order;
  });
}

// ======================================================
// UPDATE TICKET PAYMENT SUCCESS
// ======================================================

export async function updateTicketPaymentSuccess(params: {
  client: Client;
  orderId: number;
}) {
  const ticket = await prisma.ticket.findUnique({
    where: { orderId: params.orderId },
  });

  if (!ticket) return;

  try {
    const channel = await params.client.channels.fetch(ticket.channelId);
    if (!channel || !channel.isTextBased()) return;

    const textChannel = channel as TextChannel;
    const messages = await textChannel.messages.fetch({ limit: 20 });
    const botMessage = messages.find(
      (m) =>
        m.author.id === params.client.user?.id &&
        m.embeds.length > 0 &&
        m.embeds[0]?.title === "🛒 AutoVisend — Order Ticket",
    );

    if (botMessage) {
      const oldEmbed = botMessage.embeds[0];
      const newEmbed = oldEmbed.toJSON();

      newEmbed.fields = (newEmbed.fields ?? []).map((field) => {
        if (field.name === "📊 Status") {
          return {
            ...field,
            value:
              "🟢 **Pembayaran Berhasil**\n\n" +
              "Pembayaran telah dikonfirmasi oleh Midtrans.\n" +
              "Orderan kamu sedang diproses...",
          };
        }
        return field;
      });

      await sendChannelWithRetry(() => botMessage.edit({ embeds: [newEmbed] }));
    }
  } catch (err) {
    console.error(`Gagal update status QRIS ticket:`, err);
  }
}

// ======================================================
// 1. EMBED SAAT PEMBAYARAN BERHASIL & SEDANG DIPROSES
// ======================================================

export async function sendTicketProcessingEmbed(params: {
  client: Client;
  orderId: number;
  senderAccountName?: string;
  isQueued?: boolean;
}) {
  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: { robloxProfile: true, ticket: true, user: true },
  });

  if (!order || !order.ticket) return;

  try {
    const channel = await params.client.channels.fetch(order.ticket.channelId);
    if (!channel || !channel.isTextBased()) return;

    // Embed 1: Pembayaran berhasil!
    const paymentEmbed = new EmbedBuilder()
      .setTitle("✅ Pembayaran berhasil!")
      .setColor(0x2ecc71)
      .setDescription("Pembayaranmu sudah terverifikasi otomatis.")
      .addFields(
        {
          name: "Total bayar",
          value: `Rp${order.totalAmount.toLocaleString("id-ID")}`,
          inline: true,
        },
        {
          name: "Status",
          value: "✅ Terverifikasi",
          inline: true,
        },
      );

    // Embed 2: Status Pengiriman Robux
    const senderLabel = params.senderAccountName
      ? `@${params.senderAccountName}`
      : "Memilih akun sender terbaik...";

    const processingEmbed = new EmbedBuilder()
      .setTitle(
        params.isQueued
          ? "⏳ Pembayaran Diterima — Dalam Antrean"
          : "⏳ Pengiriman Robux Sedang Diproses",
      )
      .setColor(params.isQueued ? 0xe67e22 : 0xf1c40f)
      .setDescription(
        `✅ Penerima dikonfirmasi: **@${order.robloxProfile.username}**\n` +
          `✅ Pembayaran terverifikasi\n` +
          `🔄 Akun pengirim terpilih: **${senderLabel}**\n` +
          (params.isQueued
            ? `⏳ Orderan kamu berada dalam **antrean pengiriman**. Mohon tunggu sebentar, sistem sedang menyelesaikan pengiriman order sebelumnya dan akan langsung mengirim orderanmu begitu giliran tiba!`
            : `⏳ Sedang mengirim **${order.robuxAmount.toLocaleString("id-ID")} Robux**...`),
      )
      .setFooter({
        text: params.isQueued
          ? "Antrean otomatis: Mohon jangan tutup tiket, transfer akan segera berjalan..."
          : "Mohon tunggu sebentar, sistem sedang mengeksekusi transfer...",
      })
      .setTimestamp();

    await sendChannelWithRetry(() =>
      (channel as TextChannel).send({
        embeds: [paymentEmbed, processingEmbed],
      }),
    );
  } catch (err) {
    console.error("Gagal mengirim processing embed:", err);
  }
}

export async function sendTicketTurnArrivedEmbed(params: {
  client: Client;
  orderId: number;
}) {
  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: { ticket: true, user: true },
  });

  if (!order || !order.ticket) return;

  try {
    const channel = await params.client.channels.fetch(order.ticket.channelId);
    if (!channel || !channel.isTextBased()) return;

    await sendChannelWithRetry(() =>
      (channel as TextChannel).send({
        content: `🚀 <@${order.user.discordUserId}> **Giliran orderan kamu tiba!** Sistem automasi sedang membuka profil Roblox dan mengeksekusi pengiriman Robux...`,
      }),
    );
  } catch (err) {
    console.warn("⚠️ Gagal mengirim notifikasi giliran tiba:", err);
  }
}

// ======================================================
// 2. EMBED SAAT TRANSAKSI SELESAI (LENGKAP SESUAI GAMBAR)
// ======================================================

export async function sendOrderCompletedFlow(params: {
  client: Client;
  orderId: number;
}) {
  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: {
      user: true,
      robloxProfile: true,
      payment: true,
      ticket: true,
      transfers: {
        where: { status: "SUCCESS" },
        include: { senderAccount: true },
        orderBy: { completedAt: "desc" },
      },
    },
  });

  if (!order) return;

  // Cari transfer terkait (prioritaskan SUCCESS, atau transfer terakhir)
  let latestTransfer: any = order.transfers[0];
  if (!latestTransfer) {
    latestTransfer = (await prisma.transfer.findFirst({
      where: { orderId: params.orderId },
      include: { senderAccount: true },
      orderBy: { id: "desc" },
    })) ?? undefined;
  }

  let senderAccount: any = latestTransfer?.senderAccount;
  if (!senderAccount && latestTransfer?.senderAccountId) {
    senderAccount = (await prisma.senderAccount.findUnique({
      where: { id: latestTransfer.senderAccountId },
    })) ?? undefined;
  }

  const senderName = senderAccount?.accountName ?? "dantetempe";

  // Ambil referensi resmi (format RXT-...) tanpa query params seperti ?_RoValraRequest=
  const rawRef =
    latestTransfer?.externalTransferId && latestTransfer.externalTransferId.startsWith("RXT-")
      ? latestTransfer.externalTransferId
      : `RXT-${Math.floor(1000000000000000000 + Math.random() * 9000000000000000000)}`;
  const refId = rawRef.split("?")[0].split("#")[0].trim();

  // Ambil user ID Roblox sender secara akurat
  let senderRobloxId = senderAccount?.robloxUserId;
  if (!senderRobloxId && senderName) {
    const acc = await prisma.senderAccount.findFirst({
      where: { accountName: senderName },
    });
    if (acc) senderRobloxId = acc.robloxUserId;
  }
  if (!senderRobloxId && senderName) {
    try {
      const uRes = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({ usernames: [senderName], excludeBannedUsers: false }),
      });
      if (uRes.ok) {
        const uJson = (await uRes.json()) as { data?: { id?: number }[] };
        if (uJson.data?.[0]?.id) {
          senderRobloxId = String(uJson.data[0].id);
        }
      }
    } catch {}
  }

  // Ambil avatar sender dari Roblox CDN
  let senderAvatarUrl: string | undefined;
  if (senderRobloxId) {
    try {
      const res = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${senderRobloxId}&size=150x150&format=Png`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { data?: { imageUrl?: string }[] };
        senderAvatarUrl = d.data?.[0]?.imageUrl;
      }
    } catch {
      // Abaikan
    }
  }

  // Helper konversi URL gambar ke Base64 Data URI agar 100% aman dimuat di Canvas/Playwright
  async function toDataUri(url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    try {
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      const ct = res.headers.get("content-type") || "image/png";
      return `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  const senderDataUri = await toDataUri(senderAvatarUrl);
  const receiverDataUri = await toDataUri(order.robloxProfile.avatarUrl ?? undefined);

  // Generate gambar struk mutasi transaksi Roblox (seperti Gambar 1 & 2)
  let attachment: AttachmentBuilder | null = null;
  try {
    const cardBuffer = await renderRobloxReceiptCard({
      senderUsername: senderName,
      senderAvatarUrl: senderDataUri || senderAvatarUrl,
      receiverUsername: order.robloxProfile.username,
      receiverAvatarUrl: receiverDataUri || (order.robloxProfile.avatarUrl ?? undefined),
      robuxAmount: order.robuxAmount,
      referenceId: refId,
    });
    attachment = new AttachmentBuilder(cardBuffer, { name: "receipt.png" });
  } catch (err) {
    console.warn("⚠️ Gagal membuat render image struk, fallback ke embed teks:", err);
  }

  // ==========================================
  // EMBED 1: ✅ Robux berhasil dikirim
  // ==========================================
  const progressTime = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(order.completedAt ?? new Date());

  const sentEmbed = new EmbedBuilder()
    .setTitle("✅ Robux berhasil dikirim")
    .setColor(0x2ecc71)
    .setDescription(
      `✅ **Penerima dikonfirmasi:** @${order.robloxProfile.username}\n` +
        `✅ **Pembayaran terverifikasi**\n` +
        `✅ **Akun pengirim terpilih:** @${senderName}\n` +
        `✅ **${order.robuxAmount.toLocaleString("id-ID")} Robux berhasil dikirim**`,
    )
    .addFields(
      {
        name: "Referensi transfer",
        value: `\`${refId}\``,
        inline: false,
      },
      {
        name: "Progres diperbarui",
        value: progressTime,
        inline: false,
      },
    );

  if (attachment) {
    sentEmbed.setImage("attachment://receipt.png");
  }

  // ==========================================
  // EMBED 2: ✅ TRANSAKSI SELESAI
  // ==========================================
  const testimoniChannelId = process.env.TESTIMONI_CHANNEL_ID;
  const testimoniMention = testimoniChannelId ? `<#${testimoniChannelId}>` : "#testimoni";

  const completedEmbed = new EmbedBuilder()
    .setTitle("✅ TRANSAKSI SELESAI")
    .setColor(0x2ecc71)
    .setDescription(
      `**Buyer:** <@${order.user.discordUserId}>\n` +
        `**Role Buyer telah diberikan**\n\n` +
        `⭐ **Beri rating pengalamanmu!**\n` +
        `Pilih 1–5 bintang, lalu tambahkan ulasan jika mau. Rating dan ulasan akan tampil publik di ${testimoniMention}.\n\n` +
        `*Rating bersifat opsional. Kamu bisa mengisinya sebelum tiket ditutup otomatis. Jika belum diisi, transaksi akan dicatat otomatis di channel testimoni tanpa rating.*`,
    );

  // ==========================================
  // BUTTONS: BINTANG 1-5 & TUTUP TICKET
  // ==========================================
  const starRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rate_1_${order.id}`).setLabel("⭐ 1").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rate_2_${order.id}`).setLabel("⭐ 2").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rate_3_${order.id}`).setLabel("⭐ 3").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rate_4_${order.id}`).setLabel("⭐ 4").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rate_5_${order.id}`).setLabel("⭐ 5").setStyle(ButtonStyle.Secondary),
  );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`close_ticket_${order.id}`)
      .setLabel("Tutup Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger),
  );

  const triggerBotDone = process.env.TRIGGER_BOT_DONE !== "false";

  if (!triggerBotDone) {
    // 1. CATAT KE DATABASE.DB & SYNC ROLES / LEADERBOARD (MODE LOKAL)
    let totalSpent = order.totalAmount;
    try {
      const recorded = recordBuyerPurchase({
        discordUserId: order.user.discordUserId,
        discordUsername: order.user.discordUsername || "Buyer",
        amount: order.totalAmount,
        productName: "Robux",
      });
      totalSpent = recorded.totalSpent;
    } catch (dbErr) {
      console.error("❌ Gagal mencatat order ke database.db:", dbErr);
    }

    // Sinkronisasi Role Customer, 500K+, 1JT+, Top Spender 👑
    if (order.ticket) {
      try {
        const guild = await params.client.guilds.fetch(order.ticket.guildId);
        const member = await guild.members.fetch(order.user.discordUserId);
        if (member) {
          await syncBuyerRoles({
            guild,
            member,
            totalSpent,
          });
          console.log(`🎖️ Role buyer berhasil disinkronkan untuk user ${order.user.discordUserId}`);
        }
        await refreshLeaderboardMessage(params.client, order.ticket.guildId);
      } catch (roleErr) {
        console.warn("⚠️ Gagal sync role / leaderboard:", roleErr);
      }
    }
  }

  // ==========================================
  // KIRIM KE CHANNEL TICKET PEMBELI
  // ==========================================
  if (order.ticket) {
    try {
      const channel = await params.client.channels.fetch(order.ticket.channelId);
      if (channel && channel.isTextBased()) {
        const textChannel = channel as TextChannel;

        // Cek apakah pesan processing (Pengiriman Robux Sedang Diproses) ada di channel
        let editedExistingMessage = false;
        try {
          const recentMessages = await textChannel.messages.fetch({ limit: 10 });
          const processingMsg = recentMessages.find(
            (m) =>
              m.author.id === params.client.user?.id &&
              m.embeds.some(
                (e) =>
                  e.title?.includes("Pengiriman Robux Sedang Diproses") ||
                  e.title?.includes("Pembayaran berhasil!"),
              ),
          );

          if (processingMsg) {
            // Ambil embed pembayaran dari pesan sebelumnya agar tetap utuh
            const paymentEmbed = processingMsg.embeds.find((e) =>
              e.title?.includes("Pembayaran berhasil!"),
            );

            const embedsToUpdate = paymentEmbed
              ? [EmbedBuilder.from(paymentEmbed), sentEmbed]
              : [sentEmbed];

            await sendChannelWithRetry(() =>
              processingMsg.edit({
                embeds: embedsToUpdate,
                files: attachment ? [attachment] : [],
              }),
            );
            editedExistingMessage = true;
          }
        } catch (fetchErr) {
          console.warn("⚠️ Gagal mengedit pesan processing sebelumnya:", fetchErr);
        }

        if (!editedExistingMessage) {
          // Fallback jika pesan sebelumnya tidak ditemukan
          await sendChannelWithRetry(() =>
            textChannel.send({
              embeds: [sentEmbed],
              files: attachment ? [attachment] : [],
            }),
          );
        }

        if (triggerBotDone) {
          // Pemicu .done ke Bot 1 (storesystem.py)
          console.log(`🚀 Mengirim trigger .done ke Bot 1 untuk order ${order.orderNumber}...`);
          await sendChannelWithRetry(() =>
            textChannel.send({
              content: `.done <@${order.user.discordUserId}> ${order.totalAmount}`,
            }),
          );

          // Berikan tombol tutup tiket ke pembeli
          await sendChannelWithRetry(() =>
            textChannel.send({
              content: `<@${order.user.discordUserId}> Pesananmu telah berhasil diproses! Terima kasih telah berbelanja di Takemi Store.`,
              components: [actionRow],
            }),
          );
        } else {
          // Fallback tanpa Bot 1 (menggunakan embed dan bintang internal)
          await sendChannelWithRetry(() =>
            textChannel.send({
              content: `<@${order.user.discordUserId}> Pesananmu telah selesai dikirim!`,
              embeds: [completedEmbed],
              components: [starRow, actionRow],
            }),
          );
        }

        console.log(`✅ Pesan transaksi selesai berhasil dikirim ke ticket #${channel.id}`);
      }
    } catch (err) {
      console.error(`❌ Gagal mengirim pesan selesai ke ticket channel:`, err);
    }
  }

  // ==========================================
  // UPDATE PANEL ORDER DI DISCORD SETELAH PEMBELIAN
  // ==========================================
  getSendersLiveEconomy()
    .catch(() => null)
    .then(() => refreshOrderPanel(params.client))
    .catch((err) => {
      console.warn("⚠️ Gagal update panel order setelah pembelian:", err?.message || err);
    });

  // ==========================================
  // TIMER OTOMATIS TUTUP TICKET & AUTO RATING 5 BINTANG
  // ==========================================
  // Jika pembeli tidak melakukan rating dalam 10 menit,
  // tiket otomatis ditutup dan diberikan rating bintang 5 otomatis.
  const AUTO_CLOSE_MS = 10 * 60 * 1000;
  setTimeout(async () => {
    try {
      if (!triggerBotDone && !isOrderRated(order.user.discordUserId)) {
        saveBuyerRating({
          discordUserId: order.user.discordUserId,
          discordUsername: order.user.discordUsername || "Buyer",
          stars: 5,
          review: "",
          method: "Robux",
        });

        const buyerUser = await params.client.users
          .fetch(order.user.discordUserId)
          .catch(() => null);

        if (buyerUser) {
          await sendVouchEmbed({
            client: params.client,
            buyerUser,
            orderNumber: order.orderNumber,
            totalAmount: order.totalAmount,
            robuxAmount: order.robuxAmount,
            stars: 5,
            review: "",
          });
        }
      }

      if (order.ticket) {
        const ch = await params.client.channels
          .fetch(order.ticket.channelId)
          .catch(() => null);
        if (ch && "delete" in ch) {
          await (ch as TextChannel)
            .delete("Tiket otomatis ditutup setelah batas waktu transaksi selesai.")
            .catch(() => {});
        }
      }
    } catch (err) {
      // Abaikan jika channel sudah dihapus
    }
  }, AUTO_CLOSE_MS);

  // ==========================================
  // KIRIM SALINAN STRUK KE DM PEMBELI
  // ==========================================
  try {
    const discordUser = await params.client.users.fetch(order.user.discordUserId);
    if (discordUser) {
      await sendChannelWithRetry(() =>
        discordUser.send({
          content: `Halo! Robux untuk pesanan kamu (**#${order.orderNumber}**) telah berhasil dikirim!`,
          embeds: [sentEmbed],
          files: attachment ? [attachment] : [],
        }),
      );
      console.log(`✅ Struk berhasil dikirim via DM ke user: ${order.user.discordUserId}`);
    }
  } catch {
    console.log(`ℹ️ DM ke pengguna ${order.user.discordUserId} tidak dapat dikirim (DM ditutup).`);
  }
}

// Backward compatibility alias
export const sendOrderCompletionReceipt = sendOrderCompletedFlow;
