# ADR-0001 — Arquitectura de Fase 1

**Estado:** aceptado · **Fecha:** 2026-09-11

## Contexto

BLACK SAND Manager centraliza en el PC del usuario la administración de
catálogo, inventario y (en fases posteriores) ventas de una tienda
deportiva/airsoft/combate táctico, sincronizando con Shopify, Mercado Libre
(MLC) y, de forma acotada, Meta/Facebook. El detalle completo de viabilidad,
riesgos y plan por fases vive en
`docs/BLACK_SAND_Manager_Especificacion_Tecnica.md` (idéntico al documento
guardado en el proyecto de Claude). Este ADR registra las decisiones que ya
quedaron fijadas en código para la Fase 1 ("Cimiento").

## Decisiones

1. **Monorepo pnpm** (`apps/desktop`, `packages/*`, `packages/connectors/*`)
   para poder aislar cada conector y reemplazar/agregar canales sin tocar la
   capa de dominio (sección K de la especificación).
2. **Electron + React + TypeScript**, scaffolding con `electron-vite`
   (separa `main`, `preload`, `renderer` tal como pide K.1). `contextIsolation:
   true`, `nodeIntegration: false` — el renderer solo habla con el proceso
   principal vía el puente tipado en `apps/desktop/src/shared-ipc-types.ts`.
3. **Base de datos:** SQLite vía `@prisma/client` (sin necesidad de
   `better-sqlite3` explícito — Prisma trae su propio motor para SQLite),
   con IDs `TEXT`/UUID en todo el esquema para la ruta de migración a
   PostgreSQL descrita en E.3. El esquema completo (`packages/db/prisma/schema.prisma`)
   incluye las 20 entidades de la sección E.1, aunque Fase 1 solo escribe en
   `products`, `product_variants`, `inventory_items`, `locations`, `channels`,
   `channel_product_map`, `channel_sync_status` y `audit_log`.
4. **Bóveda de credenciales** (`packages/credentials`): interfaz única con
   dos implementaciones — `OsKeytarVault` (keytar → Windows Credential
   Manager, la usada en producción) y `DevFileVault` (archivo cifrado
   AES-256-GCM en `~/.blacksand-manager/`, solo para desarrollo sin keytar
   disponible). Se selecciona con `CREDENTIAL_VAULT_MODE`.
5. **Conectores de solo lectura en Fase 1:**
   - `@blacksand/connector-shopify`: GraphQL Admin API, paginación completa
     de productos/variantes, respeta `throttleStatus` (no lo usa aún para
     backoff activo — eso llega con el motor de reintentos de Fase 2).
   - `@blacksand/connector-mercadolibre`: OAuth2 Authorization Code +
     refresh automático, lectura de items/variaciones del vendedor
     autenticado (site MLC).
   - `@blacksand/connector-meta`: **no hace llamadas de red.** Solo genera
     un feed de catálogo en memoria/CSV — implementación deliberadamente
     mínima porque Shopping/Marketplace no está disponible en Chile (A.3).
6. **Emparejamiento de catálogo** (`@blacksand/core-domain/matching.ts`):
   SKU exacto > código de barras exacto > conciliación manual. Nunca se
   fusiona automáticamente un caso ambiguo (G.1).
7. **Sondeo en vez de webhooks** en Fase 1-3 (D.2): un `setInterval`
   controlado (`@blacksand/sync-engine/scheduler.ts`) evita reentradas
   solapadas; el relay serverless para webhooks reales queda documentado
   como evolución opcional de Fase 4+, sin cambiar el contrato del
   scheduler.
8. **Auditoría desde el primer commit** (módulo 13): toda operación de Fase
   1 (conectar canal, importar catálogo, decidir una conciliación) pasa por
   `recordAudit()`.

## Fuera de alcance en este ADR (a propósito)

- Cualquier escritura hacia Shopify/Mercado Libre/Meta (Fase 2).
- Ventas presenciales, pedidos, clientes, carritos abandonados (Fases 3-5).
- Operaciones masivas y feed de Meta publicado (Fase 6).
- Empaquetado firmado/distribución (J.1) — el `electron-builder.yml` incluido
  es un punto de partida, no una build de producción firmada.

## Consecuencias

- El esquema de base de datos ya soporta las fases futuras sin
  migraciones destructivas — agregar Fase 2 (escritura) es, en su mayoría,
  agregar lógica sobre tablas que ya existen (`sync_queue`, `sync_log`,
  `channel_sync_status`).
- Como este entorno de generación de código no tiene acceso a los
  registros de paquetes (npm), **no se pudo correr `pnpm install`,
  `prisma generate/migrate` ni compilar/empaquetar la app aquí.** Se
  verificó en su lugar: sintaxis TypeScript/TSX de los 48 archivos fuente
  (0 errores), balance de llaves y lista de modelos del `schema.prisma`, y
  validez JSON/YAML de toda la configuración. La primera vez que esto debe
  correr con red real es en la máquina del usuario — ver README.
