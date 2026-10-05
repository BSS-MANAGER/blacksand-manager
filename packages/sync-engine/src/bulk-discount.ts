import {
  getChannelByCode,
  findChannelProductMap,
  updateVariantFields,
  recordAudit,
  listAuditEntriesByActions,
  listVariantPriceBaselines,
  upsertVariantPriceBaselines,
  type VariantPriceBaselineRow,
} from "@blacksand/db";
import { fetchAllShopifyProducts, type ShopifyClient } from "@blacksand/connector-shopify";
import {
  planVariantChange,
  validatePriceChange,
  type DiscountOnSaleMode,
  type DiscountRounding,
  type PriceChangeMode,
} from "@blacksand/shared";

/**
 * "Descuentos" — cambios de precio masivos en Shopify (descontar, aumentar,
 * restaurar el precio normal). Cómo funciona (el cálculo puro vive en
 * `@blacksand/shared/discount.ts`):
 *
 * PRECIO NORMAL GUARDADO (pedido explícito del usuario: "que se guarde
 * siempre en alguna parte los precios normales de mis productos, para
 * después volver a los precios normales"): por cada variante de Shopify la
 * app guarda su "precio normal" en la tabla `VariantPriceBaseline` (ver
 * `price-baseline.repository.ts`). Se guarda automáticamente cada vez que
 * se lee el catálogo (al abrir la pantalla) y, además, antes de CUALQUIER
 * escritura en Shopify — nunca se toca un precio sin que su precio normal
 * ya esté guardado (si no se puede guardar, no se escribe en Shopify).
 * - Si un producto ya estaba en oferta al guardarlo (tiene "precio de
 *   comparación" mayor que su precio), su precio normal es el precio de
 *   comparación — el precio de antes de la oferta.
 * - Ni un descuento ni un aumento de la app cambian jamás el precio normal.
 * - Si alguien cambia el precio por fuera de la app (directo en Shopify), el
 *   precio normal se actualiza solo al valor nuevo — ver `syncBaselines`.
 *
 * ACCIONES: `discount` (el precio actual pasa a "precio de comparación" y el
 * precio baja), `increase` (el precio sube, calculado sobre el precio normal;
 * sin precio de comparación), `restore` (vuelve al precio normal y quita el
 * precio de comparación — también "devuelve a su precio original" a los
 * productos que ya estaban en oferta).
 *
 * - SIEMPRE se lee el catálogo EN VIVO de Shopify justo antes de aplicar —
 *   nunca se confía en los números de la vista previa.
 * - Se escribe en Shopify y se refleja el precio nuevo en la base local.
 * - REVERSIBLE paso a paso: por cada producto se deja en `AuditLog` el estado
 *   de ANTES de cada variante; "Revertir" un lote restaura exactamente eso
 *   (solo variantes cuyo precio sigue siendo el que dejó el lote).
 * - NO toca Mercado Libre.
 *
 * Lección aprendida del bug de publicaciones duplicadas (un doble clic
 * disparaba dos corridas casi simultáneas): `discountRunInFlight` rechaza
 * cualquier operación mientras haya otra en curso.
 */

const ACTION_APPLIED = "descuento_masivo";
const ACTION_REVERTED = "descuento_masivo_revertido";

let discountRunInFlight = false;

export interface DiscountPreviewVariant {
  variantGid: string;
  sku: string | null;
  title: string;
  price: number | null;
  compareAtPrice: number | null;
  /** Precio normal guardado (`null` solo si la variante no tiene precio). */
  baselinePrice: number | null;
}

export interface DiscountPreviewProduct {
  productGid: string;
  title: string;
  /** ACTIVE | DRAFT | ARCHIVED (tal cual lo devuelve Shopify). */
  status: string;
  variants: DiscountPreviewVariant[];
}

const sameAmount = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.01;

/** Catálogo completo EN VIVO de Shopify, sin precio normal todavía (ver `previewBulkDiscountProducts`). */
async function readLiveCatalog(shopify: ShopifyClient): Promise<DiscountPreviewProduct[]> {
  const products = await fetchAllShopifyProducts(shopify);
  return products
    .map((p) => ({
      productGid: p.channelProductId,
      title: p.title,
      status: p.status,
      variants: p.variants.map((v) => ({
        variantGid: v.channelVariantId,
        sku: v.sku,
        title: v.title,
        price: v.price,
        // Shopify devuelve "0.00" a veces en vez de null — se normaliza para que "sin precio de comparación" siempre sea null.
        compareAtPrice: v.compareAtPrice && v.compareAtPrice > 0 ? v.compareAtPrice : null,
        baselinePrice: null,
      })),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}

/**
 * Deja guardado el precio normal de TODAS las variantes del catálogo en vivo y
 * devuelve la fila vigente de cada una (por `variantGid`). Reglas:
 * - Variante nueva (sin fila): precio normal = su precio de comparación si
 *   está en oferta (precio de comparación > precio), si no, su precio.
 * - Variante con fila "gestionada por la app" (la app escribió un precio
 *   antes y el estado actual coincide con ese estado, o con el anterior a él):
 *   el precio normal NO se toca — es justo el caso de un producto con
 *   descuento/aumento aplicado desde la app.
 * - Cualquier otro caso es un cambio hecho por fuera de la app: el precio
 *   normal pasa a ser el valor actual (con la misma regla de oferta de arriba)
 *   y la variante deja de estar "gestionada".
 * Solo se escriben en la base las filas nuevas o que cambian (una consulta por
 * cada 100), así que releer el catálogo no cuesta nada si no hubo cambios.
 */
async function syncBaselines(products: DiscountPreviewProduct[]): Promise<Map<string, VariantPriceBaselineRow>> {
  const existing = new Map((await listVariantPriceBaselines()).map((r) => [r.variantGid, r]));
  const current = new Map<string, VariantPriceBaselineRow>();
  const toWrite: VariantPriceBaselineRow[] = [];

  for (const p of products) {
    for (const v of p.variants) {
      if (v.price === null || v.price <= 0) continue;
      const row = existing.get(v.variantGid);
      const onSale = v.compareAtPrice !== null && v.compareAtPrice > v.price;
      const liveBaseline = onSale ? v.compareAtPrice! : v.price;

      if (!row) {
        const created: VariantPriceBaselineRow = {
          variantGid: v.variantGid,
          productGid: p.productGid,
          productTitle: p.title,
          sku: v.sku,
          baselinePrice: liveBaseline,
          lastAppliedPrice: null,
          lastAppliedCompareAt: null,
          prevPrice: null,
          prevCompareAt: null,
        };
        toWrite.push(created);
        current.set(v.variantGid, created);
        continue;
      }

      const managedByApp =
        row.lastAppliedPrice !== null &&
        ((sameAmount(v.price, row.lastAppliedPrice) && sameAmount(v.compareAtPrice, row.lastAppliedCompareAt)) ||
          (sameAmount(v.price, row.prevPrice) && sameAmount(v.compareAtPrice, row.prevCompareAt)));

      if (managedByApp || (row.lastAppliedPrice === null && sameAmount(row.baselinePrice, liveBaseline))) {
        current.set(v.variantGid, row);
        continue;
      }

      const rebased: VariantPriceBaselineRow = {
        variantGid: v.variantGid,
        productGid: p.productGid,
        productTitle: p.title,
        sku: v.sku,
        baselinePrice: liveBaseline,
        lastAppliedPrice: null,
        lastAppliedCompareAt: null,
        prevPrice: null,
        prevCompareAt: null,
      };
      toWrite.push(rebased);
      current.set(v.variantGid, rebased);
    }
  }

  await upsertVariantPriceBaselines(toWrite);
  return current;
}

/** Catálogo EN VIVO de Shopify con precio, precio de comparación y precio normal guardado de cada variante (guarda los precios normales que falten). */
export async function previewBulkDiscountProducts(shopify: ShopifyClient): Promise<DiscountPreviewProduct[]> {
  const products = await readLiveCatalog(shopify);
  const baselines = await syncBaselines(products);
  for (const p of products) {
    for (const v of p.variants) v.baselinePrice = baselines.get(v.variantGid)?.baselinePrice ?? null;
  }
  return products;
}

/** Todos los precios normales guardados (para exportarlos a un archivo de respaldo). */
export async function listPriceBaselines(): Promise<VariantPriceBaselineRow[]> {
  return listVariantPriceBaselines();
}

export interface BulkDiscountInput {
  productGids: string[];
  mode: PriceChangeMode;
  /** Ignorado cuando `mode` es "restore". */
  percent: number;
  rounding: DiscountRounding;
  onSaleMode: DiscountOnSaleMode;
}

export interface BulkDiscountProductOutcome {
  productGid: string;
  title: string;
  status: "aplicado" | "omitido" | "error";
  detail: string;
  variantsChanged: number;
}

export interface BulkDiscountResult {
  batchId: string;
  applied: number;
  skipped: number;
  failed: number;
  outcomes: BulkDiscountProductOutcome[];
}

interface SnapshotVariant {
  variantGid: string;
  sku: string | null;
  beforePrice: number;
  beforeCompareAtPrice: number | null;
  afterPrice: number;
  afterCompareAtPrice: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shopify limita por "costo" de consulta; con una mutación por producto en serie casi nunca pasa, pero si responde "Throttled" se espera y se reintenta en vez de marcar el producto como error. */
async function withThrottleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 3 && /throttl/i.test(message)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/** Refleja el precio vigente en la base local (best-effort: si la variante no está mapeada o falla, el precio de Shopify ya quedó bien y la próxima importación lo corrige). */
async function mirrorPriceLocally(
  shopifyChannelId: string,
  productGid: string,
  variantGid: string,
  price: number,
): Promise<void> {
  try {
    const map = await findChannelProductMap(shopifyChannelId, productGid, variantGid);
    if (map?.variantId) await updateVariantFields(map.variantId, { price });
  } catch {
    // Best-effort — ver el comentario de arriba.
  }
}

/**
 * Marca en la fila de precio normal de cada variante "lo que la app está por
 * escribir" (y el estado anterior) — se llama ANTES de escribir en Shopify:
 * si algo falla o la app se cierra a mitad de camino, el estado real sigue
 * siendo uno de esos dos y no se confunde con un cambio hecho por fuera.
 * Lanza si no se pudo guardar — en ese caso NO se debe escribir en Shopify.
 */
async function recordIntendedWrites(
  baselines: Map<string, VariantPriceBaselineRow>,
  product: { productGid: string; title: string },
  planned: SnapshotVariant[],
  direction: "forward" | "revert",
): Promise<void> {
  const rows: VariantPriceBaselineRow[] = [];
  for (const p of planned) {
    const base = baselines.get(p.variantGid);
    if (!base) throw new Error(`No hay precio normal guardado para la variante ${p.sku ?? p.variantGid}.`);
    const target =
      direction === "forward"
        ? { price: p.afterPrice, compare: p.afterCompareAtPrice, prevPrice: p.beforePrice, prevCompare: p.beforeCompareAtPrice }
        : { price: p.beforePrice, compare: p.beforeCompareAtPrice, prevPrice: p.afterPrice, prevCompare: p.afterCompareAtPrice };
    rows.push({
      ...base,
      productGid: product.productGid,
      productTitle: product.title,
      sku: p.sku,
      lastAppliedPrice: target.price,
      lastAppliedCompareAt: target.compare,
      prevPrice: target.prevPrice,
      prevCompareAt: target.prevCompare,
    });
  }
  await upsertVariantPriceBaselines(rows);
}

export async function applyBulkDiscount(shopify: ShopifyClient, input: BulkDiscountInput): Promise<BulkDiscountResult> {
  const percentError = validatePriceChange(input.mode, input.percent);
  if (percentError) throw new Error(percentError);
  if (input.productGids.length === 0) throw new Error("No hay ningún producto seleccionado.");
  if (discountRunInFlight) {
    throw new Error("Ya hay una operación de precios en curso — espera a que termine antes de iniciar otra.");
  }
  discountRunInFlight = true;

  try {
    const channel = await getChannelByCode("shopify");
    const batchId = `dsc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const liveProducts = await readLiveCatalog(shopify);
    // Guarda (o actualiza) el precio normal de TODO lo que se acaba de leer ANTES de planificar nada.
    const baselines = await syncBaselines(liveProducts);
    const live = new Map(liveProducts.map((p) => [p.productGid, p]));
    const outcomes: BulkDiscountProductOutcome[] = [];

    for (const productGid of new Set(input.productGids)) {
      const product = live.get(productGid);
      if (!product) {
        outcomes.push({
          productGid,
          title: productGid,
          status: "error",
          detail: "Este producto ya no existe en Shopify.",
          variantsChanged: 0,
        });
        continue;
      }

      const planned: SnapshotVariant[] = [];
      const skipReasons: string[] = [];
      for (const v of product.variants) {
        const plan = planVariantChange(
          { price: v.price, compareAtPrice: v.compareAtPrice, baselinePrice: baselines.get(v.variantGid)?.baselinePrice ?? null },
          { mode: input.mode, percent: input.percent, rounding: input.rounding, onSaleMode: input.onSaleMode },
        );
        if (plan.action === "apply") {
          planned.push({
            variantGid: v.variantGid,
            sku: v.sku,
            beforePrice: v.price!,
            beforeCompareAtPrice: v.compareAtPrice,
            afterPrice: plan.newPrice,
            afterCompareAtPrice: plan.newCompareAtPrice,
          });
        } else {
          skipReasons.push(`${v.sku ?? v.title}: ${plan.reason}`);
        }
      }

      if (planned.length === 0) {
        outcomes.push({
          productGid,
          title: product.title,
          status: "omitido",
          detail: skipReasons.join(" · ") || "sin variantes para cambiar",
          variantsChanged: 0,
        });
        continue;
      }

      try {
        await recordIntendedWrites(baselines, { productGid, title: product.title }, planned, "forward");
      } catch (err) {
        outcomes.push({
          productGid,
          title: product.title,
          status: "error",
          detail: `No se pudo guardar el precio normal en la base de datos, así que NO se tocó Shopify: ${err instanceof Error ? err.message : String(err)}`,
          variantsChanged: 0,
        });
        continue;
      }

      try {
        await withThrottleRetry(() =>
          shopify.updateVariantPrices(
            productGid,
            planned.map((p) => ({
              variantGid: p.variantGid,
              price: p.afterPrice,
              compareAtPrice: p.afterCompareAtPrice,
            })),
          ),
        );
      } catch (err) {
        outcomes.push({
          productGid,
          title: product.title,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
          variantsChanged: 0,
        });
        continue;
      }

      // Se deja constancia ANTES de seguir con el próximo producto, no al
      // final de toda la corrida: si la app se cierra a la mitad, lo que ya
      // se aplicó igual queda registrado y se puede revertir.
      await recordAudit({
        action: ACTION_APPLIED,
        entityType: "shopify_product",
        entityId: productGid,
        after: {
          batchId,
          kind: input.mode,
          percent: input.mode === "restore" ? 0 : input.percent,
          rounding: input.rounding,
          onSaleMode: input.onSaleMode,
          productTitle: product.title,
          variants: planned,
        },
      });
      if (channel) {
        for (const p of planned) await mirrorPriceLocally(channel.id, productGid, p.variantGid, p.afterPrice);
      }

      outcomes.push({
        productGid,
        title: product.title,
        status: "aplicado",
        detail: skipReasons.length > 0 ? `Variantes omitidas: ${skipReasons.join(" · ")}` : "",
        variantsChanged: planned.length,
      });
    }

    return {
      batchId,
      applied: outcomes.filter((o) => o.status === "aplicado").length,
      skipped: outcomes.filter((o) => o.status === "omitido").length,
      failed: outcomes.filter((o) => o.status === "error").length,
      outcomes,
    };
  } finally {
    discountRunInFlight = false;
  }
}

export interface DiscountBatchSummary {
  batchId: string;
  /** ISO — cuándo se aplicó el primer producto del lote. */
  appliedAt: string;
  kind: PriceChangeMode;
  /** 0 cuando `kind` es "restore". */
  percent: number;
  rounding: DiscountRounding;
  onSaleMode: DiscountOnSaleMode;
  productsApplied: number;
  variantsApplied: number;
  /** Cuántos de esos productos ya se revirtieron. Si es igual a `productsApplied`, el lote está completamente revertido. */
  productsReverted: number;
}

interface AppliedAfter {
  batchId: string;
  kind?: PriceChangeMode;
  percent: number;
  rounding: DiscountRounding;
  onSaleMode: DiscountOnSaleMode;
  productTitle: string;
  variants: SnapshotVariant[];
}

/** Historial de cambios de precio aplicados (del más reciente al más viejo), armado desde el registro de auditoría. */
export async function listDiscountBatches(): Promise<DiscountBatchSummary[]> {
  const entries = await listAuditEntriesByActions([ACTION_APPLIED, ACTION_REVERTED]);
  const batches = new Map<string, DiscountBatchSummary>();

  for (const e of entries) {
    const after = e.after as Partial<AppliedAfter> | null;
    if (!after?.batchId) continue;
    if (e.action === ACTION_APPLIED) {
      const existing = batches.get(after.batchId);
      if (existing) {
        existing.productsApplied += 1;
        existing.variantsApplied += after.variants?.length ?? 0;
      } else {
        batches.set(after.batchId, {
          batchId: after.batchId,
          appliedAt: e.createdAt.toISOString(),
          kind: after.kind ?? "discount",
          percent: after.percent ?? 0,
          rounding: after.rounding ?? "none",
          onSaleMode: after.onSaleMode ?? "skip",
          productsApplied: 1,
          variantsApplied: after.variants?.length ?? 0,
          productsReverted: 0,
        });
      }
    } else {
      const existing = batches.get(after.batchId);
      if (existing) existing.productsReverted += 1;
    }
  }

  return [...batches.values()].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

export interface DiscountRevertProductOutcome {
  productGid: string;
  title: string;
  status: "revertido" | "omitido" | "error";
  detail: string;
}

export interface DiscountRevertResult {
  batchId: string;
  reverted: number;
  skipped: number;
  failed: number;
  outcomes: DiscountRevertProductOutcome[];
}

/**
 * Deshace un lote paso a paso: restaura precio y precio de comparación de
 * ANTES de ese lote — solo de las variantes cuyo precio actual en Shopify
 * sigue siendo el que dejó el lote (si alguien lo cambió a mano después, no se
 * toca esa variante y queda explicado en el resultado). Para volver al precio
 * NORMAL guardado sin importar cuántos cambios se hayan hecho, se usa la acción
 * "Restaurar precio normal", no esto.
 */
export async function revertDiscountBatch(shopify: ShopifyClient, batchId: string): Promise<DiscountRevertResult> {
  if (discountRunInFlight) {
    throw new Error("Ya hay una operación de precios en curso — espera a que termine antes de iniciar otra.");
  }
  discountRunInFlight = true;

  try {
    const channel = await getChannelByCode("shopify");
    const entries = await listAuditEntriesByActions([ACTION_APPLIED, ACTION_REVERTED]);
    const applied = new Map<string, AppliedAfter>();
    const alreadyReverted = new Set<string>();
    for (const e of entries) {
      const after = e.after as Partial<AppliedAfter> | null;
      if (!after || after.batchId !== batchId || !e.entityId) continue;
      if (e.action === ACTION_APPLIED) applied.set(e.entityId, after as AppliedAfter);
      else alreadyReverted.add(e.entityId);
    }
    if (applied.size === 0) throw new Error("No se encontró ese cambio en el historial.");

    const liveProducts = await readLiveCatalog(shopify);
    const baselines = await syncBaselines(liveProducts);
    const live = new Map(liveProducts.map((p) => [p.productGid, p]));
    const outcomes: DiscountRevertProductOutcome[] = [];

    for (const [productGid, snapshot] of applied) {
      const title = snapshot.productTitle ?? productGid;
      if (alreadyReverted.has(productGid)) {
        outcomes.push({ productGid, title, status: "omitido", detail: "Ya estaba revertido." });
        continue;
      }
      const product = live.get(productGid);
      if (!product) {
        outcomes.push({ productGid, title, status: "error", detail: "Este producto ya no existe en Shopify." });
        continue;
      }

      const toRestore: SnapshotVariant[] = [];
      const notes: string[] = [];
      for (const v of snapshot.variants) {
        const liveVariant = product.variants.find((x) => x.variantGid === v.variantGid);
        if (!liveVariant) {
          notes.push(`${v.sku ?? v.variantGid}: la variante ya no existe`);
        } else if (!sameAmount(liveVariant.price, v.afterPrice)) {
          notes.push(
            `${v.sku ?? v.variantGid}: el precio cambió después de ese cambio (ahora ${liveVariant.price}) — no se tocó`,
          );
        } else {
          toRestore.push(v);
        }
      }

      if (toRestore.length === 0) {
        outcomes.push({ productGid, title, status: "omitido", detail: notes.join(" · ") });
        continue;
      }

      try {
        await recordIntendedWrites(baselines, { productGid, title }, toRestore, "revert");
      } catch (err) {
        outcomes.push({
          productGid,
          title,
          status: "error",
          detail: `No se pudo guardar el precio normal en la base de datos, así que NO se tocó Shopify: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      try {
        await withThrottleRetry(() =>
          shopify.updateVariantPrices(
            productGid,
            toRestore.map((v) => ({
              variantGid: v.variantGid,
              price: v.beforePrice,
              compareAtPrice: v.beforeCompareAtPrice,
            })),
          ),
        );
      } catch (err) {
        outcomes.push({ productGid, title, status: "error", detail: err instanceof Error ? err.message : String(err) });
        continue;
      }

      await recordAudit({
        action: ACTION_REVERTED,
        entityType: "shopify_product",
        entityId: productGid,
        after: { batchId, productTitle: title, variants: toRestore },
      });
      if (channel) {
        for (const v of toRestore) await mirrorPriceLocally(channel.id, productGid, v.variantGid, v.beforePrice);
      }
      outcomes.push({ productGid, title, status: "revertido", detail: notes.join(" · ") });
    }

    return {
      batchId,
      reverted: outcomes.filter((o) => o.status === "revertido").length,
      skipped: outcomes.filter((o) => o.status === "omitido").length,
      failed: outcomes.filter((o) => o.status === "error").length,
      outcomes,
    };
  } finally {
    discountRunInFlight = false;
  }
}
