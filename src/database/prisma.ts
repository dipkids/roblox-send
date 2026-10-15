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
});

export const prisma = new PrismaClient({
  adapter,

  transactionOptions: {
    maxWait: 10000,
    timeout: 10000,
  },
});