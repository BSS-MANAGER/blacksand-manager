import {
  getDb,
  getChannelByCode,
  upsertChannelProductMap,
  upsertChannelSyncStatus,
  upsertCentralProduct,
  getOrCreateDefaultLocation,
  upsertVariantWithStock,
  updateVariantFields,
  getVariantOnHandTotal,
  recordAudit,
  setChannelListingStatus,
} from "@blacksand/db";
import { matchChannelEntry, type CentralCatalogEntry, type ChannelCatalogEntry } from "@blacksand/core-domain";
import type { ShopifyClient } from "@blacksand/connector-shopify";
import { fetchAllShopifyProducts } from "@blacksand/connector-shopify";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";

export interface ImportSummary {
  channel: "shopify" | "mercadolibre";
  totalItems: number;
  matched: number;
  ambiguous: number;
  createdNew: number;
  /**
   * Solo en `importMercadoLibreCatalog` (ver el comentario grande ahí
   * abajo): publicaciones que la app tenía mapeadas de una corrida anterior
   * y que esta vez NO aparecieron en la respuesta de Mercado Libre en
   * NINGÚN estado conocido — se interpretan como eliminadas del todo (no
   * solo pausadas/cerradas, que Mercado Libre sí sigue reportando) y se
   * marcan `listingStatus: "closed"` para que la pantalla Productos y
   * "Publicar en ML" dejen de contarlas como publicadas.
   */
  removedListings?: number;
}

async function loadCentralCatalog(): Promise<CentralCatalogEntry[]> {
  const db = getDb();
  const variants = await db.productVariant.findMany({ select: { id: true, productId: true, skuVariant: true, barcodeVariant: true } });
  return variants.map((v) => ({
    productId: v.productId,
    variantId: v.id,
    sku: v.skuVariant,
    barcode: v.barcodeVariant,
  }));
}

/**
 * Importador de Fase 1 (L.1, entregable 6): trae el catálogo completo de un
 * canal, lo empareja contra el catálogo central por SKU/código de barras
 * (G.1) y dexa los casos ambiguos en conciliación manual — nunca escribe de
 * vuelta al canal (eso es Fase 2).
 */
export async function importShopifyCatalog(client: ShopifyClient): Promise<ImportSummary> {
  const channel = await getChannelByCode("shopify");
  const location = await getOrCreateDefaultLocation();
  const products = await fetchAllShopifyProducts(client);

  let matched = 0;
  let ambiguous = 0;
  let createdNew = 0;

  for (const product of products) {
    const central = await loadCentralCatalog();

    for (const variant of product.variants) {
      const entry: ChannelCatalogEntry = {
        channelProductId: product.channelProductId,
        channelVariantId: variant.channelVariantId,
        sku: variant.sku,
        barcode: variant.barcode,
        title: `${product.title} — ${variant.title}`,
      };

      const outcome = matchChannelEntry(entry, central);

      if (outcome.kind === "match_exacto") {
        matched += 1;
        await upsertChannelProductMap({
          productId: outcome.central.productId,
          variantId: outcome.central.variantId,
          channelId: channel.id,
          channelProductId: product.channelProductId,
          channelVariantId: variant.channelVariantId,
          channelSku: variant.sku,
          syncStatus: "sincronizado",
        });
        // Fase 2b: el color (y, con el mismo criterio, la talla) se
        // sincronizan desde Shopify en CADA importación (no solo al crear la
        // variante) — a diferencia del stock (que no se toca acá, ver
        // `stockDiff` abajo: la base local sigue siendo la fuente de
        // verdad), ninguno de los dos tiene conflicto posible con otro
        // canal, así que Shopify manda siempre. Solo si Shopify SÍ reporta
        // un valor (nunca se borra un color/talla ya cargado por un cambio
        // pasajero en la consulta).
        if (variant.color || variant.size) {
          await updateVariantFields(outcome.central.variantId, {
            ...(variant.color ? { color: variant.color } : {}),
            ...(variant.size ? { size: variant.size } : {}),
          });
        }
        // Dashboard de sincronización (módulo 5, L.1 entregable 7): registra
        // el estado agregado por producto+canal para TODO match, no solo
        // para productos recién creados — de lo contrario la mayoría de un
        // catálogo ya existente nunca aparecería en el dashboard.
        const centralOnHand = await getVariantOnHandTotal(outcome.central.variantId);
        const channelReported = variant.inventoryQuantity ?? 0;
        await upsertChannelSyncStatus({
          productId: outcome.central.productId,
          channelId: channel.id,
          status: "sincronizado",
          stockDiff: channelReported - centralOnHand,
        });
      } else if (outcome.kind === "ambiguo") {
        ambiguous += 1;
        await upsertChannelProductMap({
          channelId: channel.id,
          channelProductId: product.channelProductId,
          channelVariantId: variant.channelVariantId,
          channelSku: variant.sku,
          syncStatus: "conflicto",
        });
      } else {
        createdNew += 1;
        const centralProduct = await upsertCentralProduct({
          sku: variant.sku ?? `shopify-${variant.channelVariantId}`,
          barcode: variant.barcode,
          name: product.title,
          brand: product.vendor,
          category: product.productType,
        });
        const createdVariant = await upsertVariantWithStock({
          productId: centralProduct.id,
          skuVariant: variant.sku ?? `shopify-${variant.channelVariantId}`,
          barcodeVariant: variant.barcode,
          color: variant.color,
          size: variant.size,
          price: variant.price,
          quantityOnHand: variant.inventoryQuantity ?? 0,
          locationId: location.id,
        });
        await upsertChannelProductMap({
          productId: centralProduct.id,
          variantId: createdVariant.id,
          channelId: channel.id,
          channelProductId: product.channelProductId,
          channelVariantId: variant.channelVariantId,
          channelSku: variant.sku,
          syncStatus: "sincronizado",
        });
        await upsertChannelSyncStatus({ productId: centralProduct.id, channelId: channel.id, status: "sincronizado" });
      }
    }
  }

  await recordAudit({
    action: "importar_catalogo",
    entityType: "channel",
    entityId: channel.id,
    after: { totalItems: products.length, matched, ambiguous, createdNew },
  });

  return { channel: "shopify", totalItems: products.length, matched, ambiguous, createdNew };
}

export async function importMercadoLibreCatalog(client: MercadoLibreClient): Promise<ImportSummary> {
  const channel = await getChannelByCode("mercadolibre");
  const location = await getOrCreateDefaultLocation();

  /**
   * Reconciliación (a pedido del usuario): antes de esta corrida, se guarda
   * qué `channelProductId` de Mercado Libre conocía la app de una
   * importación anterior (excluyendo lo que YA estaba marcado "closed" —
   * nada que reconciliar ahí). `client.fetchAllItems()` ya recorre los 6
   * estados que Mercado Libre expone (`listAllItemIds`: active, paused,
   * closed, under_review, inactive, payment_required), así que si un
   * `channelProductId` conocido no aparece en la respuesta fresca en
   * NINGUNO de esos estados, es porque Mercado Libre ya no lo tiene de
   * ninguna forma — el caso real que reportó el usuario: publicaciones que
   * la app desactivó y el usuario terminó borrando del todo en Mercado
   * Libre para volver a subirlas. Sin este barrido, esa fila vieja de
   * `ChannelProductMap` se quedaba con su último `listingStatus` conocido
   * (a veces "active"/"paused", nunca actualizado a "closed") y el producto
   * seguía viéndose como "ya publicado en Mercado Libre" para siempre.
   */
  const db = getDb();
  const previouslyKnownIds = new Set(
    (
      await db.channelProductMap.findMany({
        where: {
          channelId: channel.id,
          OR: [{ listingStatus: null }, { listingStatus: { not: "closed" } }],
        },
        select: { channelProductId: true },
      })
    ).map((r) => r.channelProductId),
  );

  const items = await client.fetchAllItems();

  let matched = 0;
  let ambiguous = 0;
  let createdNew = 0;

  for (const item of items) {
    const central = await loadCentralCatalog();
    const rows = item.variations.length > 0 ? item.variations : [
      { channelVariantId: null as string | null, sku: item.sku, availableQuantity: item.availableQuantity, attributes: [] },
    ];

    for (const row of rows) {
      const entry: ChannelCatalogEntry = {
        channelProductId: item.channelProductId,
        channelVariantId: row.channelVariantId,
        sku: row.sku,
        barcode: null,
        title: item.title,
      };

      const outcome = matchChannelEntry(entry, central);

      if (outcome.kind === "match_exacto") {
        matched += 1;
        await upsertChannelProductMap({
          productId: outcome.central.productId,
          variantId: outcome.central.variantId,
          channelId: channel.id,
          channelProductId: item.channelProductId,
          channelVariantId: row.channelVariantId,
          channelSku: row.sku,
          syncStatus: "sincronizado",
          // Ver el comentario grande en `ChannelProductMap.listingStatus`
          // (esquema) — esto es lo que faltaba para que la pantalla
          // "Estado en Mercado Libre" supiera si esta publicación sigue
          // activa, o si Mercado Libre ya la pausó/cerró por su cuenta.
          listingStatus: item.status,
          listingSubStatus: JSON.stringify(item.subStatus),
        });
        const centralOnHand = await getVariantOnHandTotal(outcome.central.variantId);
        const channelReported = row.availableQuantity ?? 0;
        await upsertChannelSyncStatus({
          productId: outcome.central.productId,
          channelId: channel.id,
          status: "sincronizado",
          stockDiff: channelReported - centralOnHand,
        });
      } else if (outcome.kind === "ambiguo") {
        ambiguous += 1;
        await upsertChannelProductMap({
          channelId: channel.id,
          channelProductId: item.channelProductId,
          channelVariantId: row.channelVariantId,
          channelSku: row.sku,
          syncStatus: "conflicto",
          listingStatus: item.status,
          listingSubStatus: JSON.stringify(item.subStatus),
        });
      } else {
        createdNew += 1;
        const centralProduct = await upsertCentralProduct({
          sku: row.sku ?? `meli-${item.channelProductId}-${row.channelVariantId ?? "0"}`,
          name: item.title,
          category: item.categoryId,
          basePrice: item.price,
        });
        const createdVariant = await upsertVariantWithStock({
          productId: centralProduct.id,
          skuVariant: row.sku ?? `meli-${item.channelProductId}-${row.channelVariantId ?? "0"}`,
          price: item.price,
          quantityOnHand: row.availableQuantity ?? 0,
          locationId: location.id,
        });
        await upsertChannelProductMap({
          productId: centralProduct.id,
          variantId: createdVariant.id,
          channelId: channel.id,
          channelProductId: item.channelProductId,
          channelVariantId: row.channelVariantId,
          channelSku: row.sku,
          syncStatus: "sincronizado",
          listingStatus: item.status,
          listingSubStatus: JSON.stringify(item.subStatus),
        });
        await upsertChannelSyncStatus({ productId: centralProduct.id, channelId: channel.id, status: "sincronizado" });
      }
    }
  }

  // Ver el comentario grande más arriba (junto a `previouslyKnownIds`).
  // Salvaguarda: si Mercado Libre devolvió CERO ítems pero la app tenía
  // publicaciones mapeadas de antes, es mucho más probable que haya un
  // problema puntual (token, red, corte de la API) que una cuenta que se
  // quedó sin ninguna publicación viva de golpe — en ese caso NO se marca
  // nada como eliminado (mejor una fila desactualizada que borrar de un
  // barrido todo el estado de Mercado Libre por un error transitorio).
  let removedListings = 0;
  if (!(items.length === 0 && previouslyKnownIds.size > 0)) {
    const seenIds = new Set(items.map((i) => i.channelProductId));
    for (const id of previouslyKnownIds) {
      if (!seenIds.has(id)) {
        await setChannelListingStatus(channel.id, id, "closed", ["ya_no_existe_en_mercadolibre"]);
        removedListings += 1;
      }
    }
  }

  await recordAudit({
    action: "importar_catalogo",
    entityType: "channel",
    entityId: channel.id,
    after: { totalItems: items.length, matched, ambiguous, createdNew, removedListings },
  });

  return { channel: "mercadolibre", totalItems: items.length, matched, ambiguous, createdNew, removedListings };
}
