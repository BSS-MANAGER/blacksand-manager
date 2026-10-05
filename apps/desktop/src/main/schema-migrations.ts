import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";

/**
 * Runner de migraciones "propio" para la app empaquetada — la app nunca
 * ejecuta el CLI de Prisma (`prisma migrate`) dentro de sí misma, así que un
 * cambio de esquema nuevo nunca llegaría solo a la base real del usuario.
 *
 * Este runner reutiliza la MISMA tabla de control que usa el CLI de Prisma
 * (`_prisma_migrations`) para decidir qué migraciones de
 * `packages/db/prisma/migrations/*` faltan por aplicar, y las corre a mano
 * con SQL crudo. Así, correr `pnpm --filter @blacksand/db migrate` (que
 * genera la carpeta de migración nueva en el repo) alcanza para que, la
 * próxima vez que arranque la app — la de cualquiera que use este
 * proyecto, no solo la de quien generó la migración — el cambio se aplique
 * solo contra la base real (Postgres/Supabase), sin que nadie tenga que
 * tocar nada a mano.
 *
 * Nota (migración a Postgres, ver scripts/migrate-to-supabase): las
 * migraciones generadas cuando el motor todavía era SQLite (las carpetas
 * con fecha hasta 2026-09-28) NO son SQL válido para Postgres — se
 * marcaron como ya aplicadas directamente en `_prisma_migrations` al
 * crear el esquema nuevo en Supabase, así que este runner nunca intenta
 * volver a correrlas. Solo corre migraciones NUEVAS, generadas de acá en
 * adelante con el datasource ya en `postgresql` (Prisma genera SQL de
 * Postgres automáticamente).
 */

interface PendingMigration {
  name: string;
  sqlPath: string;
}

function resolveMigrationsDir(): string | null {
  // Empaquetado: se espera copiar `packages/db/prisma/migrations` como
  // extraResource (mismo patrón que `blacksand.template.db`) el día que este
  // proyecto arme un instalador. Todavía no existe esa configuración, así
  // que esta rama queda lista pero no se ejercita hoy.
  const packagedDir = join(process.resourcesPath ?? "", "migrations");
  // Desarrollo (`electron-vite dev` desde apps/desktop): app.getAppPath()
  // apunta a apps/desktop, y el monorepo vive dos niveles arriba.
  const devDir = join(app.getAppPath(), "..", "..", "packages", "db", "prisma", "migrations");

  if (app.isPackaged) {
    return existsSync(packagedDir) ? packagedDir : null;
  }
  return existsSync(devDir) ? devDir : null;
}

function listMigrationFolders(migrationsDir: string): PendingMigration[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, sqlPath: join(migrationsDir, entry.name, "migration.sql") }))
    .filter((m) => existsSync(m.sqlPath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Mismos statements que un `CREATE TABLE` de Prisma para Postgres — no-op si ya existe (ya la creamos a mano en Supabase). */
const ENSURE_TRACKING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           TIMESTAMP(3),
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMP(3),
    "started_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`.trim();

/** Separa un archivo `migration.sql` de Prisma en sentencias individuales ejecutables una por una. */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split("\n").every((line) => line.trim().startsWith("--") || line.trim() === ""));
}

/**
 * Corre, contra la base real del usuario, cualquier migración de
 * `packages/db/prisma/migrations` que todavía no esté marcada como aplicada
 * en `_prisma_migrations`. Debe llamarse después de fijar `DATABASE_URL`
 * (`db-bootstrap.ts`) y antes de que cualquier otra parte de la app use
 * `@blacksand/db`. Lanza si una migración falla a mitad de camino — se
 * prefiere que la app no arranque a que arranque con un esquema a medio
 * aplicar.
 */
export async function applyPendingMigrations(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  if (!migrationsDir) {
    // eslint-disable-next-line no-console
    console.warn("[schema-migrations] No se encontró la carpeta de migraciones — se omite.");
    return;
  }

  const { getDb } = await import("@blacksand/db");
  const db = getDb();

  await db.$executeRawUnsafe(ENSURE_TRACKING_TABLE_SQL);

  const applied = await db.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
  );
  const appliedNames = new Set(applied.map((r) => r.migration_name));

  for (const migration of listMigrationFolders(migrationsDir)) {
    if (appliedNames.has(migration.name)) continue;

    const sql = readFileSync(migration.sqlPath, "utf-8");
    const statements = splitStatements(sql);
    const checksum = createHash("sha256").update(sql).digest("hex");
    const id = randomUUID();

    // eslint-disable-next-line no-console
    console.log(`[schema-migrations] Aplicando migración pendiente: ${migration.name} (${statements.length} sentencias)`);

    try {
      for (const statement of statements) {
        await db.$executeRawUnsafe(statement);
      }
      await db.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) ` +
          `VALUES ($1, $2, CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP, $4)`,
        id,
        checksum,
        migration.name,
        statements.length,
      );
    } catch (err) {
      // Se registra como intento fallido (finished_at NULL) para que quede
      // trazable en la tabla, pero la app no debe seguir arrancando con un
      // esquema a medias — se relanza el error.
      await db
        .$executeRawUnsafe(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) ` +
            `VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 0)`,
          id,
          checksum,
          migration.name,
        )
        .catch(() => undefined);
      throw new Error(
        `No se pudo aplicar la migración "${migration.name}" contra la base de datos real. ` +
          `Detalle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
