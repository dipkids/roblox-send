import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL belum diatur di file .env",
  );
}

const adapter = new PrismaPg({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 10 * 60 * 1000, // default 10 detik
  connectionTimeoutMillis: 30_000,   // cukup untuk cold start 16 detik
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

export const prisma = new PrismaClient({
  adapter,

  transactionOptions: {
    maxWait: 30000,
    timeout: 30000,
  },
});

