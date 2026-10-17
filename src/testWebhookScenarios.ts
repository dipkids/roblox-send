import "dotenv/config";
import crypto from "node:crypto";
import { prisma } from "./database/prisma.js";

const URL_WEBHOOK =
  process.env.WEBHOOK_URL ?? "http://localhost:3000/webhook/midtrans";
const serverKey = process.env.MIDTRANS_SERVER_KEY;

if (!serverKey) throw new Error("MIDTRANS_SERVER_KEY belum diatur.");

const template = await prisma.order.findFirst();

if (!template) throw new Error("Butuh template order.");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;
let failures = 0;

function record(name: string, ok: boolean, info: string) {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` → ${info}`}`);
}

async function seed(
  orderStatus: "PAYMENT_PENDING" | "CANCELLED",
  paymentStatus: "PENDING" = "PENDING",
) {
  const stamp = `${Date.now()}-${++counter}`;

  const order = await prisma.order.create({
    data: {
      orderNumber: `AV-TEST-PAY-${stamp}`,
      userId: template!.userId,
      robloxProfileId: template!.robloxProfileId,
      robuxAmount: 10,
      productPrice: 1000,
      totalAmount: 1000,
      status: orderStatus,
    },
  });

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      midtransOrderId: `TEST-PAY-${stamp}`,
      grossAmount: 1000,
      paymentMethod: "qris",
      status: paymentStatus,
    },
  });

  return { order, payment };
}

function notification(
  midtransOrderId: string,
  status: "settlement" | "pending" | "expire",
  overrides: { gross_amount?: string; signature_key?: string } = {},
) {
  const statusCode =
    status === "settlement" ? "200" : status === "pending" ? "201" : "407";
  const grossAmount = overrides.gross_amount ?? "1000.00";

  const signature = crypto
    .createHash("sha512")
    .update(midtransOrderId + statusCode + grossAmount + serverKey)
    .digest("hex");

  return {
    transaction_time: new Date().toISOString(),
    transaction_status: status,
    transaction_id: `TEST-TX-${midtransOrderId}`,
    status_code: statusCode,
    signature_key: overrides.signature_key ?? signature,
    payment_type: "qris",
    order_id: midtransOrderId,
    merchant_id: "TEST",
    gross_amount: grossAmount,
    fraud_status: "accept",
  };
}

async function send(body: object) {
  const res = await fetch(URL_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: res.status, text: await res.text() };
}

async function snapshot(orderId: number) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payment: true, transfers: true },
  });

  const events = await prisma.orderEvent.findMany({
    where: { orderId },
    select: { eventType: true },
  });

  const count = (type: string) =>
    events.filter((e) => e.eventType === type).length;

  return {
    order: order.status,
    payment: order.payment?.status,
    transfers: order.transfers.length,
    paidEvents: count("PAYMENT_PAID"),
    lateEvents: count("LATE_PAYMENT"),
  };
}

async function waitForOrder(orderId: number, status: string, ms = 60000) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    if ((await snapshot(orderId)).order === status) return true;
    await sleep(1500);
  }

  return false;
}

// ---------------- A ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  const r = await send(notification(payment.midtransOrderId, "settlement"));
  const done = await waitForOrder(order.id, "COMPLETED");
  const s = await snapshot(order.id);

  record(
    "A. Settlement sampai COMPLETED",
    r.status === 200 &&
      done &&
      s.payment === "PAID" &&
      s.transfers === 1 &&
      s.paidEvents === 1,
    JSON.stringify({ http: r.status, ...s }),
  );
}

// ---------------- B ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  await send(notification(payment.midtransOrderId, "settlement"));
  const second = await send(notification(payment.midtransOrderId, "settlement"));
  const done = await waitForOrder(order.id, "COMPLETED");
  const s = await snapshot(order.id);

  record(
    "B. Settlement duplikat berurutan",
    done &&
      second.status === 200 &&
      second.text.includes("Already processed") &&
      s.transfers === 1 &&
      s.paidEvents === 1,
    JSON.stringify({ second: second.text, ...s }),
  );
}

// ---------------- C ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  const body = notification(payment.midtransOrderId, "settlement");
  await Promise.all([send(body), send(body), send(body)]);
  const done = await waitForOrder(order.id, "COMPLETED");
  const s = await snapshot(order.id);

  record(
    "C. Settlement 3x bersamaan",
    done && s.transfers === 1 && s.paidEvents === 1,
    JSON.stringify(s),
  );
}

// ---------------- D ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  await send(notification(payment.midtransOrderId, "settlement"));
  await waitForOrder(order.id, "COMPLETED");
  await send(notification(payment.midtransOrderId, "pending"));
  const s = await snapshot(order.id);

  record(
    "D. Pending terlambat setelah settlement",
    s.order === "COMPLETED" && s.payment === "PAID",
    JSON.stringify(s),
  );
}

// ---------------- E ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  await send(notification(payment.midtransOrderId, "settlement"));
  await waitForOrder(order.id, "COMPLETED");
  await send(notification(payment.midtransOrderId, "expire"));
  const s = await snapshot(order.id);

  record(
    "E. Expire terlambat setelah settlement",
    s.order === "COMPLETED" && s.payment === "PAID",
    JSON.stringify(s),
  );
}

// ---------------- F ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  await send(notification(payment.midtransOrderId, "expire"));
  const afterExpire = await snapshot(order.id);
  await send(notification(payment.midtransOrderId, "settlement"));
  const s = await snapshot(order.id);

  record(
    "F. Settlement terlambat setelah expire → MANUAL_REVIEW",
    afterExpire.order === "PAYMENT_TIMEOUT" &&
      s.order === "MANUAL_REVIEW" &&
      s.payment === "PAID" &&
      s.transfers === 0 &&
      s.lateEvents === 1,
    JSON.stringify({ afterExpire: afterExpire.order, ...s }),
  );
}

// ---------------- G ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  await send(notification(payment.midtransOrderId, "pending"));
  await send(notification(payment.midtransOrderId, "expire"));
  const s = await snapshot(order.id);

  record(
    "G. Pending lalu expire (timeout normal)",
    s.order === "PAYMENT_TIMEOUT" && s.payment === "EXPIRED",
    JSON.stringify(s),
  );
}

// ---------------- I ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  const r = await send(
    notification(payment.midtransOrderId, "settlement", {
      signature_key: "salah",
    }),
  );
  const s = await snapshot(order.id);

  record(
    "I. Signature tidak valid ditolak",
    r.status === 401 && s.payment === "PENDING",
    JSON.stringify({ http: r.status, ...s }),
  );
}

// ---------------- J ----------------
{
  const { order, payment } = await seed("PAYMENT_PENDING");
  const r = await send(
    notification(payment.midtransOrderId, "settlement", {
      gross_amount: "999.00",
    }),
  );
  const s = await snapshot(order.id);

  record(
    "J. Nominal salah ditolak",
    r.status === 400 && s.payment === "PENDING",
    JSON.stringify({ http: r.status, ...s }),
  );
}

// ---------------- K ----------------
{
  const r = await send(notification("TEST-PAY-TIDAK-ADA", "settlement"));

  record("K. order_id tidak dikenal → 404", r.status === 404, `http ${r.status}`);
}

// ---------------- L ----------------
{
  const { order, payment } = await seed("CANCELLED");
  await send(notification(payment.midtransOrderId, "settlement"));
  const s = await snapshot(order.id);

  record(
    "L. Settlement untuk order CANCELLED → MANUAL_REVIEW",
    s.order === "MANUAL_REVIEW" && s.payment === "PAID" && s.lateEvents === 1,
    JSON.stringify(s),
  );
}

console.log(failures === 0 ? "\n✅ SEMUA LULUS" : `\n❌ ${failures} SKENARIO GAGAL`);

await prisma.$disconnect();