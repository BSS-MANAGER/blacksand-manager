import { getDb } from "../client.js";

export async function findProductBySkuOrBarcode(sku: string, barcode?: string | null) {
  const db = getDb();
  return db.product.findFirst({
    where: {
      OR: [{ sku }, ...(barcode ? [{ barcode }] : [])],
    },
    include: { variants: true },
  });
}

export async function findVariantBySkuOrBarcode(sku: string, barcode?: string | null) {
  const db = getDb();
  return db.productVariant.findFirst({
    where: {
      OR: [{ skuVariant: sku }, ...(barcode ? [{ barcodeVariant: barcode }] : [])],
    },
    include: { product: true },
  });
}

export async function listProductsWithSyncStatus() {
  const db = getDb();
  return db.product.findMany({
    include: {
      variants: { include: { inventoryItems: true } },
      channelMap: { include: { channel: true } },
    },
    orderBy: { name: "asc" },
  });
}

/**
 * Fase 2a: edición manual de SKU y/o precio de una variante ya existente
 * (no crea variantes nuevas). El SKU es `@unique` en el esquema — si choca
 * con otra variante, se relanza un mensaje claro en vez de la excepción
 * cruda de Prisma (que además no cruzaría bien el puente IPC).
 */
export async function updateVariantFields(
  variantId: string,
  fields: { skuVariant?: string; price?: number; color?: string | null; size?: string | null },
) {
  const db = getDb();
  try {
    return await db.productVariant.update({
      where: { id: variantId },
      data: {
        skuVariant: fields.skuVariant ?? undefined,
        price: fields.price ?? undefined,
        color: fields.color ?? undefined,
        size: fields.size ?? undefined,
      },
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      throw new Error(`Ya existe otra variante con el SKU "${fields.skuVariant}".`);
    }
    throw err;
  }
}

/** Fase 2a: variante + su mapeo por canal, para saber a dónde empujar un cambio. */
export async function getVariantWithChannelMap(variantId: string) {
  const db = getDb();
  return db.productVariant.findUnique({
    where: { id: variantId },
    include: {
      product: true,
      inventoryItems: true,
      channelMap: { include: { channel: true } },
    },
  });
}

/**
 * Corrige la marca central de un producto (sin tocar nada más). Usado por
 * la corrección masiva "Corregir marca por prefijo de SKU" (ver
 * `@blacksand/sync-engine`, `meli-brand-fix.ts`) — el importador de
 * Shopify (`importer.ts`) solo escribe `brand` al CREAR un producto nuevo,
 * nunca lo vuelve a tocar en una importación normal (rama `match_exacto`),
 * así que este fix no se pisa solo en la próxima importación.
 */
export async function updateProductBrand(productId: string, brand: string) {
  const db = getDb();
  return db.product.update({ where: { id: productId }, data: { brand } });
}

export type ProductDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: "has_history"; channels: string[]; orderCount: number };

/**
 * Elimina un producto del catálogo central del todo — a pedido del usuario,
 * para productos "fantasma" que quedaron en la base sin existir de verdad
 * en ningún canal (ej. una importación vieja ambigua, o un producto de
 * prueba). El esquema ya tiene `onDelete: Cascade` desde `Product` hacia
 * `ProductVariant`, `ChannelProductMap` y `ChannelSyncStatus` (y de ahí a
 * `InventoryItem`/`InventoryMovement`), así que un solo `delete` limpia
 * todo el rastro local. NUNCA toca Shopify ni Mercado Libre — si el
 * producto sigue publicado en algún canal, esa publicación queda intacta
 * ahí (y volvería a aparecer sola en la próxima importación).
 *
 * `force` (a pedido del usuario, ronda 2 de este feature): por defecto
 * (`force: false`) esta función NO borra si el producto tiene pedidos reales
 * en su historial (Shopify, Mercado Libre o venta presencial) — en vez de
 * lanzar una excepción cruda, devuelve `{ deleted: false, reason:
 * "has_history", channels, orderCount }` para que la UI pueda mostrar una
 * advertencia concreta (en qué plataforma(s) hay ventas y cuántos pedidos)
 * y dejar que el usuario decida. Si el usuario confirma, se vuelve a llamar
 * con `force: true`: antes de borrar, copia el SKU/nombre de cada línea de
 * pedido afectada a `OrderItem.skuSnapshot`/`productNameSnapshot` (el
 * esquema ya tiene esos campos + `variantId` nullable con `onDelete:
 * SetNull` desde la migración de esta ronda) para que el historial de
 * pedidos siga siendo legible aunque el producto ya no exista, y recién
 * ahí borra el producto.
 */
export async function deleteProduct(productId: string, force = false): Promise<ProductDeleteResult> {
  const db = getDb();

  const orderItems = await db.orderItem.findMany({
    where: { variant: { productId } },
    include: { order: { include: { channel: true } } },
  });

  if (orderItems.length > 0) {
    if (!force) {
      const channels = [...new Set(orderItems.map((oi) => oi.order.channel?.code ?? "venta_presencial"))];
      const orderCount = new Set(orderItems.map((oi) => oi.orderId)).size;
      return { deleted: false, reason: "has_history", channels, orderCount };
    }

    // force: true — snapshot antes de que el SetNull deje la línea "ciega".
    for (const item of orderItems) {
      const variant = await db.productVariant.findUnique({
        where: { id: item.variantId! },
        include: { product: true },
      });
      await db.orderItem.update({
        where: { id: item.id },
        data: {
          skuSnapshot: variant?.skuVariant ?? null,
          productNameSnapshot: variant?.product?.name ?? null,
        },
      });
    }
  }

  try {
    await db.product.delete({ where: { id: productId } });
    return { deleted: true };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "P2003") {
        // No debería pasar con `force: true` una vez corrida la migración
        // (variantId ya es nullable/SetNull) — si aparece, lo más probable
        // es que la migración de esta ronda todavía no se corrió.
        throw new Error(
          "No se pudo eliminar por una restricción de la base de datos. Si acabás de actualizar la app, " +
            "corré la migración pendiente (pnpm db:generate && pnpm --filter @blacksand/db migrate) y reiniciá.",
        );
      }
      if (code === "P2025") {
        throw new Error("Este producto ya no existe (puede que ya lo hayas eliminado).");
      }
    }
    throw err;
  }
}

export async function upsertCentralProduct(input: {
  sku: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  baseCost?: number | null;
  basePrice?: number | null;
}) {
  const db = getDb();
  return db.product.upsert({
    where: { sku: input.sku },
    update: {
      barcode: input.barcode ?? undefined,
      name: input.name,
      description: input.description ?? undefined,
      brand: input.brand ?? undefined,
      category: input.category ?? undefined,
      baseCost: input.baseCost ?? undefined,
      basePrice: input.basePrice ?? undefined,
    },
    create: {
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name,
      description: input.description ?? null,
      brand: input.brand ?? null,
      category: input.category ?? null,
      baseCost: input.baseCost ?? null,
      basePrice: input.basePrice ?? null,
      status: "borrador",
    },
  });
}
