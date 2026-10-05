import { listStockAuditCandidates, recordAudit } from "@blacksand/db";
import type { ShopifyClient } from "@blacksand/connector-shopify";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { pushVariantToChannels, type PushChannelClients, type PushChannelResult } from "./push.js";

/**
 * "Auditoría de Stock" — nació de un caso real reportado por el usuario:
 * "el inventario de casco wendy en shopify es 9 y en ML es 10, algo pasó,
 * revisalo y corrige". La app ya empuja cada edición manual a ambos
 * canales (ver `pushVariantToChannels`, `push.ts`) y ya reintenta solo el
 * stock que cambia por una venta (ver `pushStockToOtherChannels`) — pero
 * eso no explica un caso como este, donde probablemente alguien tocó el
 * stock DIRECTO en Shopify o en Mercado Libre, por fuera de la app (una
 * venta de mostrador registrada mal, un ajuste manual en el panel de cada
 * plataforma, etc.). La app no puede "adivinar" cuál de los dos números es
 * el correcto — el usuario es quien sabe si de verdad hay 9 o 10 cascos —
 * así que esta pantalla muestra los TRES valores (local, Shopify en vivo,
 * Mercado Libre en vivo) uno al lado del otro para que el usuario decida,
 * y deja aplicar la corrección con un clic (reusa `pushVariantToChannels`
 * tal cual, el mismo mecanismo ya probado que usa "Guardar" en Productos —
 * no hace falta ningún camino de escritura nuevo).
 */

export interface StockAuditRow {
  variantId: string;
  productName: string;
  sku: string;
  localQuantity: number;
  /** `null` si no se pudo leer en vivo (ver `readError`). */
  shopifyQuantity: number | null;
  meliQuantity: number | null;
  /** `true` si Shopify y Mercado Libre (los dos valores en vivo) no coinciden entre sí. Si alguno no se pudo leer, queda en `false` — no se puede afirmar un desacuerdo sin los dos números. */
  mismatched: boolean;
  readError: string | null;
}

/**
 * Lee EN VIVO el stock de Shopify y de Mercado Libre para cada candidato
 * (variante publicada en ambos canales) y arma la comparación. Cachea las
 * lecturas de Mercado Libre por `channelProductId` único — igual que
 * `previewMeliSkuFix` — porque varias filas pueden compartir la misma
 * publicación cuando tiene variaciones (no es el caso típico de esta app,
 * que aplana el catálogo a un SKU = un producto, pero se cubre igual por
 * las publicaciones viejas creadas antes de Fase 2b o fuera de la app).
 */
export async function previewStockAudit(
  shopify: ShopifyClient,
  meli: MercadoLibreClient,
): Promise<StockAuditRow[]> {
  const candidates = await listStockAuditCandidates();
  const rows: StockAuditRow[] = [];
  const meliItemCache = new Map<string, Awaited<ReturnType<MercadoLibreClient["getItem"]>>>();
  const meliErrorCache = new Map<string, string>();

  for (const c of candidates) {
    let shopifyQuantity: number | null = null;
    let readError: string | null = null;

    try {
      shopifyQuantity = await shopify.getVariantInventoryQuantity(c.shopifyChannelVariantId ?? c.shopifyChannelProductId);
    } catch (err) {
      readError = `Shopify: ${err instanceof Error ? err.message : String(err)}`;
    }

    let meliItem = meliItemCache.get(c.meliChannelProductId);
    if (!meliItem && !meliErrorCache.has(c.meliChannelProductId)) {
      try {
        meliItem = await meli.getItem(c.meliChannelProductId);
        meliItemCache.set(c.meliChannelProductId, meliItem);
      } catch (err) {
        meliErrorCache.set(c.meliChannelProductId, err instanceof Error ? err.message : String(err));
      }
    }

    let meliQuantity: number | null = null;
    if (meliItem) {
      meliQuantity = c.meliChannelVariantId
        ? (meliItem.variations.find((v) => v.channelVariantId === c.meliChannelVariantId)?.availableQuantity ?? null)
        : meliItem.availableQuantity;
    } else if (meliErrorCache.has(c.meliChannelProductId)) {
      const meliError = `Mercado Libre: ${meliErrorCache.get(c.meliChannelProductId)}`;
      readError = readError ? `${readError} · ${meliError}` : meliError;
    }

    rows.push({
      variantId: c.variantId,
      productName: c.productName,
      sku: c.sku,
      localQuantity: c.localQuantity,
      shopifyQuantity,
      meliQuantity,
      mismatched: shopifyQuantity !== null && meliQuantity !== null && shopifyQuantity !== meliQuantity,
      readError,
    });
  }

  return rows;
}

export type StockAuditApplyResult = { ok: true; results: PushChannelResult[] } | { ok: false; reason: string };

/**
 * Aplica el valor que el usuario elija (el de Shopify, el de Mercado Libre,
 * o uno escrito a mano después de un conteo físico) como el stock correcto
 * — reusa `pushVariantToChannels` tal cual: guarda ese valor en la base
 * local y lo empuja de inmediato a AMBOS canales, con el mismo manejo de
 * error por canal que ya usa "Guardar" en Productos. No hay lógica de
 * escritura nueva acá a propósito, para no duplicar (ni arriesgar
 * desincronizar) el camino ya probado.
 */
export async function applyStockAuditCorrection(
  variantId: string,
  quantity: number,
  clients: PushChannelClients,
): Promise<StockAuditApplyResult> {
  try {
    const results = await pushVariantToChannels(variantId, { quantity }, clients);
    await recordAudit({
      action: "corregir_stock_auditoria",
      entityType: "product_variant",
      entityId: variantId,
      after: { quantity, results },
    });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
