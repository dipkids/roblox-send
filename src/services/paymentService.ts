import { prisma } from "../database/prisma.js";

interface MidtransQrisAction {
  name: string;
  method: string;
  url: string;
}

interface MidtransQrisResponse {
  status_code: string;
  status_message: string;
  transaction_id: string;
  order_id: string;
  merchant_id: string;
  gross_amount: string;
  currency: string;
  payment_type: string;
  transaction_time: string;
  transaction_status: string;
  fraud_status?: string;
  acquirer?: string;
  expiry_time?: string;
  actions?: MidtransQrisAction[];
}

function getMidtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    throw new Error(
      "MIDTRANS_SERVER_KEY belum diatur di .env",
    );
  }

  const isProduction =
    process.env.MIDTRANS_IS_PRODUCTION === "true";

  const baseUrl = isProduction
    ? "https://api.midtrans.com"
    : "https://api.sandbox.midtrans.com";

  return {
    serverKey,
    baseUrl,
    isProduction,
  };
}

// ==============================
// CREATE DYNAMIC QRIS
// ==============================

export async function createDynamicQris(params: {
  orderId: number;
  orderNumber: string;
  totalAmount: number;
}) {
  const {
    serverKey,
    baseUrl,
    isProduction,
  } = getMidtransConfig();

  // ==============================
  // CEK PAYMENT YANG SUDAH ADA
  // ==============================

  const existingPayment =
    await prisma.payment.findUnique({
      where: {
        orderId: params.orderId,
      },
    });

  if (existingPayment) {
    return {
      payment: existingPayment,
      qrCodeUrl: null,
      alreadyExists: true,
    };
  }

  // ==============================
  // MIDTRANS REQUEST
  // ==============================

  const authorization = Buffer.from(
    `${serverKey}:`,
  ).toString("base64");

  const response = await fetch(
    `${baseUrl}/v2/charge`,
    {
      method: "POST",

      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${authorization}`,
      },

      body: JSON.stringify({
        payment_type: "qris",

        transaction_details: {
          order_id: params.orderNumber,
          gross_amount: params.totalAmount,
        },

        item_details: [
          {
            id: params.orderNumber,
            price: params.totalAmount,
            quantity: 1,
            name: `AutoVisend ${params.orderNumber}`,
          },
        ],

        qris: {
          acquirer: "gopay",
        },
      }),
    },
  );

  // ==============================
  // HANDLE ERROR
  // ==============================

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Midtrans QRIS Error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data =
    (await response.json()) as MidtransQrisResponse;

  // ==============================
  // VALIDASI RESPONSE
  // ==============================

  if (!data.transaction_id) {
    throw new Error(
      "Midtrans tidak mengembalikan transaction_id.",
    );
  }

  // ==============================
  // AMBIL QR CODE URL
  // ==============================

  const qrAction =
    data.actions?.find(
      (action) =>
        action.name === "generate-qr-code-v2",
    ) ??
    data.actions?.find(
      (action) =>
        action.name === "generate-qr-code",
    );

  const qrCodeUrl =
    qrAction?.url ?? null;

  if (!qrCodeUrl) {
    throw new Error(
      "Midtrans tidak mengembalikan URL QRIS.",
    );
  }

  // ==============================
  // EXPIRY
  // ==============================

  const expiredAt = data.expiry_time
    ? new Date(data.expiry_time)
    : null;

  // ==============================
  // SIMPAN PAYMENT
  // ==============================

  const payment =
    await prisma.payment.create({
      data: {
        orderId: params.orderId,

        provider: "MIDTRANS",

        midtransOrderId:
          data.order_id,

        transactionId:
          data.transaction_id,

        grossAmount:
          params.totalAmount,

        paymentMethod:
          "qris",

        status:
          "PENDING",

        signatureValid:
          false,

        rawNotification: JSON.parse(
            JSON.stringify(data),
        ),

        expiredAt,
      },
    });

  console.log(
    `Midtrans QRIS created: ${params.orderNumber}`,
  );

  return {
    payment,

    qrCodeUrl,

    alreadyExists: false,

    transactionId:
      data.transaction_id,

    midtransOrderId:
      data.order_id,

    expiredAt,

    isProduction,
  };
}