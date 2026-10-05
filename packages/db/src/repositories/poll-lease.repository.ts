import { getDb } from "../client.js";

/**
 * "Turno" de sondeo compartido entre procesos (app de escritorio y worker en la
 * nube): una fila por `key`, con dueño (`holder`) y vencimiento. Quien consigue
 * el turno corre el sondeo de pedidos; si otro lo tiene vigente, se salta ESA
 * pasada (la hace el otro). Así app y worker nunca procesan los mismos pedidos
 * en paralelo — un descuento de stock o una cancelación aplicada dos veces
 * sería una sobreventa/desajuste real.
 *
 * El vencimiento (10 min por defecto en quien llama) hace que, si un proceso se
 * cae a mitad de pasada, el turno se libere solo. Todo el tiempo se mide con el
 * reloj de la BASE (`now()`), no con el del PC ni el del servidor de GitHub, y
 * la columna es TIMESTAMPTZ para que no dependa de la zona horaria de cada
 * conexión. SQL crudo, mismo criterio que `price-baseline.repository.ts`.
 */

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "PollLease" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "PollLease_pkey" PRIMARY KEY ("key")
)`.trim();

let ensureTablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = getDb()
      .$executeRawUnsafe(ENSURE_TABLE_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensureTablePromise = null;
        throw err;
      });
  }
  return ensureTablePromise;
}

/** Intenta tomar el turno. `true` = es tuyo; `false` = otro proceso lo tiene vigente. */
export async function tryAcquireLease(key: string, holder: string, ttlSeconds: number): Promise<boolean> {
  await ensureTable();
  const rows = await getDb().$queryRawUnsafe<{ holder: string }[]>(
    `INSERT INTO "PollLease" ("key", "holder", "expiresAt")
     VALUES ($1, $2, now() + make_interval(secs => ($3::text)::double precision))
     ON CONFLICT ("key") DO UPDATE
       SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt"
       WHERE "PollLease"."expiresAt" < now() OR "PollLease"."holder" = EXCLUDED."holder"
     RETURNING "holder"`,
    key,
    holder,
    String(ttlSeconds),
  );
  return rows.length > 0;
}

/** Suelta el turno (solo si sigue siendo tuyo — si venció y otro lo tomó, no toca nada). */
export async function releaseLease(key: string, holder: string): Promise<void> {
  await ensureTable();
  await getDb().$executeRawUnsafe(`DELETE FROM "PollLease" WHERE "key" = $1 AND "holder" = $2`, key, holder);
}
