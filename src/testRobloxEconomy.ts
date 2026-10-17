import "dotenv/config";

const cookie = process.env.ROBLOX_TEST_COOKIE;
const userId = process.env.ROBLOX_TEST_USER_ID;

if (!cookie || !userId) {
  throw new Error("Isi ROBLOX_TEST_COOKIE dan ROBLOX_TEST_USER_ID di .env");
}

const url =
  `https://apis.roblox.com/transaction-records/v1/users/${userId}/transactions` +
  `?cursor=&limit=100&transactionType=CurrencyTransfer&itemPricingType=PaidAndLimited`;

const res = await fetch(url, {
  headers: {
    Cookie: `.ROBLOSECURITY=${cookie}`,
    Accept: "application/json",
    Referer: "https://www.roblox.com/",
  },
});

const text = await res.text();

console.log("status:", res.status);

try {
  const body = JSON.parse(text);

  console.log("kunci teratas:", Object.keys(body));

  const records = body.data ?? body.transactions ?? body.records;

  if (Array.isArray(records)) {
    console.log("jumlah record:", records.length);
    console.dir(records.slice(0, 3), { depth: 6 });
  } else {
    console.dir(body, { depth: 4 });
  }
} catch {
  console.log(text.slice(0, 1500));
}