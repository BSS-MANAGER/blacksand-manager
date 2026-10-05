import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Prepara la conexión a la base de datos (Postgres/Supabase, sección E)
 * antes de que cualquier paquete importe @blacksand/db.
 *
 * Migrado desde SQLite local (ver scripts/migrate-to-supabase): la base ya
 * no vive en el PC del usuario, vive en la nube (Supabase), compartida con
 * el futuro worker 24/7 (Parte 3 del plan). La app ya NO funciona sin
 * internet, a cambio de que el stock se sincroniza aunque el PC esté
 * apagado.
 *
 * `DATABASE_URL` se toma, en este orden:
 *   1. Variable de entorno del proceso, si ya está seteada.
 *   2. Un archivo local `db-connection.local.txt` en la carpeta de datos de
 *      la app (userData) — NO vive en el repo (cada instalación del PC
 *      tiene el suyo), con una sola línea: `DATABASE_URL=postgresql://...`.
 *
 * Migraciones de esquema nuevas (futuras) se aplican con un runner propio
 * (`./schema-migrations.ts`) que compara contra `_prisma_migrations` — no
 * se ejecuta el CLI de Prisma dentro de la app empaquetada.
 */
export async function bootstrapDatabase(): Promise<string> {
  const userDataDir = app.getPath("userData");
  mkdirSync(userDataDir, { recursive: true });

  if (!process.env.DATABASE_URL) {
    const configPath = join(userDataDir, "db-connection.local.txt");
    if (existsSync(configPath)) {
      const match = readFileSync(configPath, "utf-8").match(/^\s*DATABASE_URL\s*=\s*(\S+)\s*$/m);
      if (match) process.env.DATABASE_URL = match[1];
    }
  }

  if (!process.env.DATABASE_URL) {
    const configPath = join(userDataDir, "db-connection.local.txt");
    throw new Error(
      `Falta configurar la conexión a la base de datos. Creá el archivo:\n${configPath}\n` +
        `con una sola línea: DATABASE_URL=postgresql://... (el connection string "Session pooler" de Supabase)`,
    );
  }

  const { applyPendingMigrations } = await import("./schema-migrations.js");
  await applyPendingMigrations();

  return process.env.DATABASE_URL;
}
