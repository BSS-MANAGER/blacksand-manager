import {
  findProductBySkuOrBarcode,
  upsertCentralProduct,
  upsertVariantWithStock,
  getOrCreateDefaultLocation,
  upsertChannelProductMap,
  upsertChannelSyncStatus,
  getChannelByCode,
  getGroupMapping,
  recordAudit,
} from "@blacksand/db";
import type { PushChannelClients } from "./push.js";
import { publishBatch } from "./meli-publish.js";

/**
 * "Crear producto" — a pedido explícito del usuario: "mi idea es que
 * podamos trabajar para subir los productos desde la app, entonces de esta
 * forma yo subo un producto a la app y estos automáticamente se suben a
 * Shopify y ML". Decisiones que tomó el usuario (preguntadas antes de
 * construir esto): SKU único (sin variantes de color/talla — igual que ya
 * funciona el resto del catálogo central), fotos subidas directo desde su
 * computador (no URLs ya alojadas), y Mercado Libre automático en el mismo
 * acto de crear (cuando la categoría ya está confirmada).
 *
 * Estrategia: crear PRIMERO en Shopify (con imágenes/descripción), y recién
 * ahí reusar el flujo de "Publicar en ML" (Fase 2b, `meli-publish.ts`) tal
 * cual — ese flujo ya sabe traer imágenes/descripción/peso/medidas DESDE
 * Shopify y armar el payload de Mercado Libre; no hace falta duplicar nada
 * de esa lógica acá. Una vez que el producto queda mapeado a `shopify`,
 * `loadCandidateProducts` (en `meli-publish.ts`) ya lo ve como cualquier
 * otro candidato — la única diferencia es que acá se apunta `publishBatch`
 * a ESTE `variantId` puntual (con `onlyVariantIds`) en vez de dejar que
 * tome cualquier candidato del grupo.
 */

function computeGroupKey(category: string | null | undefined, sku: string): string {
  const trimmed = category?.trim();
  return trimmed ? trimmed : `sku:${sku}`;
}

export interface NewProductImageInput {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface NewProductInput {
  sku: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  price: number;
  quantityOnHand: number;
  images: NewProductImageInput[];
}

export type CreateProductMeliOutcome =
  | { status: "no_conectado" }
  | { status: "categoria_sin_confirmar"; groupKey: string }
  | { status: "publicado"; warnings: string[] }
  | { status: "error"; reason: string };

export interface CreateProductResult {
  productId: string;
  variantId: string;
  sku: string;
  groupKey: string;
  shopifyProductGid: string;
  /** Si `setVariantInventoryQuantity` falló (ver el comentario en `ShopifyClient.createProduct`) — el producto ya quedó creado igual, el stock hay que revisarlo a mano en Shopify. */
  stockWarning: string | null;
  /** Imagen por imagen: cuál falló al subir (si alguna) — el producto ya quedó creado igual con las que sí subieron. */
  imageWarnings: string[];
  meli: CreateProductMeliOutcome;
}

/**
 * Crea un producto nuevo (Shopify primero, catálogo central después, y
 * Mercado Libre en el mismo acto si la categoría del grupo ya está
 * confirmada) — nunca lanza por un paso "extra" que falle después de que el
 * producto ya existe en Shopify (imágenes, stock, Mercado Libre): esos
 * quedan como advertencias en el resultado, mismo criterio que
 * `publishBatch`. Si falla la creación en Shopify en sí (el paso crítico),
 * SÍ lanza — no hay nada que guardar en la base central todavía.
 */
export async function createProductAndPublish(
  clients: PushChannelClients,
  input: NewProductInput,
  config: { defaultBrand: string | null },
): Promise<CreateProductResult> {
  if (!clients.shopify) {
    throw new Error("Shopify no está configurado — conéctalo en Configuración antes de crear productos.");
  }
  if (!input.name.trim()) throw new Error("Falta el nombre del producto.");
  if (!input.sku.trim()) throw new Error("Falta el SKU del producto.");
  if (!(input.price > 0)) throw new Error("El precio debe ser mayor a 0.");
  if (input.images.length === 0) {
    throw new Error("Agrega al menos una foto — Mercado Libre exige al menos una imagen para publicar.");
  }

  const existing = await findProductBySkuOrBarcode(input.sku, input.barcode ?? undefined);
  if (existing) {
    throw new Error(
      `Ya existe un producto con el SKU "${input.sku}" en la app (${existing.name}) — usa "Productos" para editarlo, "Crear producto" es solo para productos nuevos.`,
    );
  }

  // 1. Shopify primero — paso crítico, si falla no se guarda nada localmente.
  const shopify = clients.shopify;
  const created = await shopify.createProduct({
    title: input.name,
    descriptionHtml: input.description ?? null,
    vendor: input.brand ?? null,
    productType: input.category ?? null,
  });
  await shopify.updateVariantPriceAndSku(created.productGid, created.defaultVariantGid, {
    price: input.price,
    sku: input.sku,
    barcode: input.barcode ?? undefined,
  });

  let stockWarning: string | null = null;
  try {
    await shopify.setVariantInventoryQuantity(created.defaultVariantGid, input.quantityOnHand);
  } catch (err) {
    stockWarning = `El producto se creó en Shopify, pero no se pudo fijar el stock inicial (${
      err instanceof Error ? err.message : String(err)
    }) — revísalo y cárgalo a mano en Shopify.`;
  }

  const imageWarnings: string[] = [];
  for (const image of input.images) {
    try {
      await shopify.uploadProductImage(created.productGid, image);
    } catch (err) {
      imageWarnings.push(
        `No se pudo subir "${image.filename}" (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  // 2. Catálogo central.
  const location = await getOrCreateDefaultLocation();
  const product = await upsertCentralProduct({
    sku: input.sku,
    barcode: input.barcode ?? null,
    name: input.name,
    description: input.description ?? null,
    brand: input.brand ?? null,
    category: input.category ?? null,
    basePrice: input.price,
  });
  const variant = await upsertVariantWithStock({
    productId: product.id,
    skuVariant: input.sku,
    barcodeVariant: input.barcode ?? null,
    price: input.price,
    quantityOnHand: input.quantityOnHand,
    locationId: location.id,
  });

  // 3. Mapeo a Shopify — a partir de acá, "Publicar en ML"/`loadCandidateProducts` ya lo ve como candidato.
  const shopifyChannel = await getChannelByCode("shopify");
  await upsertChannelProductMap({
    productId: product.id,
    variantId: variant.id,
    channelId: shopifyChannel.id,
    channelProductId: created.productGid,
    channelVariantId: created.defaultVariantGid,
    channelSku: input.sku,
    syncStatus: "sincronizado",
  });
  await upsertChannelSyncStatus({ productId: product.id, channelId: shopifyChannel.id, status: "sincronizado" });
  await recordAudit({
    action: "crear_producto",
    entityType: "product",
    entityId: product.id,
    after: {
      sku: input.sku,
      name: input.name,
      shopifyProductGid: created.productGid,
      price: input.price,
      quantityOnHand: input.quantityOnHand,
    },
  });

  // 4. Mercado Libre, en el mismo acto, si corresponde.
  const groupKey = computeGroupKey(input.category, input.sku);
  let meli: CreateProductMeliOutcome;
  if (!clients.mercadolibre) {
    meli = { status: "no_conectado" };
  } else {
    const mapping = await getGroupMapping(groupKey);
    if (!mapping) {
      meli = { status: "categoria_sin_confirmar", groupKey };
    } else {
      const result = await publishBatch(clients, groupKey, 1, config, new Set([variant.id]));
      if (result.created === 1) {
        meli = { status: "publicado", warnings: result.warnings.map((w) => w.reason) };
      } else {
        meli = { status: "error", reason: result.errors[0]?.reason ?? "No se pudo publicar en Mercado Libre." };
      }
    }
  }

  return {
    productId: product.id,
    variantId: variant.id,
    sku: input.sku,
    groupKey,
    shopifyProductGid: created.productGid,
    stockWarning,
    imageWarnings,
    meli,
  };
}
