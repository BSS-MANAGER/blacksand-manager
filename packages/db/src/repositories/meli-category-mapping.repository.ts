import { getDb } from "../client.js";

/**
 * Fase 2b: mapeo de categoría/atributos de Mercado Libre confirmado UNA VEZ
 * por grupo (`Product.category` central) desde la pantalla "Publicar en
 * ML" — `packages/sync-engine/src/meli-publish.ts` lo reusa para cada
 * producto del grupo al publicar en lote.
 */
export interface MeliAttributeDefaultInput {
  id: string;
  valueId?: string | null;
  valueName?: string | null;
}

export async function upsertGroupMapping(input: {
  groupKey: string;
  categoryId: string;
  categoryName: string;
  listingTypeId: string;
  attributeDefaults: MeliAttributeDefaultInput[];
  emptyGtinAttributeId?: string | null;
  emptyGtinValueId?: string | null;
  emptyGtinValueName?: string | null;
  /** Ver el comentario en el esquema (`MeliCategoryGroupMapping.forceStandardSize`) — productos ajustables de una sola talla (ej. chalecos tácticos) donde se quiere ignorar la talla que traiga Shopify y publicar siempre "Standard". `false` si se omite. */
  forceStandardSize?: boolean;
  /** Ver el comentario en el esquema (`MeliCategoryGroupMapping.defaultColorValueId`/`defaultColorValueName`) — color a usar cuando un producto del grupo no tiene color cargado en Shopify. `null`/omitido = sin default (un producto sin color en una categoría que exige COLOR queda como error del lote en vez de publicarse). */
  defaultColorValueId?: string | null;
  defaultColorValueName?: string | null;
}) {
  const db = getDb();
  const attributeDefaultsJson = JSON.stringify(input.attributeDefaults);
  return db.meliCategoryGroupMapping.upsert({
    where: { groupKey: input.groupKey },
    update: {
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      listingTypeId: input.listingTypeId,
      attributeDefaults: attributeDefaultsJson,
      emptyGtinAttributeId: input.emptyGtinAttributeId ?? null,
      emptyGtinValueId: input.emptyGtinValueId ?? null,
      emptyGtinValueName: input.emptyGtinValueName ?? null,
      forceStandardSize: input.forceStandardSize ?? false,
      defaultColorValueId: input.defaultColorValueId ?? null,
      defaultColorValueName: input.defaultColorValueName ?? null,
      confirmedAt: new Date(),
    },
    create: {
      groupKey: input.groupKey,
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      listingTypeId: input.listingTypeId,
      attributeDefaults: attributeDefaultsJson,
      emptyGtinAttributeId: input.emptyGtinAttributeId ?? null,
      emptyGtinValueId: input.emptyGtinValueId ?? null,
      emptyGtinValueName: input.emptyGtinValueName ?? null,
      forceStandardSize: input.forceStandardSize ?? false,
      defaultColorValueId: input.defaultColorValueId ?? null,
      defaultColorValueName: input.defaultColorValueName ?? null,
    },
  });
}

export async function getGroupMapping(groupKey: string) {
  const db = getDb();
  return db.meliCategoryGroupMapping.findUnique({ where: { groupKey } });
}

export async function listGroupMappings() {
  const db = getDb();
  return db.meliCategoryGroupMapping.findMany();
}

/** Deserializa `attributeDefaults` (guardado como JSON string en el esquema) — el llamador nunca debería parsear JSON crudo por su cuenta. */
export function parseAttributeDefaults(json: string): MeliAttributeDefaultInput[] {
  try {
    return JSON.parse(json) as MeliAttributeDefaultInput[];
  } catch {
    return [];
  }
}
