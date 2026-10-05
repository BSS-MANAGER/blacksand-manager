import { getDb } from "../client.js";

/**
 * Token VIVO de un canal (hoy solo Mercado Libre), guardado en la base de
 * datos compartida en vez de solo en la bóveda del PC.
 *
 * POR QUÉ: Mercado Libre rota el `refresh_token` en cada refresco y el viejo
 * queda inválido (son de un solo uso). Ahora hay DOS procesos que necesitan
 * un token válido — la app de escritorio y el worker en la nube que sincroniza
 * 24/7. Si cada uno guardara su copia y refrescara por su cuenta, el segundo
 * en refrescar usaría un `refresh_token` ya gastado, Mercado Libre lo
 * rechazaría (`invalid_grant`) y habría que reconectar la cuenta a mano. La
 * única fuente de verdad es esta fila, y TODO refresco se hace dentro de una
 * transacción con la fila bloqueada (`SELECT ... FOR UPDATE`): mientras un
 * proceso refresca, el otro espera y después lee el token ya renovado.
 *
 * Acceso con SQL crudo (mismo criterio que `price-baseline.repository.ts`):
 * no requiere regenerar el cliente de Prisma.
 */

export interface LiveTokenRow {
  channelCode: string;
  accessToken: string;
  refreshToken: string;
  /** ID de usuario del canal (en Mercado Libre, `user_id`), como texto. */
  userId: string | null;
  expiresAt: Date;
}

// Mismo DDL que `migrations/20261005120000_add_channel_live_token` (idempotente).
const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "ChannelLiveToken" (
    "channelCode" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelLiveToken_pkey" PRIMARY KEY ("channelCode")
)`.trim();

// Si la tabla ya existía con otra forma (p. ej. creada por un borrador anterior
// sin la columna "userId", o con una columna "id" obligatoria), `CREATE TABLE IF
// NOT EXISTS` no la corrige: estos pasos la dejan compatible, sin tocar datos.
const REPAIR_SQL = [
  `ALTER TABLE "ChannelLiveToken" ADD COLUMN IF NOT EXISTS "userId" TEXT`,
  `ALTER TABLE "ChannelLiveToken" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  // La consulta de upsert usa ON CONFLICT ("channelCode"): hace falta un índice único ahí (si la tabla vieja tenía otra clave primaria).
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelLiveToken_channelCode_key" ON "ChannelLiveToken" ("channelCode")`,
  // Columnas ajenas y obligatorias (sin valor por defecto): si son la clave primaria (p. ej. "id") reciben un valor automático; si no, pasan a ser opcionales — así nuestros INSERT no fallan.
  `DO $$
   DECLARE c record;
   BEGIN
     FOR c IN
       SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ChannelLiveToken'
          AND is_nullable = 'NO' AND column_default IS NULL
          AND column_name NOT IN ('channelCode', 'accessToken', 'refreshToken', 'expiresAt')
     LOOP
       IF EXISTS (
         SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = '"ChannelLiveToken"'::regclass AND i.indisprimary AND a.attname = c.column_name
       ) THEN
         IF c.data_type = 'uuid' THEN
           EXECUTE format('ALTER TABLE "ChannelLiveToken" ALTER COLUMN %I SET DEFAULT gen_random_uuid()', c.column_name);
         ELSE
           EXECUTE format('ALTER TABLE "ChannelLiveToken" ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', c.column_name);
         END IF;
       ELSE
         EXECUTE format('ALTER TABLE "ChannelLiveToken" ALTER COLUMN %I DROP NOT NULL', c.column_name);
       END IF;
     END LOOP;
   END $$`,
];

let ensureTablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      const db = getDb();
      await db.$executeRawUnsafe(ENSURE_TABLE_SQL);
      for (const statement of REPAIR_SQL) {
        await db.$executeRawUnsafe(statement);
      }
    })().catch((err) => {
      ensureTablePromise = null;
      throw err;
    });
  }
  return ensureTablePromise;
}

interface RawLiveTokenRow {
  channelCode: string;
  accessToken: string;
  refreshToken: string;
  userId: string | null;
  expiresAt: Date | string;
}

function toRow(raw: RawLiveTokenRow): LiveTokenRow {
  return {
    channelCode: raw.channelCode,
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    userId: raw.userId ?? null,
    expiresAt: raw.expiresAt instanceof Date ? raw.expiresAt : new Date(raw.expiresAt),
  };
}

const SELECT_COLUMNS = `"channelCode", "accessToken", "refreshToken", "userId", "expiresAt"`;

/** Lee el token sin bloquear nada (camino rápido: si sigue vigente, no hace falta refrescar). */
export async function readLiveToken(channelCode: string): Promise<LiveTokenRow | null> {
  await ensureTable();
  const rows = await getDb().$queryRawUnsafe<RawLiveTokenRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM "ChannelLiveToken" WHERE "channelCode" = $1`,
    channelCode,
  );
  return rows.length > 0 ? toRow(rows[0]!) : null;
}

/** Guarda/reemplaza el token (ej. al reconectar la cuenta por OAuth). */
export async function upsertLiveToken(row: LiveTokenRow): Promise<void> {
  await ensureTable();
  await getDb().$executeRawUnsafe(
    `INSERT INTO "ChannelLiveToken" ("channelCode", "accessToken", "refreshToken", "userId", "expiresAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::timestamp, CURRENT_TIMESTAMP)
     ON CONFLICT ("channelCode") DO UPDATE SET
       "accessToken" = EXCLUDED."accessToken",
       "refreshToken" = EXCLUDED."refreshToken",
       "userId" = EXCLUDED."userId",
       "expiresAt" = EXCLUDED."expiresAt",
       "updatedAt" = CURRENT_TIMESTAMP`,
    row.channelCode,
    row.accessToken,
    row.refreshToken,
    row.userId,
    row.expiresAt.toISOString(),
  );
}

/**
 * Siembra el token SOLO si todavía no hay ninguno (la app la usa la primera
 * vez para pasar el token que ya tenía en la bóveda a la base compartida).
 * Devuelve true si insertó. Nunca pisa un token que ya está en la base — ese
 * es siempre más nuevo que cualquier copia vieja de la bóveda.
 */
export async function insertLiveTokenIfMissing(row: LiveTokenRow): Promise<boolean> {
  await ensureTable();
  const inserted = await getDb().$executeRawUnsafe(
    `INSERT INTO "ChannelLiveToken" ("channelCode", "accessToken", "refreshToken", "userId", "expiresAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::timestamp, CURRENT_TIMESTAMP)
     ON CONFLICT ("channelCode") DO NOTHING`,
    row.channelCode,
    row.accessToken,
    row.refreshToken,
    row.userId,
    row.expiresAt.toISOString(),
  );
  return inserted > 0;
}

/**
 * Refresco SEGURO entre procesos: abre una transacción, bloquea la fila del
 * canal (`FOR UPDATE`) y, ya con el bloqueo, vuelve a leer el token — porque
 * mientras esperaba el bloqueo otro proceso pudo haberlo renovado ya.
 *
 *  - `needsRefresh(row)` decide, con el token YA bloqueado y releído, si
 *    todavía hace falta refrescar (si otro proceso se adelantó, devuelve false
 *    y se usa su token tal cual — sin gastar el refresh_token otra vez).
 *  - `refresh(row)` hace la llamada real a Mercado Libre y devuelve el token
 *    nuevo; se guarda en la misma transacción antes de soltar el bloqueo.
 *
 * Devuelve `null` si no hay ninguna fila para ese canal. Si `refresh` lanza
 * error, la transacción se deshace y la fila queda como estaba.
 *
 * El guardado se reintenta unas veces dentro de la transacción: apenas Mercado
 * Libre entrega el token nuevo, el anterior deja de servir — perder este
 * UPDATE equivale a perder la conexión con la cuenta.
 */
export async function refreshLiveTokenLocked(
  channelCode: string,
  needsRefresh: (row: LiveTokenRow) => boolean,
  refresh: (row: LiveTokenRow) => Promise<LiveTokenRow>,
): Promise<LiveTokenRow | null> {
  await ensureTable();
  return getDb().$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<RawLiveTokenRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM "ChannelLiveToken" WHERE "channelCode" = $1 FOR UPDATE`,
        channelCode,
      );
      if (rows.length === 0) return null;
      const current = toRow(rows[0]!);
      if (!needsRefresh(current)) return current;

      const next = await refresh(current);

      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "ChannelLiveToken"
                SET "accessToken" = $2, "refreshToken" = $3, "userId" = $4,
                    "expiresAt" = $5::timestamp, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "channelCode" = $1`,
            channelCode,
            next.accessToken,
            next.refreshToken,
            next.userId,
            next.expiresAt.toISOString(),
          );
          return next;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    // El refresco hace una llamada HTTP a Mercado Libre con la fila bloqueada: se da margen de sobra para esa llamada y para esperar el turno.
    { maxWait: 15_000, timeout: 45_000 },
  );
}
