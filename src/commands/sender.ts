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

export const data = new SlashCommandBuilder()
  .setName("sender")
  .setDescription("Kelola akun sender Robux (khusus admin)")
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Lihat semua sender dan sisa kuotanya"),
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
      .setDescription("Sinkronkan pemakaian dari Roblox, atau isi manual")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("ID sender")
          .setRequired(true)
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
      const senders = await listSenders();

      if (senders.length === 0) {
        await interaction.editReply({
          content: "Belum ada sender. Tambahkan dengan `/sender add`.",
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏦 Sender Accounts")
        .setColor(0x3498db)
        .setDescription(
          "Pemakaian berasal dari counter lokal. Jalankan `/sender sync` untuk menyelaraskan dengan Roblox.",
        );

      for (const sender of senders.slice(0, 25)) {
        const usage = effectiveUsage(sender);

        embed.addFields({
          name: `#${sender.id} · ${sender.accountName} · ${sender.status}`,
          value: [
            `Roblox ID: ${sender.robloxUserId}`,
            `Harian: ${fmt(usage.dailyUsed)} / ${fmt(sender.dailyLimit)} ` +
              `(sisa ${fmt(Math.max(sender.dailyLimit - usage.dailyUsed, 0))})`,
            `Bulanan: ${fmt(usage.monthlyUsed)} / ${fmt(sender.monthlyLimit)} ` +
              `(sisa ${fmt(Math.max(sender.monthlyLimit - usage.monthlyUsed, 0))})`,
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

      const result = await updateLimits(
        id,
        {
          dailyLimit:
            interaction.options.getInteger("limit_harian") ?? undefined,
          monthlyLimit:
            interaction.options.getInteger("limit_bulanan") ?? undefined,
        },
        adminId,
      );

      await interaction.editReply({
        content:
          `✅ Limit sender **#${id}** diperbarui.\n` +
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

      await interaction.editReply({
        content: `✅ Status sender **#${id}**: ${result.before.status} → ${result.after.status}`,
      });
      return;
    }

    // ==============================
    // SYNC
    // ==============================
    if (sub === "sync") {
      const id = interaction.options.getInteger("id", true);
      const daily = interaction.options.getInteger("harian_terpakai");
      const monthly = interaction.options.getInteger("bulanan_terpakai");

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