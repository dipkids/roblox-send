import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";

import { prisma } from "../database/prisma.js";

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
  const guild = await params.client.guilds.fetch(
    params.guildId,
  );

  const botMember = guild.members.me;

  if (!botMember) {
    throw new Error(
      "Bot member tidak ditemukan di server.",
    );
  }

  // ==========================================
  // CREATE DISCORD CHANNEL
  // ==========================================

  const channel = await guild.channels.create({
    name: `order-${params.orderNumber.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: params.categoryId,

    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,

        deny: [
          PermissionFlagsBits.ViewChannel,
        ],
      },

      {
        id: params.discordUserId,

        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },

      {
        id: botMember.id,

        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
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
// SEND ORDER TICKET MESSAGE
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

  qrCodeUrl: string;
  expiredAt: Date | null;
}) {
  // ==========================================
  // PAYMENT STATUS TEXT
  // ==========================================

  let paymentStatus = "🟡 Menunggu Pembayaran";

  if (params.expiredAt) {
    paymentStatus =
      "🟡 Menunggu Pembayaran\n" +
      `QRIS berlaku sampai <t:${Math.floor(
        params.expiredAt.getTime() / 1000,
      )}:F>`;
  }

  // ==========================================
  // EMBED
  // ==========================================

  const embed = new EmbedBuilder()
    .setTitle(
      "🛒 AutoVisend — Order Ticket",
    )
    .setDescription(
      "Order kamu berhasil dibuat.\n\n" +
        "Silakan scan QRIS di bawah untuk melakukan pembayaran.\n\n" +
        "Pembayaran akan terdeteksi otomatis setelah berhasil.",
    )
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
        value: `${params.robuxAmount.toLocaleString(
          "id-ID",
        )} Robux`,
        inline: true,
      },

      {
        name: "💰 Total Harga",
        value: `Rp${params.totalAmount.toLocaleString(
          "id-ID",
        )}`,
        inline: true,
      },

      {
        name: "💳 Pembayaran",
        value:
          "Scan QRIS di bawah untuk membayar.",
        inline: false,
      },

      {
        name: "📊 Status",
        value: paymentStatus,
        inline: false,
      },
    )
    .setImage(params.qrCodeUrl)
    .setFooter({
      text: `AutoVisend • ${params.discordUsername}`,
    })
    .setTimestamp();

  // ==========================================
  // BUTTONS
  // ==========================================

  const row =
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `support_${params.orderId}`,
        )
        .setLabel("Butuh Bantuan")
        .setEmoji("🆘")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          `cancel_order_${params.orderId}`,
        )
        .setLabel("Batalkan Order")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger),
    );

  // ==========================================
  // SEND MESSAGE
  // ==========================================

  await params.channel.send({
    content: `<@${params.discordUserId}>`,
    embeds: [embed],
    components: [row],
  });

  // ==========================================
  // UPDATE ORDER STATUS
  // ==========================================

  await prisma.order.update({
    where: {
      id: params.orderId,
    },

    data: {
      status: "PAYMENT_PENDING",
    },
  });

  // ==========================================
  // ORDER EVENT
  // ==========================================

  await prisma.orderEvent.create({
    data: {
      orderId: params.orderId,

      eventType: "PAYMENT_PENDING",

      oldStatus: "CREATED",
      newStatus: "PAYMENT_PENDING",

      description:
        "QRIS Midtrans berhasil dibuat dan order menunggu pembayaran.",

      metadata: {
        channelId: params.channel.id,
        qrCodeUrl: params.qrCodeUrl,
        expiredAt:
          params.expiredAt?.toISOString() ?? null,
      },
    },
  });
}

export async function updateTicketPaymentSuccess(params: {
  client: Client;
  orderId: number;
}) {
  const ticket = await prisma.ticket.findUnique({
    where: {
      orderId: params.orderId,
    },
  });

  if (!ticket) {
    console.error(
      `Ticket tidak ditemukan untuk order ${params.orderId}`,
    );
    return;
  }

  const channel = await params.client.channels.fetch(
    ticket.channelId,
  );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    console.error(
      `Channel ticket tidak valid: ${ticket.channelId}`,
    );
    return;
  }

  const textChannel =
    channel as TextChannel;

  const messages =
    await textChannel.messages.fetch({
      limit: 20,
    });

  const botMessage =
    messages.find(
      (message) =>
        message.author.id ===
        params.client.user?.id &&
        message.embeds.length > 0 &&
        message.embeds[0]?.title ===
          "🛒 AutoVisend — Order Ticket",
    );

  if (!botMessage) {
    console.error(
      `Pesan order tidak ditemukan di ticket ${ticket.channelId}`,
    );
    return;
  }

  const oldEmbed =
    botMessage.embeds[0];

  const newEmbed =
    oldEmbed.toJSON();

  newEmbed.fields =
    (newEmbed.fields ?? []).map(
      (field) => {
        if (
          field.name ===
          "📊 Status"
        ) {
          return {
            ...field,
            value:
              "🟢 **Pembayaran Berhasil**\n\n" +
              "Pembayaran telah dikonfirmasi oleh Midtrans.\n" +
              "Order akan segera diproses.",
          };
        }

        return field;
      },
    );

  await botMessage.edit({
    embeds: [newEmbed],
  });

  console.log(
    `✅ Ticket payment status updated: order ${params.orderId}`,
  );
}