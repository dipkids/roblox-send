import { prisma } from "../database/prisma.js";

interface MidtransQrisAction {
  name: string;
  method: string;
  url: string;
}

interface MidtransQrisResponse {
  status_code: string;
  status_message: string;
  transaction_id?: string;
  order_id?: string;
  merchant_id?: string;
  gross_amount?: string;
  currency?: string;
  payment_type?: string;
  transaction_time?: string;
  transaction_status?: string;
  fraud_status?: string;
  acquirer?: string;
  expiry_time?: string;
  actions?: MidtransQrisAction[];
}

interface SnapTransactionResponse {
  token: string;
  redirect_url: string;
  error_messages?: string[];
}

export function getMidtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    throw new Error("MIDTRANS_SERVER_KEY belum diatur di .env");
  }

  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === "true";

  const baseUrl = isProduction
    ? "https://api.midtrans.com"
    : "https://api.sandbox.midtrans.com";

  return {
    serverKey,
    baseUrl,
    isProduction,
  };
}

async function createSnapTransaction(params: {
  serverKey: string;
  isProduction: boolean;
  orderNumber: string;
  totalAmount: number;
}): Promise<SnapTransactionResponse> {
  const snapBaseUrl = params.isProduction
    ? "https://app.midtrans.com"
    : "https://app.sandbox.midtrans.com";

  const authorization = Buffer.from(`${params.serverKey}:`).toString("base64");

  const response = await fetch(`${snapBaseUrl}/snap/v1/transactions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${authorization}`,
    },
    body: JSON.stringify({
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
      enabled_payments: ["other_qris", "gopay", "qris", "shopeepay"],
      expiry: {
        unit: "minutes",
        duration: 15,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Midtrans Snap Error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as SnapTransactionResponse;

  if (!data.token || !data.redirect_url) {
    throw new Error(
      `Midtrans Snap tidak mengembalikan token/redirect_url: ${JSON.stringify(data)}`,
    );
  }

  return data;
}

// ==============================
// CREATE DYNAMIC QRIS / PAYMENT
// ==============================

export async function createDynamicQris(params: {
  orderId: number;
  orderNumber: string;
  totalAmount: number;
}) {
  const { serverKey, baseUrl, isProduction } = getMidtransConfig();

  // ==============================
  // CEK PAYMENT YANG SUDAH ADA
  // ==============================

  const existingPayment = await prisma.payment.findUnique({
    where: {
      orderId: params.orderId,
    },
  });

  if (existingPayment) {
    const raw = existingPayment.rawNotification as any;
    return {
      payment: existingPayment,
      qrCodeUrl: raw?.qrCodeUrl ?? null,
      paymentUrl: raw?.redirect_url ?? null,
      alreadyExists: true,
      transactionId: existingPayment.transactionId ?? "",
      midtransOrderId: existingPayment.midtransOrderId,
      expiredAt: existingPayment.expiredAt,
      isProduction,
    };
  }

  // ==============================
  // 1. COBA CORE API (Direct Charge)
  // ==============================

  let useSnap = false;
  let coreData: MidtransQrisResponse | null = null;
  let snapData: SnapTransactionResponse | null = null;

  try {
    const authorization = Buffer.from(`${serverKey}:`).toString("base64");

    const response = await fetch(`${baseUrl}/v2/charge`, {
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
    });

    if (response.ok) {
      coreData = (await response.json()) as MidtransQrisResponse;
      // Jika status_code 402 ("Payment channel is not activated"), alihkan ke Snap
      if (coreData.status_code === "402") {
        useSnap = true;
      }
    } else {
      useSnap = true;
    }
  } catch (err) {
    useSnap = true;
  }

  // ==============================
  // 2. JIKA CORE API 402, PAKAI SNAP CHECKOUT
  // ==============================

  if (useSnap || !coreData?.transaction_id) {
    console.log(
      `ℹ️ Menggunakan Midtrans Snap Checkout untuk order ${params.orderNumber}...`,
    );

    snapData = await createSnapTransaction({
      serverKey,
      isProduction,
      orderNumber: params.orderNumber,
      totalAmount: params.totalAmount,
    });
  }

  const defaultExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 menit

  // ==============================
  // SIMPAN PAYMENT (SNAP MODE)
  // ==============================

  if (snapData) {
    const payment = await prisma.payment.create({
      data: {
        orderId: params.orderId,
        provider: "MIDTRANS",
        midtransOrderId: params.orderNumber,
        transactionId: snapData.token,
        grossAmount: params.totalAmount,
        paymentMethod: "snap_qris",
        status: "PENDING",
        signatureValid: false,
        rawNotification: JSON.parse(JSON.stringify(snapData)),
        expiredAt: defaultExpiry,
      },
    });

    console.log(
      `✅ Midtrans Snap Payment dibuat: ${params.orderNumber} -> ${snapData.redirect_url}`,
    );

    return {
      payment,
      qrCodeUrl: null,
      paymentUrl: snapData.redirect_url,
      alreadyExists: false,
      transactionId: snapData.token,
      midtransOrderId: params.orderNumber,
      expiredAt: defaultExpiry,
      isProduction,
    };
  }

  // ==============================
  // SIMPAN PAYMENT (CORE API MODE)
  // ==============================

  const qrAction =
    coreData!.actions?.find((a) => a.name === "generate-qr-code-v2") ??
    coreData!.actions?.find((a) => a.name === "generate-qr-code");

  const qrCodeUrl = qrAction?.url ?? null;
  const expiredAt = coreData!.expiry_time
    ? new Date(coreData!.expiry_time)
    : defaultExpiry;

  const payment = await prisma.payment.create({
    data: {
      orderId: params.orderId,
      provider: "MIDTRANS",
      midtransOrderId: coreData!.order_id!,
      transactionId: coreData!.transaction_id!,
      grossAmount: params.totalAmount,
      paymentMethod: "qris",
      status: "PENDING",
      signatureValid: false,
      rawNotification: JSON.parse(JSON.stringify(coreData)),
      expiredAt,
    },
  });

  console.log(`✅ Midtrans Direct QRIS dibuat: ${params.orderNumber}`);

  return {
    payment,
    qrCodeUrl,
    paymentUrl: null,
    alreadyExists: false,
    transactionId: coreData!.transaction_id!,
    midtransOrderId: coreData!.order_id!,
    expiredAt,
    isProduction,
  };
}
