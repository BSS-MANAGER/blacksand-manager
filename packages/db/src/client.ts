import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Singleton del cliente Prisma para todo el proceso (main de Electron o scripts). */
export function getDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

export type { PrismaClient } from "@prisma/client";
