import { getDb } from "../client.js";

/**
 * "Precio normal" guardado por variante de Shopify — ver el comentario
 * grande del modelo `VariantPriceBaseline` en `schema.prisma` y
 * `bulk-discount.ts` (@blacksand/sync-engine), que es quien decide cuándo
 * guardar/actualizar estas filas.
 *
 * Todo el acceso es con SQL crudo (en vez de `db.variantPriceBaseline`) a
 * propósito: así esta tabla funciona sin que el usuario tenga que correr
 * `prisma generate` para regenerar el cliente — la app empaquetada nunca
 * ejecuta el CLI de Prisma (ver `schema-migrations.ts`).
 */

export interface VariantPriceBaselineRow {
  variantGid: string;
  productGid: string;
  productTitle: string;
  sku: string | null;
  /** El precio normal. */
  baselinePrice: number;
  /** Último precio que la app escribió en Shopify para esta variante (`null` = la app nunca la tocó desde que se guardó el precio normal). */
  lastAppliedPrice: number | null;
  lastAppliedCompareAt: number | null;
  /** Estado inmediatamente anterior a esa última escritura de la app. */
  prevPrice: number | null;
  prevCompareAt: number | null;
}

// Mismo DDL que `migrations/20261004120000_add_variant_price_baseline` (idempotente): por si la migración no corrió (ej. app empaquetada sin carpeta de migraciones), la tabla se crea acá la primera vez que se usa.
const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "VariantPriceBaseline" (
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "sku" TEXT,
    "baselinePrice" DOUBLE PRECISION NOT NULL,
    "lastAppliedPrice" DOUBLE PRECISION,
    "lastAppliedCompareAt" DOUBLE PRECISION,
    "prevPrice" DOUBLE PRECISION,
    "prevCompareAt" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariantPriceBaseline_pkey" PRIMARY KEY ("variantGid")
)`.trim();

let ensureTablePromise: Promise<void> | null = null;

function ensureBaselineTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = getDb()
      .$executeRawUnsafe(ENSURE_TABLE_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensureTablePromise = null; // se reintenta la próxima vez
        throw err;
      });
  }
  return ensureTablePromise;
}

export async function listVariantPriceBaselines(): Promise<VariantPriceBaselineRow[]> {
  await ensureBaselineTable();
  const rows = await getDb().$queryRawUnsafe<VariantPriceBaselineRow[]>(
    `SELECT "variantGid", "productGid", "productTitle", "sku", "baselinePrice",
            "lastAppliedPrice", "lastAppliedCompareAt", "prevPrice", "prevCompareAt"
       FROM "VariantPriceBaseline"
      ORDER BY "productTitle", "variantGid"`,
  );
  return rows.map((r) => ({
    variantGid: r.variantGid,
    productGid: r.productGid,
    productTitle: r.productTitle,
    sku: r.sku ?? null,
    baselinePrice: Number(r.baselinePrice),
    lastAppliedPrice: r.lastAppliedPrice === null ? null : Number(r.lastAppliedPrice),
    lastAppliedCompareAt: r.lastAppliedCompareAt === null ? null : Number(r.lastAppliedCompareAt),
    prevPrice: r.prevPrice === null ? null : Number(r.prevPrice),
    prevCompareAt: r.prevCompareAt === null ? null : Number(r.prevCompareAt),
  }));
}

const UPSERT_CHUNK_SIZE = 100;

/** Inserta o actualiza (por `variantGid`) las filas indicadas, en tandas — una sola consulta por cada 100 filas, no una por fila. */
export async function upsertVariantPriceBaselines(rows: VariantPriceBaselineRow[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureBaselineTable();
  const db = getDb();

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const params: unknown[] = [];
    const tuples = chunk.map((r, idx) => {
      const b = idx * 9;
      params.push(
        r.variantGid,
        r.productGid,
        r.productTitle,
        r.sku,
        r.baselinePrice,
        r.lastAppliedPrice,
        r.lastAppliedCompareAt,
        r.prevPrice,
        r.prevCompareAt,
      );
      return (
        `($${b + 1}::text, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text, $${b + 5}::double precision, ` +
        `$${b + 6}::double precision, $${b + 7}::double precision, $${b + 8}::double precision, $${b + 9}::double precision, CURRENT_TIMESTAMP)`
      );
    });

    await db.$executeRawUnsafe(
      `INSERT INTO "VariantPriceBaseline"
         ("variantGid", "productGid", "productTitle", "sku", "baselinePrice",
          "lastAppliedPrice", "lastAppliedCompareAt", "prevPrice", "prevCompareAt", "updatedAt")
       VALUES ${tuples.join(", ")}
       ON CONFLICT ("variantGid") DO UPDATE SET
         "productGid" = EXCLUDED."productGid",
         "productTitle" = EXCLUDED."productTitle",
         "sku" = EXCLUDED."sku",
         "baselinePrice" = EXCLUDED."baselinePrice",
         "lastAppliedPrice" = EXCLUDED."lastAppliedPrice",
         "lastAppliedCompareAt" = EXCLUDED."lastAppliedCompareAt",
         "prevPrice" = EXCLUDED."prevPrice",
         "prevCompareAt" = EXCLUDED."prevCompareAt",
         "updatedAt" = CURRENT_TIMESTAMP`,
      ...params,
    );
  }
}
