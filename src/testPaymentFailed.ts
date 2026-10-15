import "dotenv/config";
import crypto from "node:crypto";

import { prisma } from "./database/prisma.js";

const orderId = Number(process.argv[2]);

if (!orderId) {
  throw new Error(
    "Gunakan: npx tsx src/testPaymentFailed.ts <orderId>",
  );
}

const payment = await prisma.payment.findUnique({
  where: {
    orderId,
  },
  include: {
    order: true,
  },
});

if (!payment) {
  throw new Error(
    `Payment untuk Order ${orderId} tidak ditemukan.`,
  );
}

if (payment.order.status !== "PAYMENT_PENDING") {
  throw new Error(
    `Order ${orderId} bukan PAYMENT_PENDING. Status sekarang: ${payment.order.status}`,
  );
}

const serverKey = process.env.MIDTRANS_SERVER_KEY;

if (!serverKey) {
  throw new Error(
    "MIDTRANS_SERVER_KEY belum diatur di .env",
  );
}

const orderIdMidtrans = payment.midtransOrderId;
const statusCode = "202";
const grossAmount = payment.grossAmount.toFixed(2);

const rawSignature =
  orderIdMidtrans +
  statusCode +
  grossAmount +
  serverKey;

const signatureKey = crypto
  .createHash("sha512")
  .update(rawSignature)
  .digest("hex");

const notification = {
  transaction_time: new Date().toISOString(),
  transaction_status: "deny",
  transaction_id: `TEST-FAILED-${Date.now()}`,
  status_message: "Simulasi payment gagal untuk testing.",
  status_code: statusCode,
  signature_key: signatureKey,
  payment_type: payment.paymentMethod ?? "qris",
  order_id: orderIdMidtrans,
  merchant_id: process.env.MIDTRANS_MERCHANT_ID ?? "TEST",
  gross_amount: grossAmount,
  fraud_status: "deny",
};

console.log("========================================");
console.log("TEST MIDTRANS PAYMENT FAILED");
console.log("========================================");
console.log("Order ID:", orderId);
console.log("Order Number:", payment.order.orderNumber);
console.log("Midtrans Order ID:", orderIdMidtrans);
console.log("Gross Amount:", grossAmount);
console.log("Transaction Status:", notification.transaction_status);
console.log("========================================");

const response = await fetch(
  "http://localhost:3000/webhook/midtrans",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(notification),
  },
);

const responseText = await response.text();

console.log("HTTP Status:", response.status);
console.log("Response:", responseText);

await prisma.$disconnect();