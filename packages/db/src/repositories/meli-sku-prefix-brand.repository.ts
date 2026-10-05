import { getDb } from "../client.js";

/**
 * CRUD de `MeliSkuPrefixBrandOverride` — ver el comentario grande en el
 * esquema para el caso real que motivó esto (EmersonGear, SKU "EM...", sin
 * "Proveedor" cargado en Shopify). `matchSkuPrefixBrand`
 * (@blacksand/core-domain) es la que de verdad decide qué marca aplica al
 * publicar; este archivo solo guarda/lista/borra las reglas.
 */
export async function upsertSkuPrefixBrandOverride(input: { skuPrefix: string; brand: string }) {
  const db = getDb();
  const skuPrefix = input.skuPrefix.trim();
  const brand = input.brand.trim();
  return db.meliSkuPrefixBrandOverride.upsert({
    where: { skuPrefix },
    update: { brand },
    create: { skuPrefix, brand },
  });
}

export async function listSkuPrefixBrandOverrides() {
  const db = getDb();
  return db.meliSkuPrefixBrandOverride.findMany({ orderBy: { skuPrefix: "asc" } });
}

export async function deleteSkuPrefixBrandOverride(id: string) {
  const db = getDb();
  await db.meliSkuPrefixBrandOverride.delete({ where: { id } });
}
