import { getDb } from "../client.js";
import type { ChannelCode } from "@blacksand/shared";

export async function getChannelByCode(code: ChannelCode) {
  const db = getDb();
  const channel = await db.channel.findUnique({ where: { code } });
  if (!channel) {
    throw new Error(
      `Canal "${code}" no existe en la base local — corre seedChannels() antes de importar.`,
    );
  }
  return channel;
}

export async function upsertChannelProductMap(input: {
  productId?: string | null;
  variantId?: string | null;
  channelId: string;
  channelProductId: string;
  channelVariantId?: string | null;
  channelSku?: string | null;
  syncStatus: "sincronizado" | "pendiente" | "error" | "conflicto";
  /**
   * Estado REAL de la publicación en el canal (ver el comentario grande en
   * el esquema, `ChannelProductMap.listingStatus`) — distinto de
   * `syncStatus`. Se omite (no se toca lo que ya había) salvo que el
   * llamador lo pase explícitamente; hoy solo lo pasa el importador de
   * Mercado Libre.
   */
  listingStatus?: string | null;
  /** JSON string (array) — ver `ChannelProductMap.listingSubStatus`. */
  listingSubStatus?: string | null;
}) {
  const db = getDb();
  // channelVariantId es parte de la clave compuesta única (@@unique en el
  // esquema). NULL en SQL nunca es igual a NULL, así que dos filas con el
  // mismo channelId+channelProductId y channelVariantId=NULL no chocarían
  // contra el índice único (se crearían duplicados silenciosos). Por eso se
  // normaliza "sin variante" a "" (string vacío) de forma consistente en
  // toda la app — nunca se guarda NULL en este campo.
  const channelVariantKey = input.channelVariantId ?? "";

  // `listingStatusCheckedAt` solo se pisa cuando el llamador realmente trae
  // un `listingStatus` nuevo (es decir, cuando de verdad se acaba de leer
  // el ítem de Mercado Libre) — así el resto de los `upsertChannelProductMap`
  // que no tienen que ver con esto (ej. conciliación manual) no lo tocan.
  const listingStatusFields =
    input.listingStatus !== undefined
      ? {
          listingStatus: input.listingStatus,
          listingSubStatus: input.listingSubStatus ?? null,
          listingStatusCheckedAt: new Date(),
        }
      : {};

  return db.channelProductMap.upsert({
    where: {
      channelId_channelProductId_channelVariantId: {
        channelId: input.channelId,
        channelProductId: input.channelProductId,
        channelVariantId: channelVariantKey,
      },
    },
    update: {
      productId: input.productId ?? undefined,
      variantId: input.variantId ?? undefined,
      channelSku: input.channelSku ?? undefined,
      syncStatus: input.syncStatus,
      lastSyncedAt: new Date(),
      ...listingStatusFields,
    },
    create: {
      productId: input.productId ?? null,
      variantId: input.variantId ?? null,
      channelId: input.channelId,
      channelProductId: input.channelProductId,
      channelVariantId: channelVariantKey,
      channelSku: input.channelSku ?? null,
      syncStatus: input.syncStatus,
      lastSyncedAt: new Date(),
      ...listingStatusFields,
    },
  });
}

/**
 * Actualiza SOLO `listingStatus`/`listingSubStatus` de TODAS las filas de
 * `ChannelProductMap` que apunten a un ítem de Mercado Libre puntual (un
 * ítem con variaciones reales de Mercado Libre puede tener más de una fila,
 * una por `channelVariantId`) — usado después de reactivar una publicación
 * (`meli:listingReactivate`) para reflejar el nuevo estado sin esperar a la
 * próxima importación completa.
 */
export async function setChannelListingStatus(
  channelId: string,
  channelProductId: string,
  listingStatus: string,
  listingSubStatus: string[],
) {
  const db = getDb();
  return db.channelProductMap.updateMany({
    where: { channelId, channelProductId },
    data: {
      listingStatus,
      listingSubStatus: JSON.stringify(listingSubStatus),
      listingStatusCheckedAt: new Date(),
    },
  });
}

export interface MeliBrandFixCandidateRow {
  channelProductId: string;
  listingStatus: string | null;
  productId: string | null;
  productName: string;
  sku: string;
  /** Marca guardada HOY en la base local — no necesariamente la que quedó publicada en Mercado Libre (ver `previewMeliBrandFix`, que lee la real desde la API). */
  localBrand: string | null;
}

/**
 * Candidatos para corregir el atributo BRAND de publicaciones YA
 * PUBLICADAS en Mercado Libre — se busca por prefijo de SKU (ej. "EM" para
 * EmersonGear) en vez de por categoría/grupo, porque el problema real que
 * motivó esto (ver `meli-brand-fix.ts`, @blacksand/sync-engine) es una
 * "Marca por defecto" mal aplicada a los productos de un proveedor
 * puntual — no tiene relación con la categoría de Mercado Libre de cada
 * producto. Un ítem con variaciones puede tener más de una fila en
 * `ChannelProductMap` (una por `channelVariantId`) — se devuelve una sola
 * fila por `channelProductId`.
 */
export async function listMeliBrandFixCandidates(skuPrefix: string): Promise<MeliBrandFixCandidateRow[]> {
  const db = getDb();
  const channel = await getChannelByCode("mercadolibre");
  const rows = await db.channelProductMap.findMany({
    where: {
      channelId: channel.id,
      variant: { skuVariant: { startsWith: skuPrefix } },
    },
    include: { product: true, variant: true },
    orderBy: { channelProductId: "asc" },
  });

  const seen = new Set<string>();
  const out: MeliBrandFixCandidateRow[] = [];
  for (const row of rows) {
    if (seen.has(row.channelProductId)) continue;
    seen.add(row.channelProductId);
    out.push({
      channelProductId: row.channelProductId,
      listingStatus: row.listingStatus,
      productId: row.productId,
      productName: row.product?.name ?? row.variant?.skuVariant ?? row.channelProductId,
      sku: row.variant?.skuVariant ?? row.channelSku ?? "",
      localBrand: row.product?.brand ?? null,
    });
  }
  return out;
}

export interface MeliSkuFixCandidateRow {
  channelProductId: string;
  /** `null` cuando la publicación no tiene variaciones (item simple) — normalizado desde "" (ver `upsertChannelProductMap`). */
  channelVariantId: string | null;
  listingStatus: string | null;
  productId: string | null;
  productName: string;
  /** SKU correcto — el que ya tiene la variante en la base local (viene de Shopify, la fuente de verdad del catálogo). */
  expectedSku: string;
}

/**
 * Candidatos para "Corregir SKU incorrecto en Mercado Libre" — a pedido
 * directo del usuario ("revisa los productos publicados en ML y corrige
 * los sku que estan con error"), después del fix de lectura del SKU (ver
 * `extractSellerSkuAttribute`, @blacksand/connector-mercadolibre). A
 * diferencia de `listMeliBrandFixCandidates` (que busca por prefijo de SKU
 * porque el valor correcto depende de una regla por proveedor), acá se
 * traen TODAS las publicaciones de Mercado Libre ya emparejadas a un
 * producto/variante central (`variantId` no nulo) — el valor correcto no
 * hay que preguntárselo a nadie, es el SKU que la variante ya tiene
 * guardado localmente. Se excluyen publicaciones **cerradas**
 * (`listingStatus === "closed"`): ya no aceptan más cambios, y si se
 * vuelven a publicar (ver "Estado en Mercado Libre") salen con el SKU
 * correcto desde el principio de todas formas. Un ítem con variaciones
 * puede devolver más de una fila (una por `channelVariantId`).
 */
export async function listMeliSkuFixCandidates(): Promise<MeliSkuFixCandidateRow[]> {
  const db = getDb();
  const channel = await getChannelByCode("mercadolibre");
  const rows = await db.channelProductMap.findMany({
    where: {
      channelId: channel.id,
      variantId: { not: null },
      NOT: { listingStatus: "closed" },
    },
    include: { product: true, variant: true },
    orderBy: { channelProductId: "asc" },
  });

  return rows
    .filter((row) => !!row.variant?.skuVariant)
    .map((row) => ({
      channelProductId: row.channelProductId,
      channelVariantId: row.channelVariantId ? row.channelVariantId : null,
      listingStatus: row.listingStatus,
      productId: row.productId,
      productName: row.product?.name ?? row.variant!.skuVariant,
      expectedSku: row.variant!.skuVariant,
    }));
}

export interface StockAuditCandidateRow {
  variantId: string;
  productName: string;
  sku: string;
  /** Suma de `InventoryItem.quantityOnHand` en la base local (lo que la app cree hoy que hay). */
  localQuantity: number;
  shopifyChannelProductId: string;
  shopifyChannelVariantId: string | null;
  meliChannelProductId: string;
  /** `null` = publicación de Mercado Libre sin variaciones (ítem simple) — mismo criterio que en `MeliSkuFixCandidateRow`. */
  meliChannelVariantId: string | null;
}

/**
 * Candidatos para "Auditoría de Stock" — a pedido directo del usuario, caso
 * real: "el inventario de casco wendy en shopify es 9 y en ML es 10, algo
 * pasó, revisalo y corrige". Solo tiene sentido comparar una variante que
 * está publicada en AMBOS canales a la vez (si solo está en uno, no hay
 * nada que comparar todavía — ver "Publicar en ML"), así que se arma
 * agrupando por `variantId` y quedándose solo con los que tienen fila de
 * `shopify` Y de `mercadolibre`. Se excluyen publicaciones de Mercado Libre
 * **cerradas** (mismo criterio que `listMeliSkuFixCandidates`): ya no
 * aceptan más cambios de stock.
 */
export async function listStockAuditCandidates(): Promise<StockAuditCandidateRow[]> {
  const db = getDb();
  const shopifyChannel = await getChannelByCode("shopify");
  const meliChannel = await getChannelByCode("mercadolibre");

  const rows = await db.channelProductMap.findMany({
    where: {
      variantId: { not: null },
      channelId: { in: [shopifyChannel.id, meliChannel.id] },
    },
    include: { product: true, variant: { include: { inventoryItems: true } } },
    orderBy: { variantId: "asc" },
  });

  const byVariant = new Map<
    string,
    { shopify?: (typeof rows)[number]; meli?: (typeof rows)[number] }
  >();
  for (const row of rows) {
    const key = row.variantId!;
    const entry = byVariant.get(key) ?? {};
    if (row.channelId === shopifyChannel.id) entry.shopify = row;
    if (row.channelId === meliChannel.id && row.listingStatus !== "closed") entry.meli = row;
    byVariant.set(key, entry);
  }

  const out: StockAuditCandidateRow[] = [];
  for (const [variantId, entry] of byVariant) {
    if (!entry.shopify || !entry.meli) continue;
    const variant = entry.shopify.variant ?? entry.meli.variant;
    if (!variant) continue;
    out.push({
      variantId,
      productName: entry.shopify.product?.name ?? variant.skuVariant,
      sku: variant.skuVariant,
      localQuantity: variant.inventoryItems.reduce((s, i) => s + i.quantityOnHand, 0),
      shopifyChannelProductId: entry.shopify.channelProductId,
      shopifyChannelVariantId: entry.shopify.channelVariantId ? entry.shopify.channelVariantId : null,
      meliChannelProductId: entry.meli.channelProductId,
      meliChannelVariantId: entry.meli.channelVariantId ? entry.meli.channelVariantId : null,
    });
  }
  return out;
}

/**
 * Fase 3a (F.3): resuelve una línea de pedido de un canal (channelProductId +
 * channelVariantId) a su mapeo central, para saber qué variante descontar.
 * Usa la misma normalización "" para "sin variante" que `upsertChannelProductMap`.
 */
export async function findChannelProductMap(
  channelId: string,
  channelProductId: string,
  channelVariantId: string | null,
) {
  const db = getDb();
  return db.channelProductMap.findUnique({
    where: {
      channelId_channelProductId_channelVariantId: {
        channelId,
        channelProductId,
        channelVariantId: channelVariantId ?? "",
      },
    },
  });
}

/**
 * Caso real encontrado (septiembre 2026): ~20 productos quedaron publicados
 * DOS VECES en Mercado Libre — dos `channelProductId` distintos para el
 * mismo producto/SKU, creados 1-2 segundos aparte (ver el comentario grande
 * de `publishGuardRef` en `PublicarMeliPage.tsx`: un doble clic en
 * "Publicar lote"/"Publicar todo automáticamente" alcanzaba a disparar dos
 * publicaciones casi simultáneas para el mismo candidato). El guardado del
 * lado de la pantalla ya corta esto, pero la causa de fondo sigue viva:
 * `upsertChannelProductMap` no puede detectar el duplicado porque su clave
 * única es del LADO DEL CANAL (`channelId+channelProductId+channelVariantId`,
 * ver el comentario grande ahí) — un `channelProductId` nuevo (ítem nuevo)
 * nunca choca contra uno viejo, sin importar que sea la MISMA variante
 * local. `publishBatch` (@blacksand/sync-engine) usa esto para revisar, justo
 * antes de llamar `createItem`, si la variante YA tiene una publicación viva
 * — así, aunque algo más allá del clic del usuario dispare dos publicaciones
 * para el mismo candidato (ej. el futuro worker en la nube corriendo en
 * paralelo a la app de escritorio, ver el plan de sincronización 24/7), la
 * segunda se corta ACÁ en vez de crear un ítem duplicado en Mercado Libre.
 */
export async function findActiveChannelMapByVariant(variantId: string, channelId: string) {
  const db = getDb();
  return db.channelProductMap.findFirst({
    where: { variantId, channelId, listingStatus: { not: "closed" } },
  });
}

/** Casos ambiguos pendientes de conciliación manual (sección G.1, punto 2). */
export async function listPendingReconciliation() {
  const db = getDb();
  return db.channelProductMap.findMany({
    where: { syncStatus: "conflicto" },
    include: { channel: true, product: true, variant: true },
  });
}

export async function upsertChannelSyncStatus(input: {
  productId: string;
  channelId: string;
  status: "sincronizado" | "pendiente" | "error" | "conflicto";
  stockDiff?: number;
  lastError?: string | null;
  /** Código corto del error (catálogo en `@blacksand/shared/sync-error-codes.ts`) — `null`/omitido cuando `status` no es "error". */
  lastErrorCode?: string | null;
}) {
  const db = getDb();
  return db.channelSyncStatus.upsert({
    where: { productId_channelId: { productId: input.productId, channelId: input.channelId } },
    update: {
      status: input.status,
      stockDiff: input.stockDiff ?? 0,
      lastError: input.lastError ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      lastSyncedAt: new Date(),
    },
    create: {
      productId: input.productId,
      channelId: input.channelId,
      status: input.status,
      stockDiff: input.stockDiff ?? 0,
      lastError: input.lastError ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      lastSyncedAt: new Date(),
    },
  });
}

export async function listDashboardSyncStatus() {
  const db = getDb();
  return db.channelSyncStatus.findMany({
    include: { product: true, channel: true },
    orderBy: [{ status: "asc" }, { lastSyncedAt: "desc" }],
  });
}
