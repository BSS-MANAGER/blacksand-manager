import { listMeliSkuFixCandidates, recordAudit } from "@blacksand/db";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { describeMeliError } from "@blacksand/connector-mercadolibre";

/**
 * "Corregir SKU incorrecto en Mercado Libre" — nació de un pedido directo
 * del usuario, después del fix de lectura del SKU (ver
 * `extractSellerSkuAttribute`, @blacksand/connector-mercadolibre/client.ts):
 * "revisa los productos publicados en ML y corrige los sku que estan con
 * error". Ese fix anterior corrigió que la APP mostrara el SKU incorrecto
 * (leía solo `seller_custom_field`, vacío para varias publicaciones de
 * esta cuenta, y caía a un identificador interno tipo
 * "meli-MLC4476818972-0" en vez del SKU real) — pero no toca lo que está
 * guardado EN Mercado Libre: si `seller_custom_field` está vacío o
 * desactualizado ahí, sigue estando así hasta que algo lo corrija.
 *
 * A diferencia de "Corregir marca por prefijo de SKU" (que necesita que el
 * usuario le diga la marca correcta a mano, por proveedor — el valor
 * correcto no está en ningún lado de la app), acá no hay que preguntarle
 * nada a nadie: el valor correcto es el SKU que la variante YA tiene
 * guardado en la base local (que viene de Shopify, la fuente de verdad del
 * catálogo). Por eso esta herramienta no pide ningún dato al usuario más
 * que confirmar — escanea TODAS las publicaciones de Mercado Libre ya
 * emparejadas a un producto central, compara en vivo contra el SKU real
 * que tienen hoy en Mercado Libre (con el mismo fallback
 * `seller_custom_field` -> atributo `SELLER_SKU` que ya usa `getItem`), y
 * solo ofrece corregir las que de verdad no coinciden.
 */

export interface MeliSkuFixPreviewRow {
  channelProductId: string;
  channelVariantId: string | null;
  productId: string | null;
  productName: string;
  /** SKU correcto — el que ya tiene la variante en la base local (Shopify). */
  expectedSku: string;
  /** SKU real leído EN VIVO desde Mercado Libre (con el fallback a SELLER_SKU) — `null` si no se pudo leer. */
  currentMeliSku: string | null;
  listingStatus: string | null;
  /**
   * Si el ítem (a nivel de publicación, no de variación) ya tiene el
   * atributo `SELLER_SKU` cargado. Cuando es así, `fixMeliSkuMismatches`
   * también corrige ESE atributo además del campo clásico
   * `seller_custom_field` — para esta cuenta, el panel de Mercado Libre
   * puede estar leyendo el SKU de ahí (ver el comentario grande en
   * `extractSellerSkuAttribute`), así que corregir solo el campo clásico
   * no alcanzaría para que se vea bien en el sitio. No se usa para filas
   * con variación (`channelVariantId` no nulo) — ver la limitación
   * explicada en `fixMeliSkuMismatches`.
   */
  hasSellerSkuAttribute: boolean;
  mismatched: boolean;
  /** Si falló la lectura del ítem (ej. token vencido), el motivo — la fila igual se muestra para no ocultar candidatos. */
  readError: string | null;
}

function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toLowerCase();
}

/**
 * Trae los candidatos y lee, PARA CADA PUBLICACIÓN ÚNICA (no por fila —
 * varias variantes de un mismo ítem comparten una sola lectura), el SKU
 * real que tiene hoy en Mercado Libre — mismo criterio de "previsualizar
 * antes de escribir" que el resto de la app (revisión de categoría,
 * "Corregir marca por prefijo de SKU", etc.).
 */
export async function previewMeliSkuFix(meli: MercadoLibreClient): Promise<MeliSkuFixPreviewRow[]> {
  const candidates = await listMeliSkuFixCandidates();
  const rows: MeliSkuFixPreviewRow[] = [];
  const itemCache = new Map<string, Awaited<ReturnType<MercadoLibreClient["getItem"]>>>();
  const errorCache = new Map<string, string>();

  for (const c of candidates) {
    let item = itemCache.get(c.channelProductId);
    if (!item && !errorCache.has(c.channelProductId)) {
      try {
        item = await meli.getItem(c.channelProductId);
        itemCache.set(c.channelProductId, item);
      } catch (err) {
        errorCache.set(c.channelProductId, err instanceof Error ? err.message : String(err));
      }
    }

    if (!item) {
      rows.push({
        channelProductId: c.channelProductId,
        channelVariantId: c.channelVariantId,
        productId: c.productId,
        productName: c.productName,
        expectedSku: c.expectedSku,
        currentMeliSku: null,
        listingStatus: c.listingStatus,
        hasSellerSkuAttribute: false,
        mismatched: false,
        readError: errorCache.get(c.channelProductId) ?? "No se pudo leer el ítem.",
      });
      continue;
    }

    const currentMeliSku = c.channelVariantId
      ? (item.variations.find((v) => v.channelVariantId === c.channelVariantId)?.sku ?? null)
      : item.sku;

    rows.push({
      channelProductId: c.channelProductId,
      channelVariantId: c.channelVariantId,
      productId: c.productId,
      productName: c.productName,
      expectedSku: c.expectedSku,
      currentMeliSku,
      listingStatus: c.listingStatus,
      hasSellerSkuAttribute: item.attributes.some((a) => a.id === "SELLER_SKU"),
      mismatched: normalizeSku(currentMeliSku) !== normalizeSku(c.expectedSku),
      readError: null,
    });
  }

  return rows;
}

export interface MeliSkuFixItemInput {
  channelProductId: string;
  channelVariantId: string | null;
  expectedSku: string;
  productName: string;
  hasSellerSkuAttribute: boolean;
}

export interface MeliSkuFixItemResult {
  channelProductId: string;
  channelVariantId: string | null;
  productName: string;
  expectedSku: string;
  ok: boolean;
  reason?: string;
}

export interface MeliSkuFixRunResult {
  attempted: number;
  fixed: number;
  results: MeliSkuFixItemResult[];
}

/**
 * Corrige el SKU en Mercado Libre para las filas indicadas — el llamador
 * decide cuáles (normalmente, las que `previewMeliSkuFix` marcó
 * `mismatched: true`), esta función nunca corre a ciegas sobre todos los
 * candidatos. Un error puntual (ej. una publicación que dejó de aceptar
 * cambios) no corta el lote — queda registrado en `results` con su motivo,
 * mismo criterio que `fixMeliBrandBySkuPrefix`/`publishBatch`.
 *
 * Siempre escribe `seller_custom_field` (`updateItemStockAndSku`, ya
 * existente). Si la fila es a nivel de ÍTEM (`channelVariantId: null`) y
 * `hasSellerSkuAttribute` es `true`, además corrige el atributo
 * `SELLER_SKU` (`updateItemAttribute`, nuevo). Para publicaciones con
 * variaciones (`channelVariantId` presente) solo se corrige el campo
 * clásico a propósito: corregir el atributo de UNA variación puntual
 * implicaría reescribir `attribute_combinations` completo de esa
 * variación, con el mismo riesgo ya confirmado en vivo con `tags`
 * (reemplaza el array entero) — queda fuera de esta ronda; si el SKU de
 * una variación sigue viéndose mal después de este fix, hay que revisarla
 * a mano en el panel de Mercado Libre.
 */
export async function fixMeliSkuMismatches(
  items: MeliSkuFixItemInput[],
  meli: MercadoLibreClient,
): Promise<MeliSkuFixRunResult> {
  const results: MeliSkuFixItemResult[] = [];
  let fixed = 0;

  for (const it of items) {
    try {
      await meli.updateItemStockAndSku(it.channelProductId, it.channelVariantId, { sku: it.expectedSku });
      if (!it.channelVariantId && it.hasSellerSkuAttribute) {
        await meli.updateItemAttribute(it.channelProductId, "SELLER_SKU", it.expectedSku);
      }

      // No se asume que un PUT sin error significa que el SKU quedó como
      // se pidió — se relee el ítem, mismo criterio ya usado en "Corregir
      // marca" y en "Reactivar".
      const confirmed = await meli.getItem(it.channelProductId);
      const confirmedSku = it.channelVariantId
        ? (confirmed.variations.find((v) => v.channelVariantId === it.channelVariantId)?.sku ?? null)
        : confirmed.sku;

      if (normalizeSku(confirmedSku) !== normalizeSku(it.expectedSku)) {
        results.push({
          channelProductId: it.channelProductId,
          channelVariantId: it.channelVariantId,
          productName: it.productName,
          expectedSku: it.expectedSku,
          ok: false,
          reason: `Mercado Libre aceptó el pedido, pero al releer el ítem el SKU quedó en "${confirmedSku ?? "(vacío)"}" en vez de "${it.expectedSku}" — revisá esta publicación directo en Mercado Libre.`,
        });
        continue;
      }

      await recordAudit({
        action: "corregir_sku_meli",
        entityType: "channel_product_map",
        entityId: it.channelProductId,
        before: {},
        after: { sku: it.expectedSku, channelVariantId: it.channelVariantId },
      });
      results.push({
        channelProductId: it.channelProductId,
        channelVariantId: it.channelVariantId,
        productName: it.productName,
        expectedSku: it.expectedSku,
        ok: true,
      });
      fixed += 1;
    } catch (err) {
      results.push({
        channelProductId: it.channelProductId,
        channelVariantId: it.channelVariantId,
        productName: it.productName,
        expectedSku: it.expectedSku,
        ok: false,
        reason: describeMeliError(err).message,
      });
    }
  }

  return { attempted: items.length, fixed, results };
}
