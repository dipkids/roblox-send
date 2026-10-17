export interface RobloxTransferRecord {
  idHash: string;
  transferRequestId: string;
  role: string;
  senderId: string;
  receiverId: string;
  amount: number; // negatif = kirim
  created: Date;
  isPending: boolean;
}

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface ApiRecord {
  idHash?: string;
  created?: string;
  isPending?: boolean;
  details?: {
    transferRequestId?: string;
    transferRole?: string;
    senderTargetId?: string;
    receiverTargetId?: string;
  };
  currency?: { amount?: number };
}

// Cookie dibaca dari env: ROBLOX_COOKIE_<robloxUserId>.
// Jangan pernah dicetak ke log atau disimpan di database.
function getCookie(robloxUserId: string): string | null {
  return process.env[`ROBLOX_COOKIE_${robloxUserId}`] ?? null;
}

export async function fetchTransferRecords(
  robloxUserId: string,
  since: Date,
  maxPages = 5,
): Promise<ReadResult<RobloxTransferRecord[]>> {
  const cookie = getCookie(robloxUserId);

  if (!cookie) {
    return {
      ok: false,
      reason: `ROBLOX_COOKIE_${robloxUserId} belum diatur.`,
    };
  }

  const records: RobloxTransferRecord[] = [];
  let cursor = "";

  try {
    for (let page = 0; page < maxPages; page++) {
      const url =
        `https://apis.roblox.com/transaction-records/v1/users/${robloxUserId}/transactions` +
        `?cursor=${encodeURIComponent(cursor)}&limit=100` +
        `&transactionType=CurrencyTransfer&itemPricingType=PaidAndLimited`;

      const res = await fetch(url, {
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`,
          Accept: "application/json",
          Referer: "https://www.roblox.com/",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return { ok: false, reason: `Roblox API status ${res.status}` };
      }

      const body = (await res.json()) as {
        data?: ApiRecord[];
        nextPageCursor?: string | null;
      };

      let reachedOlder = false;

      for (const item of body.data ?? []) {
        const created = new Date(item.created ?? "");
        const requestId = item.details?.transferRequestId;
        const amount = item.currency?.amount;

        if (
          Number.isNaN(created.getTime()) ||
          !requestId ||
          typeof amount !== "number"
        ) {
          continue;
        }

        // Daftar terurut dari yang terbaru
        if (created < since) {
          reachedOlder = true;
          continue;
        }

        records.push({
          idHash: item.idHash ?? "",
          transferRequestId: requestId,
          role: item.details?.transferRole ?? "",
          senderId: item.details?.senderTargetId ?? "",
          receiverId: item.details?.receiverTargetId ?? "",
          amount,
          created,
          isPending: item.isPending ?? false,
        });
      }

      if (reachedOlder || !body.nextPageCursor) break;

      cursor = body.nextPageCursor;
    }

    return { ok: true, value: records };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Error tidak diketahui",
    };
  }
}

export function matchTransfer(
  records: RobloxTransferRecord[],
  expected: {
    transferRequestId: string;
    receiverRobloxId: string;
    robuxAmount: number;
  },
) {
  const record = records.find(
    (r) =>
      r.transferRequestId === expected.transferRequestId &&
      r.role === "Sender",
  );

  if (!record) return { status: "NOT_FOUND" as const };
  if (record.isPending) return { status: "PENDING" as const, record };

  const matches =
    Math.abs(record.amount) === expected.robuxAmount &&
    record.receiverId === expected.receiverRobloxId;

  return { status: matches ? ("CONFIRMED" as const) : ("MISMATCH" as const), record };
}

// Ambil nilai yang LEBIH BESAR dari dua tafsiran jendela,
// karena aturan reset Roblox belum diketahui.
export function estimateUsage(
  records: RobloxTransferRecord[],
  now = new Date(),
) {
  const sent = records.filter((r) => r.role === "Sender" && r.amount < 0);

  const sum = (from: Date) =>
    sent
      .filter((r) => r.created >= from)
      .reduce((total, r) => total + Math.abs(r.amount), 0);

  const rollingDay = sum(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const rollingMonth = sum(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  const calendarDay = sum(
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ),
  );

  const calendarMonth = sum(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  );

  return {
    dailyUsed: Math.max(rollingDay, calendarDay),
    monthlyUsed: Math.max(rollingMonth, calendarMonth),
    detail: { rollingDay, calendarDay, rollingMonth, calendarMonth },
  };
}