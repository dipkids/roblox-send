import { prisma } from "../src/database/prisma.js";

async function main() {
  console.log("========================================");
  console.log("🧹 MEMBERSIHKAN DATA TESTING DATABASE");
  console.log("========================================");

  try {
    // 1. Hapus semua data yang berhubungan dengan order
    console.log("⏳ Menghapus transaksi, order, tiket, dan event...");
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderEvent", "AdminAction", "Ticket", "Transfer", "Payment", "Order" CASCADE;
    `);

    // 2. Reset pemakaian kuota semua sender ke 0
    console.log("🔄 Mereset kuota terpakai semua akun sender ke 0...");
    await prisma.senderAccount.updateMany({
      data: {
        dailyUsed: 0,
        monthlyUsed: 0,
      },
    });

    console.log("========================================");
    console.log("✅ SUKSES! Database order bersih kembali.");
    console.log("Akun sender dan setting rate tetap aman.");
    console.log("========================================");
  } catch (error) {
    console.error("❌ Gagal membersihkan database:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
