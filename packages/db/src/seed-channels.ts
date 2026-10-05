import { CHANNEL_CAPABILITIES, CHANNEL_CODES } from "@blacksand/shared";
import { getDb } from "./client.js";

/**
 * Crea (si no existen) las filas base de `channels` con sus capacidades
 * declaradas (sección D.4). Idempotente: se puede correr en cada arranque.
 */
export async function seedChannels(): Promise<void> {
  const db = getDb();
  const names: Record<string, string> = {
    shopify: "Shopify",
    mercadolibre: "Mercado Libre (MLC)",
    meta: "Meta / Facebook (feed catálogo)",
  };

  for (const code of CHANNEL_CODES) {
    await db.channel.upsert({
      where: { code },
      update: { capabilities: JSON.stringify(CHANNEL_CAPABILITIES[code]) },
      create: {
        code,
        name: names[code] ?? code,
        isActive: false,
        capabilities: JSON.stringify(CHANNEL_CAPABILITIES[code]),
      },
    });
  }
}
