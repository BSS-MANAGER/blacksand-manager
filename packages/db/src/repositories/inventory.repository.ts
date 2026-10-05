import { getDb } from "../client.js";

/** Suma quantityOnHand de una variante a través de todas las bodegas (para comparar contra lo que reporta un canal). */
export async function getVariantOnHandTotal(variantId: string): Promise<number> {
  const db = getDb();
  const items = await db.inventoryItem.findMany({ where: { variantId }, select: { quantityOnHand: true } });
  return items.reduce((sum, i) => sum + i.quantityOnHand, 0);
}

/** Asegura que exista al menos una bodega/local por defecto (E.1: locations). */
export async function getOrCreateDefaultLocation() {
  const db = getDb();
  const existing = await db.location.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  return db.location.create({
    data: { name: "Local principal", isDefault: true },
  });
}

/**
 * Fase 3 (F.3/F.4): aplica un movimiento de inventario "por delta" con un
 * motivo explícito — a diferencia de `setVariantQuantityOnHand` (Fase 2a,
 * fija un valor absoluto para la edición manual), esta es la que usan las
 * ventas: un pedido de canal o una venta de mostrador restan una cantidad
 * conocida, nunca fijan el stock a un número arbitrario. `quantityDelta`
 * negativo para una venta, positivo para una devolución/reposición futura.
 */
export async function applyInventoryMovement(
  variantId: string,
  locationId: string,
  quantityDelta: number,
  meta: {
    type: string;
    referenceType?: string | null;
    referenceId?: string | null;
    userId?: string | null;
  },
) {
  const db = getDb();
  const inventoryItem = await db.inventoryItem.upsert({
    where: { variantId_locationId: { variantId, locationId } },
    update: { quantityOnHand: { increment: quantityDelta } },
    create: { variantId, locationId, quantityOnHand: Math.max(0, quantityDelta) },
  });

  await db.inventoryMovement.create({
    data: {
      inventoryItemId: inventoryItem.id,
      type: meta.type,
      quantityDelta,
      referenceType: meta.referenceType ?? null,
      referenceId: meta.referenceId ?? null,
      userId: meta.userId ?? null,
    },
  });

  return inventoryItem;
}

/**
 * Fase 2a: fija el stock de una variante en una bodega a un valor absoluto
 * (edición manual desde la pantalla Productos, no un delta de venta) y dexa
 * registro en InventoryMovement (E.1) para trazabilidad — mismo modelo que
 * usará más adelante el descuento automático por venta (Fase 3).
 */
export async function setVariantQuantityOnHand(
  variantId: string,
  locationId: string,
  quantity: number,
  options?: { userId?: string | null },
) {
  const db = getDb();
  const existing = await db.inventoryItem.findUnique({
    where: { variantId_locationId: { variantId, locationId } },
  });

  const inventoryItem = await db.inventoryItem.upsert({
    where: { variantId_locationId: { variantId, locationId } },
    update: { quantityOnHand: quantity },
    create: { variantId, locationId, quantityOnHand: quantity },
  });

  const delta = quantity - (existing?.quantityOnHand ?? 0);
  if (delta !== 0) {
    await db.inventoryMovement.create({
      data: {
        inventoryItemId: inventoryItem.id,
        type: "ajuste",
        quantityDelta: delta,
        referenceType: "edicion_manual",
        userId: options?.userId ?? null,
      },
    });
  }

  return inventoryItem;
}

export async function upsertVariantWithStock(input: {
  productId: string;
  skuVariant: string;
  barcodeVariant?: string | null;
  size?: string | null;
  color?: string | null;
  price?: number | null;
  quantityOnHand: number;
  locationId: string;
}) {
  const db = getDb();
  const variant = await db.productVariant.upsert({
    where: { skuVariant: input.skuVariant },
    update: {
      barcodeVariant: input.barcodeVariant ?? undefined,
      size: input.size ?? undefined,
      color: input.color ?? undefined,
      price: input.price ?? undefined,
    },
    create: {
      productId: input.productId,
      skuVariant: input.skuVariant,
      barcodeVariant: input.barcodeVariant ?? null,
      size: input.size ?? null,
      color: input.color ?? null,
      price: input.price ?? null,
    },
  });

  await db.inventoryItem.upsert({
    where: { variantId_locationId: { variantId: variant.id, locationId: input.locationId } },
    update: { quantityOnHand: input.quantityOnHand },
    create: {
      variantId: variant.id,
      locationId: input.locationId,
      quantityOnHand: input.quantityOnHand,
    },
  });

  return variant;
}
