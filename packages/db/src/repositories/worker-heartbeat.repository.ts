import { getDb } from "../client.js";

/**
 * "Latido" del worker en la nube: cada vez que corre deja anotado cuándo, si
 * salió bien y un resumen — así la app de escritorio puede mostrar "última
 * revisión en la nube: hace 7 min" y el usuario se entera si dejó de correr
 * (sin esto, un worker caído no avisa a nadie). SQL crudo, mismo criterio que
 * `price-baseline.repository.ts`; columnas de fecha TIMESTAMPTZ medidas con el
 * reloj de la base.
 */

export interface WorkerHeartbeatRow {
  key: string;
  lastRunAt: Date;
  /** Última vez que una pasada terminó SIN error (null = nunca). */
  lastOkAt: Date | null;
  lastSummary: string | null;
  lastError: string | null;
  /** Segundos transcurridos desde `lastRunAt` según el reloj de la base. */
  secondsSinceRun: number;
}

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMPTZ NOT NULL,
    "lastOkAt" TIMESTAMPTZ,
    "lastSummary" TEXT,
    "lastError" TEXT,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("key")
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

/** Anota una pasada del worker. `error` null = salió bien. */
export async function recordWorkerHeartbeat(key: string, summary: string | null, error: string | null): Promise<void> {
  await ensureTable();
  await getDb().$executeRawUnsafe(
    `INSERT INTO "WorkerHeartbeat" ("key", "lastRunAt", "lastOkAt", "lastSummary", "lastError")
     VALUES ($1, now(), CASE WHEN $3::text IS NULL THEN now() ELSE NULL END, $2, $3)
     ON CONFLICT ("key") DO UPDATE SET
       "lastRunAt" = now(),
       "lastOkAt" = CASE WHEN $3::text IS NULL THEN now() ELSE "WorkerHeartbeat"."lastOkAt" END,
       "lastSummary" = $2,
       "lastError" = $3`,
    key,
    summary,
    error,
  );
}

export async function readWorkerHeartbeat(key: string): Promise<WorkerHeartbeatRow | null> {
  await ensureTable();
  const rows = await getDb().$queryRawUnsafe<
    {
      key: string;
      lastRunAt: Date;
      lastOkAt: Date | null;
      lastSummary: string | null;
      lastError: string | null;
      secondsSinceRun: number | string;
    }[]
  >(
    `SELECT "key", "lastRunAt", "lastOkAt", "lastSummary", "lastError",
            EXTRACT(EPOCH FROM (now() - "lastRunAt"))::double precision AS "secondsSinceRun"
       FROM "WorkerHeartbeat" WHERE "key" = $1`,
    key,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key: r.key,
    lastRunAt: new Date(r.lastRunAt),
    lastOkAt: r.lastOkAt ? new Date(r.lastOkAt) : null,
    lastSummary: r.lastSummary ?? null,
    lastError: r.lastError ?? null,
    secondsSinceRun: Number(r.secondsSinceRun),
  };
}
