#!/usr/bin/env node
/**
 * Genera la plantilla de base de datos SQLite ya migrada, que la app de
 * escritorio copia a `userData` en el primer arranque (ver
 * apps/desktop/src/main/db-bootstrap.ts). Debe correrse UNA VEZ por cada
 * cambio de esquema, antes de empaquetar con electron-builder.
 *
 * Uso:
 *   pnpm db:migrate            (crea packages/db/prisma/dev.db)
 *   node scripts/build-template-db.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const source = join(root, "packages/db/prisma/dev.db");
const targetDir = join(root, "apps/desktop/resources");
const target = join(targetDir, "blacksand.template.db");

if (!existsSync(source)) {
  console.error(
    `No se encontró ${source}. Corre primero:\n  pnpm --filter @blacksand/db migrate\n` +
      "(con DATABASE_URL=file:./dev.db en packages/db/.env, ver README).",
  );
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`Plantilla de base de datos copiada a ${target}`);
