import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

import {
  ADMIN_SETTABLE_STATUSES,
  SenderAdminError,
  type AdminSettableStatus,
  addSender,
  effectiveUsage,
  listSenders,
  setSenderStatus,
  syncSenderUsage,
  updateLimits,
} from "../services/senderAdminService.js";

import { getSendersLiveEconomy } from "../services/robloxEconomyService.js";
import { refreshOrderPanel } from "../services/orderPanelService.js";

export const data = new SlashCommandBuilder()
  .setName("sender")
  .setDescription("Kelola akun sender Robux (khusus admin)")
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Lihat semua sender, saldo, dan limit langsung dari Roblox"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Tambah akun sender baru")
      .addStringOption((o) =>
        o
          .setName("nama")
          .setDescription("Nama akun sender")
          .setRequired(true)
          .setMaxLength(50),
      )
      .addStringOption((o) =>
        o
          .setName("roblox_id")
          .setDescription("Roblox user ID sender")
          .setRequired(true)
          .setMaxLength(20),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit_harian")
          .setDescription("Limit harian (Robux)")
          .setRequired(true)
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit_bulanan")
          .setDescription("Limit bulanan (Robux)")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("limit")
      .setDescription("Ubah limit sender")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("ID sender")
          .setRequired(true)
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit_harian")
          .setDescription("Limit harian baru")
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit_bulanan")
          .setDescription("Limit bulanan baru")
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Ubah status sender")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("ID sender")
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((o) =>
        o
          .setName("status")
          .setDescription("Status baru")
          .setRequired(true)
          .addChoices(
            ...ADMIN_SETTABLE_STATUSES.map((s) => ({ name: s, value: s })),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("sync")
      .setDescription("Sinkronkan limit & saldo dari Roblox (kosongkan ID untuk semua sender)")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("ID sender (opsional, kosongkan untuk sinkronkan semua akun)")
          .setRequired(false)
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName("harian_terpakai")
          .setDescription("Isi manual: Robux terpakai hari ini")
          .setMinValue(0),
      )
      .addIntegerOption((o) =>
        o
          .setName("bulanan_terpakai")
          .setDescription("Isi manual: Robux terpakai bulan ini")
          .setMinValue(0),
      ),
  );

const fmt = (n: number) => n.toLocaleString("id-ID");

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  const adminId = interaction.user.id;

  try {
    // ==============================
    // LIST
    // ==============================
    if (sub === "list") {
      // Tarik live economy dari Roblox langsung agar data selalu real-time
      const liveEconomy = await getSendersLiveEconomy().catch(() => []);
      const liveMap = new Map(liveEconomy.map((l) => [l.id, l]));

      const senders = await listSenders();

      if (senders.length === 0) {
        await interaction.editReply({
          content: "Belum ada sender. Tambahkan dengan `/sender add`.",
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏦 Akun Sender Roblox (Live Economy & Limit)")
        .setColor(0x3498db)
        .setDescription(
          "Data limit, pemakaian, dan saldo otomatis tersinkronisasi secara real-time dari Roblox API.",
        )
        .setTimestamp();

      for (const sender of senders.slice(0, 25)) {
        const usage = effectiveUsage(sender);
        const live = liveMap.get(sender.id);
        const balanceLine =
          live && typeof live.robuxBalance === "number"
            ? `💰 Saldo: **${fmt(live.robuxBalance)} Robux**\n`
            : "";

        embed.addFields({
          name: `#${sender.id} · ${sender.accountName} · [${sender.status}]`,
          value: [
            `Roblox ID: \`${sender.robloxUserId}\``,
            balanceLine +
            `Harian: **${fmt(usage.dailyUsed)}** / ${fmt(sender.dailyLimit)} ` +
              `(sisa **${fmt(Math.max(sender.dailyLimit - usage.dailyUsed, 0))} Robux**)`,
            `Bulanan: **${fmt(usage.monthlyUsed)}** / ${fmt(sender.monthlyLimit)} ` +
              `(sisa **${fmt(Math.max(sender.monthlyLimit - usage.monthlyUsed, 0))} Robux**)`,
            `Transfer berjalan: ${sender.activeTransfers}` +
              (sender.inFlightRobux > 0
                ? ` (${fmt(sender.inFlightRobux)} Robux)`
                : ""),
          ].join("\n"),
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ==============================
    // ADD
    // ==============================
    if (sub === "add") {
      const sender = await addSender(
        {
          accountName: interaction.options.getString("nama", true),
          robloxUserId: interaction.options.getString("roblox_id", true),
          dailyLimit: interaction.options.getInteger("limit_harian", true),
          monthlyLimit: interaction.options.getInteger("limit_bulanan", true),
        },
        adminId,
      );

      // Refresh panel order Discord
      refreshOrderPanel(interaction.client).catch(() => {});

      await interaction.editReply({
        content:
          `✅ Sender **#${sender.id} ${sender.accountName}** ditambahkan ` +
          `(${fmt(sender.dailyLimit)} / ${fmt(sender.monthlyLimit)} Robux).\n` +
          "Order yang tertahan karena sender habis bisa diproses ulang lewat `/admin_review`.",
      });
      return;
    }

    // ==============================
    // LIMIT
    // ==============================
    if (sub === "limit") {
      const id = interaction.options.getInteger("id", true);
      const daily = interaction.options.getInteger("limit_harian");
      const monthly = interaction.options.getInteger("limit_bulanan");

      if (daily === null && monthly === null) {
        await interaction.editReply({
          content: "⚠️ Masukkan minimal satu: `limit_harian` atau `limit_bulanan`.",
        });
        return;
      }

      const result = await updateLimits(
        id,
        {
          dailyLimit: daily ?? undefined,
          monthlyLimit: monthly ?? undefined,
        },
        adminId,
      );

      // Refresh panel order Discord
      refreshOrderPanel(interaction.client).catch(() => {});

      await interaction.editReply({
        content:
          `✅ Limit sender **#${id}** diperbarui:\n` +
          `Harian: ${fmt(result.before.dailyLimit)} → ${fmt(result.after.dailyLimit)}\n` +
          `Bulanan: ${fmt(result.before.monthlyLimit)} → ${fmt(result.after.monthlyLimit)}`,
      });
      return;
    }

    // ==============================
    // STATUS
    // ==============================
    if (sub === "status") {
      const id = interaction.options.getInteger("id", true);
      const status = interaction.options.getString(
        "status",
        true,
      ) as AdminSettableStatus;

      const result = await setSenderStatus(id, status, adminId);

      // Refresh panel order Discord
      refreshOrderPanel(interaction.client).catch(() => {});

      await interaction.editReply({
        content: `✅ Status sender **#${id}**: ${result.before.status} → ${result.after.status}`,
      });
      return;
    }

    // ==============================
    // SYNC
    // ==============================
    if (sub === "sync") {
      const id = interaction.options.getInteger("id");
      const daily = interaction.options.getInteger("harian_terpakai");
      const monthly = interaction.options.getInteger("bulanan_terpakai");

      // 1. SINKRONKAN SEMUA SENDER JIKA ID TIDAK DIBERIKAN
      if (id === null) {
        const liveResults = await getSendersLiveEconomy();
        await refreshOrderPanel(interaction.client).catch(() => {});

        const embed = new EmbedBuilder()
          .setTitle("🔄 Sinkronisasi Semua Akun Sender Selesai")
          .setColor(0x2ecc71)
          .setDescription(
            `Berhasil menyinkronkan data pemakaian limit dan saldo Roblox untuk **${liveResults.length} akun sender**. Panel order Discord juga telah diperbarui.`,
          )
          .setTimestamp();

        for (const s of liveResults) {
          const bal =
            typeof s.robuxBalance === "number"
              ? `💰 Saldo: **${fmt(s.robuxBalance)} Robux**\n`
              : "";
          embed.addFields({
            name: `#${s.id} · ${s.accountName} · [${s.status}]`,
            value: [
              `Roblox ID: \`${s.robloxUserId}\``,
              bal +
              `Harian: **${fmt(s.dailyUsed)}** / ${fmt(s.dailyLimit)} (sisa **${fmt(s.dailyRemaining)} Robux**)`,
              `Bulanan: **${fmt(s.monthlyUsed)}** / ${fmt(s.monthlyLimit)} (sisa **${fmt(s.monthlyRemaining)} Robux**)`,
            ].join("\n"),
          });
        }

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // 2. SINKRONKAN SENDER TERTENTU
      if ((daily === null) !== (monthly === null)) {
        await interaction.editReply({
          content:
            "⚠️ Untuk isi manual, `harian_terpakai` dan `bulanan_terpakai` harus diisi keduanya.",
        });
        return;
      }

      if (daily !== null && monthly !== null && monthly < daily) {
        await interaction.editReply({
          content: "⚠️ Pemakaian bulanan tidak boleh lebih kecil dari harian.",
        });
        return;
      }

      const result = await syncSenderUsage(
        id,
        adminId,
        daily !== null && monthly !== null
          ? { dailyUsed: daily, monthlyUsed: monthly }
          : undefined,
      );

      // Refresh panel order Discord
      refreshOrderPanel(interaction.client).catch(() => {});

      const lines = [
        `✅ Sender **#${id}** disinkronkan (sumber: ${result.source === "ROBLOX" ? "Roblox" : "isian manual"}).`,
        `Harian: ${fmt(result.before.dailyUsed)} → ${fmt(result.after.dailyUsed)}`,
        `Bulanan: ${fmt(result.before.monthlyUsed)} → ${fmt(result.after.monthlyUsed)}`,
      ];

      if (result.reserved > 0) {
        lines.push(
          `Sudah termasuk ${fmt(result.reserved)} Robux dari transfer yang sedang berjalan.`,
        );
      }

      if (result.detail) {
        lines.push(
          `Rincian perkiraan: 24 jam ${fmt(result.detail.rollingDay)}, ` +
            `hari UTC ${fmt(result.detail.calendarDay)}, ` +
            `30 hari ${fmt(result.detail.rollingMonth)}, ` +
            `bulan UTC ${fmt(result.detail.calendarMonth)} ` +
            "(dipakai yang terbesar).",
        );
      }

      await interaction.editReply({ content: lines.join("\n") });
      return;
    }
  } catch (error) {
    if (error instanceof SenderAdminError) {
      await interaction.editReply({ content: `⚠️ ${error.message}` });
      return;
    }

    throw error;
  }
}
