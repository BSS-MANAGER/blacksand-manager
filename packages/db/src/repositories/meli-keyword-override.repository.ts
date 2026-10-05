import { getDb } from "../client.js";

/**
 * Fase 2b: lista de "palabra clave -> categoría real de Mercado Libre"
 * (`MeliCategoryKeywordOverride`) que el usuario arma a mano, una vez por
 * tipo de producto, para que "Publicar en ML" no dependa a ciegas de la
 * predicción de texto de Mercado Libre — ver el comentario grande de
 * `findKeywordOverride` en `@blacksand/core-domain` para el caso real que
 * motivó esto (una "bandana táctica" predicha en "Bastones").
 */
export async function upsertKeywordOverride(input: {
  keyword: string;
  categoryId: string;
  categoryName: string;
}) {
  const db = getDb();
  const keyword = input.keyword.trim();
  return db.meliCategoryKeywordOverride.upsert({
    where: { keyword },
    update: { categoryId: input.categoryId, categoryName: input.categoryName },
    create: { keyword, categoryId: input.categoryId, categoryName: input.categoryName },
  });
}

export async function listKeywordOverrides() {
  const db = getDb();
  return db.meliCategoryKeywordOverride.findMany({ orderBy: { keyword: "asc" } });
}

export async function deleteKeywordOverride(id: string) {
  const db = getDb();
  await db.meliCategoryKeywordOverride.delete({ where: { id } });
}
