import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";

import { prisma } from "../database/prisma.js";
import { getRobuxRate } from "./rateService.js";
import { getSenderStockStatus } from "./senderService.js";
import { isCustomOrderEnabled } from "./customOrderSettingService.js";

const KEY_CHANNEL_ID = "ORDER_PANEL_CHANNEL_ID";
const KEY_MESSAGE_ID = "ORDER_PANEL_MESSAGE_ID";

/**
 * Membangun embed dan komponen tombol untuk panel order Robux.
 */
export async function buildOrderPanel(): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
}> {
  const rate = await getRobuxRate();
  const stock = await getSenderStockStatus();
  const showCustom = await isCustomOrderEnabled();

  const isLimitAll = stock.allLimitReached;

  // ==============================
  // ROW 1: 100 - 500 ROBUX
  // ==============================
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("robux_100")
      .setLabel("100 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 100),

    new ButtonBuilder()
      .setCustomId("robux_200")
      .setLabel("200 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 200),

    new ButtonBuilder()
      .setCustomId("robux_300")
      .setLabel("300 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 300),

    new ButtonBuilder()
      .setCustomId("robux_400")
      .setLabel("400 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 400),

    new ButtonBuilder()
      .setCustomId("robux_500")
      .setLabel("500 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 500),
  );

  // ==============================
  // ROW 2: 600 - 1000 ROBUX
  // ==============================
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("robux_600")
      .setLabel("600 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 600),

    new ButtonBuilder()
      .setCustomId("robux_700")
      .setLabel("700 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 700),

    new ButtonBuilder()
      .setCustomId("robux_800")
      .setLabel("800 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 800),

    new ButtonBuilder()
      .setCustomId("robux_900")
      .setLabel("900 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 900),

    new ButtonBuilder()
      .setCustomId("robux_1000")
      .setLabel("1000 Robux")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLimitAll || stock.maxAvailableRobux < 1000),
  );

  const components: ActionRowBuilder<ButtonBuilder>[] = [row1, row2];

  // ==============================
  // ROW 3: CUSTOM ORDER (JIKA DIAKTIFKAN)
  // ==============================
  if (showCustom) {
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("custom_order")
        .setLabel("✍️ Custom Order (Bebas)")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isLimitAll),
    );
    components.push(row3);
  }

  // ==============================
  // EMBED TAMPILAN ORDER
  // ==============================
  const embed = new EmbedBuilder();

  if (isLimitAll) {
    embed
      .setTitle("🛒 Takemi Store — Robux Order (Stok Habis / Limit)")
      .setColor(0xed4245) // Merah
      .setDescription(
        "⚠️ **Mohon Maaf, Semua Akun Pengirim Sedang Limit.**\n\n" +
          "Batas transfer harian/bulanan pada akun Roblox pengirim saat ini telah tercapai.\n" +
          "Tombol pembelian dinonaktifkan sementara sampai kuota ter-reset atau akun pengirim baru ditambahkan.\n\n" +
          "Silakan cek kembali beberapa saat lagi atau hubungi admin.",
      )
      .setFooter({ text: "Takemi Store • Status Stok: Limit / Kosong" })
      .setTimestamp();
  } else {
    embed
      .setTitle("🛒 Takemi Store — Robux Order")
      .setColor(0x5865f2) // Biru Discord
      .setDescription(
        `✨ **Rate Harga:** Rp${rate.toLocaleString("id-ID")} / Robux\n` +
          `📦 **Stok Tersedia:** ~${stock.totalRemainingRobux.toLocaleString("id-ID")} Robux\n\n` +
          "Silakan klik salah satu tombol paket Robux di bawah untuk membuat tiket pembelian:",
      )
      .setFooter({ text: "Takemi Store • Otomatis & Terpercaya" })
      .setTimestamp();
  }

  return { embed, components };
}

/**
 * Simpan ID channel & ID pesan panel order aktif ke database.
 */
export async function saveOrderPanelReference(
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where: { key: KEY_CHANNEL_ID },
      update: { value: channelId },
      create: { key: KEY_CHANNEL_ID, value: channelId },
    }),
    prisma.systemSetting.upsert({
      where: { key: KEY_MESSAGE_ID },
      update: { value: messageId },
      create: { key: KEY_MESSAGE_ID, value: messageId },
    }),
  ]);
}

/**
 * Ambil ID channel & ID pesan panel order aktif dari database.
 */
export async function getOrderPanelReference(): Promise<{
  channelId: string;
  messageId: string;
} | null> {
  const [channelSetting, messageSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: KEY_CHANNEL_ID } }),
    prisma.systemSetting.findUnique({ where: { key: KEY_MESSAGE_ID } }),
  ]);

  if (!channelSetting || !messageSetting) {
    return null;
  }

  return {
    channelId: channelSetting.value,
    messageId: messageSetting.value,
  };
}

/**
 * Memperbarui (edit) pesan panel order di Discord dengan data stok & rate terbaru.
 */
export async function refreshOrderPanel(client: Client): Promise<boolean> {
  try {
    const ref = await getOrderPanelReference();
    if (!ref) {
      return false;
    }

    const channel = await client.channels.fetch(ref.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const message = await (channel as TextChannel).messages
      .fetch(ref.messageId)
      .catch(() => null);

    if (!message) {
      return false;
    }

    const { embed, components } = await buildOrderPanel();

    await message.edit({
      embeds: [embed],
      components,
    });

    console.log(`✅ Panel order Discord (ID: ${ref.messageId}) berhasil diperbarui.`);
    return true;
  } catch (error) {
    console.warn(
      "⚠️ Gagal memperbarui panel order Discord:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
