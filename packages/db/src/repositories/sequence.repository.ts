import { getDb } from "../client.js";

/**
 * Fase 3f: siguiente valor de un contador correlativo genérico (hoy solo
 * `key: "venta_presencial"`, para el número "VP-#0001" de las ventas de
 * mostrador — ver `formatVentaPresencialNumber` en `@blacksand/core-domain`).
 * `upsert` con `value: { increment: 1 }` es una sola sentencia atómica: no
 * hace falta envolverlo en una transacción aparte para evitar que dos
 * ventas registradas casi al mismo tiempo reciban el mismo número.
 */
export async function nextSequenceValue(key: string): Promise<number> {
  const db = getDb();
  const counter = await db.sequenceCounter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
  });
  return counter.value;
}
