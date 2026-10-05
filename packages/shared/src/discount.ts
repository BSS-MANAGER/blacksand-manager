/**
 * "Descuentos masivos" — lógica pura (sin red ni base de datos) para calcular
 * el nuevo precio de una variante. Vive en `@blacksand/shared` a propósito:
 * la usan DOS lados que tienen que dar EXACTAMENTE el mismo resultado — la
 * pantalla (para mostrar la vista previa mientras el usuario escribe el
 * porcentaje) y el motor de sincronización (`bulk-discount.ts`, que es quien
 * de verdad escribe en Shopify y recalcula todo desde cero con datos
 * frescos, nunca confía en los números que mandó la pantalla).
 *
 * Cómo funcionan los dos precios de Shopify (explicado por el usuario):
 * - "Precio" (`price`) es el precio real al que se vende el producto.
 * - "Precio de comparación" (`compareAtPrice`) es el precio ANTERIOR — la
 *   tienda lo muestra tachado. Un producto está "en oferta" cuando tiene un
 *   precio de comparación mayor que su precio.
 * Aplicar un descuento = el precio actual pasa a ser el precio de
 * comparación (tachado) y el precio nuevo es el precio actual menos el
 * porcentaje.
 */

/**
 * Cómo redondear el precio ya descontado (siempre HACIA ABAJO, para que el
 * descuento real nunca sea menor al que se pidió):
 * - `none`: al peso entero más cercano.
 * - `tens`: baja al múltiplo de $10 (ej. 15.992 → 15.990).
 * - `ending90`: baja al precio más cercano que termine en 90 (ej. 15.992 →
 *   15.990; 17.431 → 17.390) — el formato típico de precios en Chile.
 */
export type DiscountRounding = "none" | "tens" | "ending90";

/**
 * Qué hacer con un producto que YA está en oferta (ya tiene un precio de
 * comparación mayor que su precio):
 * - `skip`: no tocarlo.
 * - `from_price`: aplicar el descuento sobre el precio actual (que ya es
 *   rebajado); el precio de comparación pasa a ser ese precio actual.
 * - `from_compare`: aplicar el descuento sobre el precio de comparación
 *   original (el "precio normal" de antes) y dejar ese mismo precio de
 *   comparación — sirve para "re-rebajar" una oferta sin que el tachado
 *   se vaya degradando.
 */
export type DiscountOnSaleMode = "skip" | "from_price" | "from_compare";

/** Porcentaje máximo permitido — un tope de seguridad contra un typo (ej. 200 en vez de 20). */
export const MAX_DISCOUNT_PERCENT = 95;

export function computeDiscountedPrice(base: number, percent: number, rounding: DiscountRounding): number {
  // Se redondea a 2 decimales primero para eliminar el ruido de punto
  // flotante (19990 × 0,8 podría dar 15991.999999999998 y el `floor` de
  // abajo lo dejaría en 15.990 en vez de 15.992).
  const raw = Math.round(base * (100 - percent)) / 100;
  switch (rounding) {
    case "tens":
      return Math.floor(raw / 10) * 10;
    case "ending90":
      // Si el precio ya es menor a 90 no hay un "xx90" más abajo al que bajar.
      return raw < 90 ? Math.round(raw) : Math.floor((raw - 90) / 100) * 100 + 90;
    default:
      return Math.round(raw);
  }
}

export type VariantDiscountPlan =
  | { action: "apply"; newPrice: number; newCompareAtPrice: number }
  | { action: "skip"; reason: string };

export function validateDiscountPercent(percent: number): string | null {
  if (!Number.isFinite(percent) || percent <= 0) return "El porcentaje tiene que ser mayor que 0.";
  if (percent > MAX_DISCOUNT_PERCENT) return `El porcentaje no puede ser mayor que ${MAX_DISCOUNT_PERCENT}%.`;
  return null;
}

/** Decide qué pasa con UNA variante: el precio nuevo + el nuevo precio de comparación, o por qué se omite. */
export function planVariantDiscount(
  variant: { price: number | null; compareAtPrice: number | null },
  percent: number,
  rounding: DiscountRounding,
  onSaleMode: DiscountOnSaleMode,
): VariantDiscountPlan {
  const { price, compareAtPrice } = variant;
  if (price === null || price <= 0) return { action: "skip", reason: "no tiene precio" };

  const onSale = compareAtPrice !== null && compareAtPrice > price;
  if (onSale && onSaleMode === "skip") return { action: "skip", reason: "ya está en oferta" };

  const useCompareAsBase = onSale && onSaleMode === "from_compare";
  const base = useCompareAsBase ? compareAtPrice! : price;
  const newCompareAtPrice = base; // el "precio anterior" que se muestra tachado
  const newPrice = computeDiscountedPrice(base, percent, rounding);

  if (newPrice < 1) return { action: "skip", reason: "el precio nuevo quedaría en 0" };
  if (newPrice >= price) return { action: "skip", reason: "el precio redondeado no baja del actual" };
  return { action: "apply", newPrice, newCompareAtPrice };
}

// ---------------------------------------------------------------------------
// Aumentos de precio y "restaurar precio normal"
// ---------------------------------------------------------------------------

/**
 * Las tres acciones de la pantalla "Descuentos":
 * - `discount`: baja el precio; el precio actual pasa a ser el "precio de
 *   comparación" (tachado). Es lo de `planVariantDiscount`, arriba.
 * - `increase`: SUBE el precio. Se calcula siempre sobre el PRECIO NORMAL
 *   guardado (no sobre el precio de ahora), así aplicarlo dos veces seguidas
 *   deja el mismo resultado en vez de subir el precio dos veces. Deja el
 *   precio de comparación vacío. Ej.: precio normal 100, +10% → precio 110.
 *   Después se puede aplicar un descuento sobre ese 110 (el 110 pasa a ser el
 *   tachado), y "restaurar" vuelve al 100.
 * - `restore`: vuelve al precio normal guardado y quita el tachado.
 */
export type PriceChangeMode = "discount" | "increase" | "restore";

/** Porcentaje máximo de un aumento — tope de seguridad contra un typo (ej. 500 en vez de 5). */
export const MAX_INCREASE_PERCENT = 200;

/**
 * Precio con aumento. A diferencia del descuento (que redondea hacia abajo),
 * un aumento redondea hacia ARRIBA: así "terminar en 90" da 21.990 (y no
 * 21.890) para un precio de 21.989.
 */
export function computeIncreasedPrice(base: number, percent: number, rounding: DiscountRounding): number {
  const raw = Math.round(base * (100 + percent)) / 100;
  switch (rounding) {
    case "tens":
      return Math.ceil(raw / 10) * 10;
    case "ending90":
      return raw <= 90 ? Math.round(raw) : Math.ceil((raw - 90) / 100) * 100 + 90;
    default:
      return Math.round(raw);
  }
}

export function validateIncreasePercent(percent: number): string | null {
  if (!Number.isFinite(percent) || percent <= 0) return "El porcentaje tiene que ser mayor que 0.";
  if (percent > MAX_INCREASE_PERCENT) return `El porcentaje de aumento no puede ser mayor que ${MAX_INCREASE_PERCENT}%.`;
  return null;
}

/** Valida el porcentaje según la acción — `restore` no usa porcentaje. */
export function validatePriceChange(mode: PriceChangeMode, percent: number): string | null {
  if (mode === "restore") return null;
  return mode === "increase" ? validateIncreasePercent(percent) : validateDiscountPercent(percent);
}

export type VariantChangePlan =
  | { action: "apply"; newPrice: number; newCompareAtPrice: number | null }
  | { action: "skip"; reason: string };

const sameAmount = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.01;

/**
 * Decide qué pasa con UNA variante para cualquiera de las tres acciones.
 * `baselinePrice` es el precio normal guardado (ver `bulk-discount.ts`).
 */
export function planVariantChange(
  variant: { price: number | null; compareAtPrice: number | null; baselinePrice: number | null },
  change: { mode: PriceChangeMode; percent: number; rounding: DiscountRounding; onSaleMode: DiscountOnSaleMode },
): VariantChangePlan {
  const { price, compareAtPrice, baselinePrice } = variant;

  if (change.mode === "discount") {
    return planVariantDiscount({ price, compareAtPrice }, change.percent, change.rounding, change.onSaleMode);
  }

  if (price === null || price <= 0) return { action: "skip", reason: "no tiene precio" };
  if (baselinePrice === null || baselinePrice <= 0) return { action: "skip", reason: "no tiene precio normal guardado" };

  if (change.mode === "restore") {
    if (sameAmount(price, baselinePrice) && compareAtPrice === null) {
      return { action: "skip", reason: "ya está en su precio normal" };
    }
    return { action: "apply", newPrice: baselinePrice, newCompareAtPrice: null };
  }

  // increase
  const newPrice = computeIncreasedPrice(baselinePrice, change.percent, change.rounding);
  if (sameAmount(newPrice, price) && compareAtPrice === null) {
    return { action: "skip", reason: "ya tiene ese precio" };
  }
  return { action: "apply", newPrice, newCompareAtPrice: null };
}
