import { getDb } from "../client.js";

/**
 * Registro de "días de despacho" (el usuario lleva paquetes a un punto Blue
 * Express o a un punto de Mercado Libre y la empresa le paga bencina por cada
 * día calendario en que lo hizo). Los datos salen de los correos de Gmail.
 *
 * Igual que `price-baseline.repository.ts`: SQL crudo + creación perezosa e
 * idempotente de las tablas, para no depender de `prisma generate`.
 */

export type ShippingCarrier = "BLUE_EXPRESS" | "MERCADO_LIBRE";

export interface ShippingEmailEventRow {
  gmailMessageId: string;
  carrier: ShippingCarrier;
  /** Día calendario del despacho, formato YYYY-MM-DD (hora de Chile). */
  dispatchDay: string;
  packages: number;
  subject: string;
  receivedAt: Date;
  /** Números de orden de servicio (Blue Express) o de venta (Mercado Libre). */
  orderRefs: string[];
}

export interface ShippingDayOverrideRow {
  day: string; // YYYY-MM-DD
  dispatched: boolean;
  note: string | null;
}

const ENSURE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "ShippingEmailEvent" (
    "gmailMessageId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "dispatchDay" TEXT NOT NULL,
    "packages" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShippingEmailEvent_pkey" PRIMARY KEY ("gmailMessageId")
  )`,
  `ALTER TABLE "ShippingEmailEvent" ADD COLUMN IF NOT EXISTS "orderRefs" TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE "ShippingEmailEvent" ADD COLUMN IF NOT EXISTS "refsParsed" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS "ShippingEmailEvent_dispatchDay_idx" ON "ShippingEmailEvent" ("dispatchDay")`,
  `CREATE TABLE IF NOT EXISTS "ShippingDayOverride" (
    "day" TEXT NOT NULL,
    "dispatched" BOOLEAN NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShippingDayOverride_pkey" PRIMARY KEY ("day")
  )`,
  `CREATE TABLE IF NOT EXISTS "ShippingSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShippingSetting_pkey" PRIMARY KEY ("key")
  )`,
];

let ensurePromise: Promise<void> | null = null;

function ensureShippingTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const db = getDb();
      for (const sql of ENSURE_TABLES_SQL) await db.$executeRawUnsafe(sql);
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

/**
 * Guarda los eventos. Un evento ya guardado NUNCA se borra ni cambia de día (aunque el correo se
 * elimine después de Gmail): si el correo se vuelve a leer solo se completan los números de orden/venta.
 */
export async function insertShippingEvents(events: ShippingEmailEventRow[]): Promise<void> {
  if (events.length === 0) return;
  await ensureShippingTables();
  const db = getDb();
  for (const e of events) {
    await db.$executeRawUnsafe(
      `INSERT INTO "ShippingEmailEvent" ("gmailMessageId", "carrier", "dispatchDay", "packages", "subject", "receivedAt", "orderRefs", "refsParsed")
       VALUES ($1::text, $2::text, $3::text, $4::integer, $5::text, $6::timestamp, $7::text, true)
       ON CONFLICT ("gmailMessageId") DO UPDATE SET "orderRefs" = EXCLUDED."orderRefs", "refsParsed" = true`,
      e.gmailMessageId,
      e.carrier,
      e.dispatchDay,
      e.packages,
      e.subject.slice(0, 300),
      e.receivedAt,
      JSON.stringify(e.orderRefs),
    );
  }
}

function parseRefs(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Eventos cuyo `dispatchDay` empieza con el prefijo (ej. "2026-10"). */
export async function listShippingEventsByMonth(monthPrefix: string): Promise<ShippingEmailEventRow[]> {
  await ensureShippingTables();
  const rows = await getDb().$queryRawUnsafe<
    { gmailMessageId: string; carrier: string; dispatchDay: string; packages: number; subject: string; receivedAt: Date; orderRefs: string }[]
  >(
    `SELECT "gmailMessageId", "carrier", "dispatchDay", "packages", "subject", "receivedAt", "orderRefs"
       FROM "ShippingEmailEvent"
      WHERE "dispatchDay" LIKE $1::text
      ORDER BY "dispatchDay", "receivedAt"`,
    `${monthPrefix}%`,
  );
  return rows.map((r) => ({
    gmailMessageId: r.gmailMessageId,
    carrier: r.carrier as ShippingCarrier,
    dispatchDay: r.dispatchDay,
    packages: Number(r.packages),
    subject: r.subject,
    receivedAt: new Date(r.receivedAt),
    orderRefs: parseRefs(r.orderRefs),
  }));
}

export async function listShippingOverridesByMonth(monthPrefix: string): Promise<ShippingDayOverrideRow[]> {
  await ensureShippingTables();
  const rows = await getDb().$queryRawUnsafe<{ day: string; dispatched: boolean; note: string | null }[]>(
    `SELECT "day", "dispatched", "note" FROM "ShippingDayOverride" WHERE "day" LIKE $1::text ORDER BY "day"`,
    `${monthPrefix}%`,
  );
  return rows.map((r) => ({ day: r.day, dispatched: Boolean(r.dispatched), note: r.note ?? null }));
}

/** `dispatched = null` borra el ajuste manual (el día vuelve a depender solo de los correos). */
export async function setShippingDayOverride(day: string, dispatched: boolean | null, note?: string | null): Promise<void> {
  await ensureShippingTables();
  const db = getDb();
  if (dispatched === null) {
    await db.$executeRawUnsafe(`DELETE FROM "ShippingDayOverride" WHERE "day" = $1::text`, day);
    return;
  }
  await db.$executeRawUnsafe(
    `INSERT INTO "ShippingDayOverride" ("day", "dispatched", "note", "updatedAt")
     VALUES ($1::text, $2::boolean, $3::text, CURRENT_TIMESTAMP)
     ON CONFLICT ("day") DO UPDATE SET "dispatched" = EXCLUDED."dispatched", "note" = EXCLUDED."note", "updatedAt" = CURRENT_TIMESTAMP`,
    day,
    dispatched,
    note ?? null,
  );
}

export async function getShippingSetting(key: string): Promise<string | null> {
  await ensureShippingTables();
  const rows = await getDb().$queryRawUnsafe<{ value: string }[]>(
    `SELECT "value" FROM "ShippingSetting" WHERE "key" = $1::text`,
    key,
  );
  return rows[0]?.value ?? null;
}

export async function setShippingSetting(key: string, value: string): Promise<void> {
  await ensureShippingTables();
  await getDb().$executeRawUnsafe(
    `INSERT INTO "ShippingSetting" ("key", "value", "updatedAt") VALUES ($1::text, $2::text, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP`,
    key,
    value,
  );
}

/** De los IDs de Gmail dados, devuelve los ya guardados con sus números de orden/venta ya leídos (esos no se vuelven a descargar). */
export async function listKnownShippingMessageIds(ids: string[]): Promise<Map<string, boolean>> {
  const known = new Map<string, boolean>();
  if (ids.length === 0) return known;
  await ensureShippingTables();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, idx) => `$${idx + 1}::text`).join(", ");
    const rows = await getDb().$queryRawUnsafe<{ gmailMessageId: string; refsParsed: boolean }[]>(
      `SELECT "gmailMessageId", "refsParsed" FROM "ShippingEmailEvent" WHERE "gmailMessageId" IN (${placeholders})`,
      ...chunk,
    );
    for (const r of rows) known.set(r.gmailMessageId, Boolean(r.refsParsed));
  }
  return known;
}
