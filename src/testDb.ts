import "dotenv/config";
import pg from "pg";

const t0 = Date.now();
const since = () => `${Date.now() - t0}ms`;

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

client.connection.once("connect", () =>
  console.log(`TCP terhubung       ${since()}`),
);
client.connection.once("sslconnect", () =>
  console.log(`TLS selesai         ${since()}`),
);
client.connection.once("readyForQuery", () =>
  console.log(`Login selesai       ${since()}`),
);

await client.connect();
console.log(`client.connect()    ${since()}`);

await client.end();