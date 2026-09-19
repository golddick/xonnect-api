const { PrismaClient } = require("../generated/prisma");

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "30");
  process.env.DATABASE_URL = url.toString();
}

// Reuse a single PrismaClient instance across hot reloads / requests.
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
