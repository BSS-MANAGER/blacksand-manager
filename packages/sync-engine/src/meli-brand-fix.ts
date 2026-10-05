import { listMeliBrandFixCandidates, updateProductBrand, recordAudit } from "@blacksand/db";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { describeMeliError } from "@blacksand/connector-mercadolibre";

/**
 * "Corregir marca por prefijo de SKU" — nació de un problema real: varios
 * productos con SKU que empieza con "EM" (EmersonGear) quedaron publicados
 * en Mercado Libre con la marca "BLACK SAND SECURITY" (la "Marca por
 * defecto" de Configuración) en vez de "EmersonGear", porque esos
 * productos no tenían el campo "Proveedor" (vendor) cargado en Shopify al
 * momento de publicar — `buildCreateItemPayload` (@blacksand/core-domain)
 * usa `product.brand` y solo cae al default de grupo/config cuando viene
 * vacío.
 *
 * A diferencia de "Color por defecto" o "Talla siempre Standard" (que
 * corrigen cómo se publica algo NUEVO), esto corrige publicaciones que YA
 * existen en Mercado Libre — por eso busca por prefijo de SKU en vez de
 * por grupo/categoría (el problema es del proveedor, no de la categoría de
 * Mercado Libre), y actualiza el ítem real vía `PUT /items/{id}` en vez de
 * tocar un mapeo de grupo.
 *
 * También corrige, opcionalmente, la marca guardada en la base LOCAL
 * (`Product.brand`) para esos mismos SKU — así, si alguno de estos
 * productos queda con su publicación cerrada más adelante y vuelve a
 * aparecer como candidato en "Publicar en ML" (ver `hasMeli` en
 * `meli-publish.ts`), la publicación nueva sale con la marca correcta
 * desde el principio, sin depender de la "Marca por defecto" global. Esto
 * es seguro: el importador de Shopify (`importer.ts`) solo escribe
 * `brand` al CREAR un producto nuevo, nunca en una importación normal de
 * un producto que ya existe — así que este fix no se pisa solo la próxima
 * vez que se importe Shopify.
 */

export interface MeliBrandFixPreviewRow {
  channelProductId: string;
  productId: string | null;
  productName: string;
  sku: string;
  listingStatus: string | null;
  /**
   * Marca leída EN VIVO desde el ítem real de Mercado Libre (no la de la
   * base local, que puede no coincidir con lo que de verdad se mandó al
   * publicar) — `null` si el ítem no tiene el atributo BRAND cargado, o si
   * no se pudo leer (ver `readError`).
   */
  currentMeliBrand: string | null;
  /** Si falló la lectura del ítem (ej. token vencido), el motivo — la fila igual se muestra para no ocultar candidatos. */
  readError: string | null;
}

/**
 * Trae los candidatos (por prefijo de SKU) y lee, PARA CADA UNO, la marca
 * real que tiene hoy la publicación en Mercado Libre — para que el usuario
 * vea exactamente qué se va a cambiar antes de confirmar nada (mismo
 * criterio de "previsualizar antes de escribir" que el resto de Fase 2b:
 * revisión de categoría, revisión masiva, etc.).
 */
export async function previewMeliBrandFix(
  skuPrefix: string,
  meli: MercadoLibreClient,
): Promise<MeliBrandFixPreviewRow[]> {
  const candidates = await listMeliBrandFixCandidates(skuPrefix);
  const rows: MeliBrandFixPreviewRow[] = [];

  for (const c of candidates) {
    let currentMeliBrand: string | null = null;
    let readError: string | null = null;
    try {
      const item = await meli.getItem(c.channelProductId);
      currentMeliBrand = item.attributes.find((a) => a.id === "BRAND")?.valueName ?? null;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    rows.push({
      channelProductId: c.channelProductId,
      productId: c.productId,
      productName: c.productName,
      sku: c.sku,
      listingStatus: c.listingStatus,
      currentMeliBrand,
      readError,
    });
  }

  return rows;
}

export interface MeliBrandFixItemResult {
  channelProductId: string;
  productName: string;
  sku: string;
  ok: boolean;
  reason?: string;
}

export interface MeliBrandFixRunResult {
  attempted: number;
  fixed: number;
  results: MeliBrandFixItemResult[];
}

/**
 * Corrige el atributo BRAND en Mercado Libre para todos los productos con
 * el prefijo de SKU dado, y (si `updateLocalBrand`) también la marca en la
 * base local. Un error puntual (ej. una publicación cerrada que ya no
 * acepta cambios) no corta el lote — queda registrado en `results` con su
 * motivo, igual que `publishBatch`.
 */
export async function fixMeliBrandBySkuPrefix(
  skuPrefix: string,
  newBrand: string,
  meli: MercadoLibreClient,
  updateLocalBrand: boolean,
): Promise<MeliBrandFixRunResult> {
  const candidates = await listMeliBrandFixCandidates(skuPrefix);
  const results: MeliBrandFixItemResult[] = [];
  let fixed = 0;

  for (const c of candidates) {
    try {
      await meli.updateItemBrand(c.channelProductId, newBrand);
      // No se asume que el PUT sin error significa que la marca quedó
      // como se pidió — se relee el ítem, mismo criterio ya usado en
      // `reactivateMeliListing` y en la verificación de SKU al publicar.
      const confirmed = await meli.getItem(c.channelProductId);
      const confirmedBrand = confirmed.attributes.find((a) => a.id === "BRAND")?.valueName ?? null;
      if (confirmedBrand !== newBrand) {
        results.push({
          channelProductId: c.channelProductId,
          productName: c.productName,
          sku: c.sku,
          ok: false,
          reason: `Mercado Libre aceptó el pedido, pero al releer el ítem la marca quedó en "${confirmedBrand ?? "(vacía)"}" en vez de "${newBrand}" — revisá esta publicación directo en Mercado Libre.`,
        });
        continue;
      }

      if (updateLocalBrand && c.productId) {
        await updateProductBrand(c.productId, newBrand);
      }
      await recordAudit({
        action: "corregir_marca_meli",
        entityType: "channel_product_map",
        entityId: c.channelProductId,
        before: { brand: c.localBrand },
        after: { brand: newBrand, skuPrefix, updatedLocalBrand: updateLocalBrand && !!c.productId },
      });
      results.push({ channelProductId: c.channelProductId, productName: c.productName, sku: c.sku, ok: true });
      fixed += 1;
    } catch (err) {
      results.push({
        channelProductId: c.channelProductId,
        productName: c.productName,
        sku: c.sku,
        ok: false,
        reason: describeMeliError(err).message,
      });
    }
  }

  return { attempted: candidates.length, fixed, results };
}
