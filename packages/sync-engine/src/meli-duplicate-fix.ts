import { listProductsWithSyncStatus, listPublishAuditEntriesForEntity } from "@blacksand/db";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { closeMeliListing, type MeliListingCloseResult } from "./meli-listing-status.js";

/**
 * "Cerrar publicaciones duplicadas" — nació de un caso real encontrado
 * investigando lo que el usuario reportó como "productos publicados con
 * más de una variante": ~20 productos quedaron publicados DOS VECES en
 * Mercado Libre (dos `channelProductId` distintos para la MISMA variante
 * local), creados 1-2 segundos aparte según el registro de auditoría — un
 * doble clic en "Publicar lote"/"Publicar todo automáticamente" alcanzaba
 * a disparar dos publicaciones casi simultáneas para el mismo candidato
 * antes de que la primera terminara de guardar su `ChannelProductMap`. Ya
 * se corrigió la causa (ver `publishGuardRef` en `PublicarMeliPage.tsx` y
 * `findActiveChannelMapByVariant` en `publishBatch`, @blacksand/db) — esta
 * pantalla ayuda a limpiar los que quedaron duplicados ANTES del fix.
 */

export interface MeliDuplicateItem {
  channelProductId: string;
  listingStatus: string | null;
  createdOrder: number | null;
}

export interface MeliDuplicateGroup {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  items: MeliDuplicateItem[];
  /**
   * Solo se calcula cuando TODOS los ítems del grupo tienen su propio
   * evento "publicar_en_canal" en el registro de auditoría — así se sabe
   * con certeza que son duplicados creados por esta app, y en qué orden.
   * `null` = sin recomendación confiable (ver el comentario grande en
   * `MeliDuplicateGroup`, shared-ipc-types.ts — caso real de "SOPORTE
   * TÁCTICO PARA CELULAR", con una publicación extra sin evento propio).
   */
  recommendedKeep: string | null;
}

/**
 * Agrupa, por variante local, las publicaciones ACTIVAS (no cerradas) de
 * Mercado Libre que la app conoce — cualquier variante con más de una es un
 * duplicado. No toca nada; solo lee.
 */
export async function previewMeliDuplicates(): Promise<MeliDuplicateGroup[]> {
  const products = await listProductsWithSyncStatus();
  const groups: MeliDuplicateGroup[] = [];

  for (const p of products) {
    const meliMaps = p.channelMap.filter((m) => m.channel.code === "mercadolibre" && m.listingStatus !== "closed");

    const byVariant = new Map<string, typeof meliMaps>();
    for (const m of meliMaps) {
      if (!m.variantId) continue;
      const list = byVariant.get(m.variantId) ?? [];
      list.push(m);
      byVariant.set(m.variantId, list);
    }

    for (const [variantId, maps] of byVariant) {
      if (maps.length <= 1) continue;

      const variant = p.variants.find((v) => v.id === variantId);
      const auditEntries = await listPublishAuditEntriesForEntity(p.id);

      const dated = maps.map((m) => {
        const match = auditEntries.find((e) => e.after?.itemId === m.channelProductId);
        return {
          channelProductId: m.channelProductId,
          listingStatus: m.listingStatus,
          createdAt: match?.createdAt ?? null,
        };
      });

      // Solo se confía en el orden si TODOS tienen fecha — si a uno le
      // falta, no se puede saber si es un duplicado del bug o una
      // publicación anterior legítima (ver el comentario grande arriba).
      const allDated = dated.every((d) => d.createdAt !== null);
      const sorted = allDated ? [...dated].sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime()) : dated;

      const items: MeliDuplicateItem[] = sorted.map((d, i) => ({
        channelProductId: d.channelProductId,
        listingStatus: d.listingStatus,
        createdOrder: allDated ? i + 1 : null,
      }));

      groups.push({
        productId: p.id,
        variantId,
        productName: p.name,
        sku: variant?.skuVariant ?? p.sku,
        items,
        recommendedKeep: allDated ? items[0]!.channelProductId : null,
      });
    }
  }

  return groups;
}

export interface MeliDuplicateCloseOutcome {
  channelProductId: string;
  result: MeliListingCloseResult;
}

/**
 * Cierra (ver el comentario grande de `closeMeliListing` — "Finalizar
 * publicación", no un borrado real) cada `channelProductId` de la lista.
 * Nunca decide sola cuáles cerrar: siempre recibe la lista exacta que el
 * usuario confirmó después de revisar `previewMeliDuplicates` en pantalla.
 */
export async function closeMeliDuplicates(
  meli: MercadoLibreClient,
  channelProductIds: string[],
): Promise<MeliDuplicateCloseOutcome[]> {
  const outcomes: MeliDuplicateCloseOutcome[] = [];
  for (const channelProductId of channelProductIds) {
    const result = await closeMeliListing(meli, channelProductId);
    outcomes.push({ channelProductId, result });
  }
  return outcomes;
}
