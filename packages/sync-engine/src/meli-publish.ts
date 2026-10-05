import {
  listProductsWithSyncStatus,
  getVariantOnHandTotal,
  getChannelByCode,
  upsertChannelProductMap,
  upsertChannelSyncStatus,
  recordAudit,
  getGroupMapping,
  listGroupMappings,
  upsertGroupMapping,
  parseAttributeDefaults,
  listKeywordOverrides,
  upsertKeywordOverride,
  deleteKeywordOverride as deleteKeywordOverrideRow,
  listSkuPrefixBrandOverrides,
  upsertSkuPrefixBrandOverride,
  deleteSkuPrefixBrandOverride as deleteSkuPrefixBrandOverrideRow,
  findActiveChannelMapByVariant,
  type MeliAttributeDefaultInput,
} from "@blacksand/db";
import {
  resolveGroupAttributeNeeds,
  buildCreateItemPayload,
  convertShopifyDescriptionForMeli,
  findKeywordOverride,
  type MeliAttributeSpec,
  type PublishGroupMapping,
  type GroupAttributeNeeds,
} from "@blacksand/core-domain";
import type { PushChannelClients } from "./push.js";

/**
 * Fase 2b: publicar en Mercado Libre los productos que ya existen en
 * Shopify pero no en Mercado Libre — así el importador los empareja por
 * SKU en la próxima corrida y la pantalla Productos los muestra como una
 * sola fila. Ver `MeliCategoryGroupMapping` en el esquema para el porqué de
 * agrupar por `Product.category` en vez de resolver categoría/atributos
 * producto por producto.
 */

function computeGroupKey(category: string | null | undefined, sku: string): string {
  const trimmed = category?.trim();
  return trimmed ? trimmed : `sku:${sku}`;
}

/** Mercado Libre cobra más comisión que Shopify — el usuario pidió publicar siempre 25% más caro que el precio de Shopify (ver `computeMeliPrice`). */
const MELI_PRICE_MARKUP_PERCENT = 25;

interface CandidateProduct {
  productId: string;
  variantId: string;
  groupKey: string;
  name: string;
  brand: string | null;
  sku: string;
  price: number | null;
  barcodeVariant: string | null;
  /** Color de la variante (cargado por el importador desde la opción "Color" de Shopify) — null si el producto no tiene esa opción. */
  color: string | null;
  /** Talla de la variante (cargada por el importador desde la opción "Talla"/"Tamaño" de Shopify) — null si el producto no tiene esa opción (se publica como "Standard", ver `matchSizeAttributeValue`). */
  size: string | null;
  /** gid del producto PADRE en Shopify (channelProductId ya guardado en ChannelProductMap) — de ahí se piden las imágenes y la descripción. */
  channelShopifyProductId: string;
  /** gid de la VARIANTE en Shopify — de ahí se pide el peso real (`getVariantWeightGrams`), null si por algún motivo el importador no lo guardó. */
  channelShopifyVariantId: string | null;
}

/** Productos con mapeo a `shopify` y sin ningún mapeo a `mercadolibre` todavía — candidatos a publicar. */
async function loadCandidateProducts(): Promise<CandidateProduct[]> {
  const products = await listProductsWithSyncStatus();
  const candidates: CandidateProduct[] = [];

  for (const p of products) {
    for (const v of p.variants) {
      const variantMaps = p.channelMap.filter((m) => m.variantId === v.id);
      const shopifyMap = variantMaps.find((m) => m.channel.code === "shopify");
      // Antes, CUALQUIER fila de `mercadolibre` (sin importar su estado
      // real) sacaba al producto de la lista de candidatos para siempre —
      // así que un producto cuya publicación Mercado Libre había CERRADO
      // (ej. por datos incompletos al momento de publicar) quedaba
      // invisible en "Publicar en ML" aunque ya no tuviera ninguna
      // publicación viva. Ahora una fila `listingStatus === "closed"` NO
      // cuenta como "ya publicado" — el producto vuelve a aparecer como
      // candidato para crear una publicación NUEVA (Mercado Libre no deja
      // reactivar una publicación cerrada de forma confiable). Una fila
      // pausada, en revisión, o sin revisar todavía (`listingStatus` es
      // `null` porque nunca se corrió "Importar de Mercado Libre" con esta
      // versión) sigue contando como "ya publicado", para no arriesgar
      // crear un ítem duplicado sobre una publicación que en realidad
      // sigue viva — ver la pantalla "Estado en Mercado Libre" para
      // reactivar publicaciones pausadas en vez de recrearlas.
      const hasMeli = variantMaps.some((m) => m.channel.code === "mercadolibre" && m.listingStatus !== "closed");
      if (!shopifyMap || hasMeli) continue;

      candidates.push({
        productId: p.id,
        variantId: v.id,
        groupKey: computeGroupKey(p.category, p.sku),
        name: p.name,
        brand: p.brand,
        sku: v.skuVariant,
        price: v.price,
        barcodeVariant: v.barcodeVariant,
        color: v.color,
        size: v.size,
        channelShopifyProductId: shopifyMap.channelProductId,
        channelShopifyVariantId: shopifyMap.channelVariantId,
      });
    }
  }

  return candidates;
}

export interface PublishCandidateGroup {
  groupKey: string;
  sampleProductName: string;
  productCount: number;
  confirmed: boolean;
  categoryId: string | null;
  categoryName: string | null;
}

/** Lista para la pantalla "Publicar en ML": un grupo por cada `Product.category` con candidatos pendientes, marcando cuáles ya tienen categoría confirmada. */
export async function listPublishCandidateGroups(): Promise<PublishCandidateGroup[]> {
  const [candidates, mappings] = await Promise.all([loadCandidateProducts(), listGroupMappings()]);
  const mappingByKey = new Map(mappings.map((m) => [m.groupKey, m]));

  const groups = new Map<string, { count: number; sampleName: string }>();
  for (const c of candidates) {
    const existing = groups.get(c.groupKey);
    if (existing) existing.count += 1;
    else groups.set(c.groupKey, { count: 1, sampleName: c.name });
  }

  return Array.from(groups.entries())
    .map(([groupKey, info]) => {
      const mapping = mappingByKey.get(groupKey);
      return {
        groupKey,
        sampleProductName: info.sampleName,
        productCount: info.count,
        confirmed: Boolean(mapping),
        categoryId: mapping?.categoryId ?? null,
        categoryName: mapping?.categoryName ?? null,
      };
    })
    .sort((a, b) => b.productCount - a.productCount);
}

/** Cliente mínimo que necesita esta pantalla de Mercado Libre — mismo tipo que ya expone `@blacksand/connector-mercadolibre`, sin importarlo directo para no atar sync-engine a su forma exacta más de lo necesario. */
interface MeliPredictClient {
  predictCategory(siteId: string, query: string): Promise<{ categoryId: string; categoryName: string; domainId: string | null }[]>;
  getCategoryAttributes(categoryId: string): Promise<MeliAttributeSpec[]>;
  getCategoryPath(categoryId: string): Promise<string[]>;
}

export interface CategoryPreview {
  /**
   * Pedido real del usuario: categorías como "Cascos" se repiten en ramas
   * del árbol de Mercado Libre totalmente distintas (bicicleta,
   * construcción, trabajo...) — el nombre solo no alcanza para elegir bien.
   * `categoryPath` (cuando se pidió, ver `includeAllPaths` en
   * `previewCategoryForGroup`) trae el camino completo desde la raíz, ej.
   * `["Vehículos", "Accesorios para Vehículos", "Cascos y Protección", "Cascos"]`,
   * para que la pantalla lo muestre al lado del nombre.
   */
  predictions: { categoryId: string; categoryName: string; categoryPath?: string[] }[];
  attributes: MeliAttributeSpec[];
  groupNeeds: GroupAttributeNeeds;
  /**
   * De dónde salió `predictions[0]` (la categoría elegida):
   * `"keyword_override"` cuando calzó con una palabra clave que el usuario
   * guardó a mano (ver `findKeywordOverride` en `@blacksand/core-domain`) —
   * una categoría YA verificada por una persona, segura para confirmar sin
   * revisión — o `"ml_prediction"` cuando salió de la predicción de texto
   * de Mercado Libre, que puede estar equivocada (confirmado con una
   * "bandana táctica" real predicha en "Bastones"). "Publicar todo
   * automáticamente" usa esto para decidir si puede confirmar la categoría
   * sola o si el grupo necesita revisión manual.
   */
  categorySource: "keyword_override" | "ml_prediction";
}

const EMPTY_GROUP_NEEDS: GroupAttributeNeeds = {
  gtinFallback: null,
  needsGroupDefault: [],
  colorAttribute: null,
  sizeAttribute: null,
  requiresSizeGuide: false,
  sellerSkuAttributeId: null,
};

/**
 * Predicción de categoría + sus atributos para un grupo — el llamador (IPC)
 * decide qué mostrar en la pantalla de confirmación.
 *
 * `includeAllPaths` (default `false`): si se pide el camino completo
 * (`categoryPath`, ver el comentario grande en `CategoryPreview`) para TODAS
 * las alternativas, no solo la elegida — implica una llamada extra a
 * Mercado Libre por alternativa (hasta 5). La pantalla "Revisar categoría"
 * (un grupo a la vez, el usuario la está mirando) lo pide; la revisión
 * MASIVA (`previewAllPendingCategories`, que llama esto por cada grupo
 * pendiente, puede ser docenas) NO, para no multiplicar las llamadas — ahí
 * solo se trae el camino de la categoría elegida (una llamada extra por
 * grupo, mismo orden de magnitud que las llamadas que esta función ya hace
 * hoy).
 */
export async function previewCategoryForGroup(
  groupKey: string,
  meli: MeliPredictClient,
  customQuery?: string,
  options?: { includeAllPaths?: boolean },
): Promise<CategoryPreview> {
  const includeAllPaths = options?.includeAllPaths ?? false;
  const candidates = await loadCandidateProducts();
  const sample = candidates.find((c) => c.groupKey === groupKey);
  const query = customQuery?.trim() || sample?.name || groupKey;

  // Ver el comentario grande de `findKeywordOverride` (@blacksand/core-domain):
  // antes de preguntarle a Mercado Libre, se revisa si el usuario ya guardó
  // a mano la categoría real para este tipo de producto. Solo se salta esto
  // cuando el usuario pidió explícitamente "Buscar otra categoría"
  // (`customQuery` presente) — ahí sí quiere ver lo que predice Mercado
  // Libre para ese texto puntual, no la palabra clave guardada.
  if (!customQuery?.trim()) {
    const overrides = await listKeywordOverrides();
    const match = findKeywordOverride(overrides, query);
    if (match) {
      const attributes = await meli.getCategoryAttributes(match.categoryId);
      const groupNeeds = resolveGroupAttributeNeeds(attributes);
      const categoryPath = await meli.getCategoryPath(match.categoryId).catch(() => undefined);
      return {
        predictions: [{ categoryId: match.categoryId, categoryName: match.categoryName, categoryPath }],
        attributes,
        groupNeeds,
        categorySource: "keyword_override",
      };
    }
  }

  const predictions = await meli.predictCategory("MLC", query);
  if (predictions.length === 0) {
    return { predictions: [], attributes: [], groupNeeds: EMPTY_GROUP_NEEDS, categorySource: "ml_prediction" };
  }

  // Mercado Libre a veces predice primero una categoría de "Ropa" solo
  // porque el título tiene una palabra tipo "chaleco" — para una tienda de
  // equipamiento táctico/deportivo/airsoft (no de indumentaria) eso cae
  // justo en una categoría que exige guía de talles (`requiresSizeGuide`,
  // ver la nota en `resolveGroupAttributeNeeds`), que esta app no soporta.
  // En vez de forzar al usuario a buscar a mano cada vez, se recorren las
  // hasta 5 predicciones que ya trae `predictCategory` (ordenadas por
  // relevancia) y se usa la primera que NO exija guía de talles — casi
  // siempre hay una alternativa razonable ahí mismo (ej. "Accesorios para
  // Airsoft" al lado de "Chalecos"). Si TODAS la exigen, se usa la primera
  // igual (con el aviso de `requiresSizeGuide` ya existente en la
  // pantalla) — mejor avisar que dejar el grupo sin ninguna categoría.
  let chosenIndex = 0;
  let attributes = await meli.getCategoryAttributes(predictions[0]!.categoryId);
  let groupNeeds = resolveGroupAttributeNeeds(attributes);

  if (groupNeeds.requiresSizeGuide) {
    for (let i = 1; i < predictions.length; i++) {
      const candidateAttributes = await meli.getCategoryAttributes(predictions[i]!.categoryId);
      const candidateNeeds = resolveGroupAttributeNeeds(candidateAttributes);
      if (!candidateNeeds.requiresSizeGuide) {
        chosenIndex = i;
        attributes = candidateAttributes;
        groupNeeds = candidateNeeds;
        break;
      }
    }
  }

  // La categoría elegida queda primera en la lista (el resto sigue
  // disponible en el selector de la pantalla para cambiarla a mano) — así
  // ni la pantalla ni "Publicar todo automáticamente" (que toman
  // `predictions[0]`) necesitan saber nada de esta lógica.
  const orderedPredictions =
    chosenIndex === 0 ? predictions : [predictions[chosenIndex]!, ...predictions.filter((_, i) => i !== chosenIndex)];

  // Camino completo (ver `categoryPath`, `CategoryPreview`): siempre para la
  // elegida (una llamada extra), para todas si `includeAllPaths` — nunca
  // deja que un fallo puntual de esta llamada extra tire abajo el preview
  // entero (la categoría/atributos ya resueltos son lo importante).
  const predictionsWithPaths = await Promise.all(
    orderedPredictions.map(async (p, i) => {
      if (i > 0 && !includeAllPaths) return p;
      const categoryPath = await meli.getCategoryPath(p.categoryId).catch(() => undefined);
      return { ...p, categoryPath };
    }),
  );

  return { predictions: predictionsWithPaths, attributes, groupNeeds, categorySource: "ml_prediction" };
}

export interface BulkCategoryPreviewRow {
  groupKey: string;
  sampleProductName: string;
  productCount: number;
  preview: CategoryPreview;
  /**
   * Punto de partida sugerido para "Palabra clave a guardar" en la
   * revisión masiva — el texto del grupo (categoría de Shopify), o el
   * nombre del producto de ejemplo cuando el grupo es de un solo producto
   * sin categoría (`sku:<sku>`). Es solo un punto de partida editable, NO
   * una palabra clave "inteligente" extraída del nombre — inventar esa
   * heurística a ciegas (qué palabra del nombre es "el tipo de producto")
   * es más probable que ensucie la lista que ayudar; el usuario la ajusta
   * a mano en la pantalla antes de guardar, mismo criterio que el resto de
   * esta fase ("mejor date-blank explícito que un default adivinado mal").
   */
  suggestedKeyword: string;
}

/**
 * Trae la predicción de categoría para TODOS los grupos pendientes de una
 * vez (en vez de que el usuario abra "Revisar categoría" uno por uno) —
 * para la pantalla "Revisión masiva de categorías", que deja repasar y
 * corregir varias categorías en una sola pasada antes de confirmarlas.
 * Reusa `previewCategoryForGroup` por grupo (con lo cual ya se benefician
 * de la lista de palabras clave y del auto-evitar guía de talles) — esto
 * NO reemplaza la verificación humana, solo junta todas las predicciones
 * en una sola pantalla para que esa revisión sea más rápida.
 */
export async function previewAllPendingCategories(meli: MeliPredictClient): Promise<BulkCategoryPreviewRow[]> {
  const groups = await listPublishCandidateGroups();
  const pending = groups.filter((g) => !g.confirmed);

  const rows: BulkCategoryPreviewRow[] = [];
  for (const g of pending) {
    const preview = await previewCategoryForGroup(g.groupKey, meli);
    const suggestedKeyword = g.groupKey.startsWith("sku:") ? g.sampleProductName : g.groupKey;
    rows.push({ groupKey: g.groupKey, sampleProductName: g.sampleProductName, productCount: g.productCount, preview, suggestedKeyword });
  }
  return rows;
}

export interface MeliKeywordOverrideRow {
  id: string;
  keyword: string;
  categoryId: string;
  categoryName: string;
}

/** Lista de palabras clave -> categoría guardadas a mano, para la pantalla "Categorías por palabra clave". */
export async function listMeliKeywordOverrides(): Promise<MeliKeywordOverrideRow[]> {
  const rows = await listKeywordOverrides();
  return rows.map((r) => ({ id: r.id, keyword: r.keyword, categoryId: r.categoryId, categoryName: r.categoryName }));
}

/** Guarda (o reemplaza si la palabra clave ya existía) una categoría verificada a mano para un tipo de producto. */
export async function saveMeliKeywordOverride(input: {
  keyword: string;
  categoryId: string;
  categoryName: string;
}): Promise<void> {
  await upsertKeywordOverride(input);
  await recordAudit({
    action: "guardar_categoria_por_palabra_clave_meli",
    entityType: "meli_category_keyword_override",
    entityId: input.keyword,
    after: { categoryId: input.categoryId, categoryName: input.categoryName },
  });
}

export async function deleteMeliKeywordOverride(id: string): Promise<void> {
  await deleteKeywordOverrideRow(id);
}

export interface MeliSkuPrefixBrandOverrideRow {
  id: string;
  skuPrefix: string;
  brand: string;
}

/**
 * Reglas de "marca fija por prefijo de SKU" para publicaciones NUEVAS —
 * pantalla "Estado en ML", tarjeta "Marca automática por prefijo de SKU".
 * Distinto de "Corregir marca por prefijo de SKU" (`meli-brand-fix.ts`),
 * que corrige publicaciones que YA EXISTEN — esto es la regla que evita
 * que el problema vuelva a pasar con lo que se publique de ahora en
 * adelante (ver el comentario grande en `MeliSkuPrefixBrandOverride`,
 * esquema, y `matchSkuPrefixBrand` en @blacksand/core-domain).
 */
export async function listMeliSkuPrefixBrandOverrides(): Promise<MeliSkuPrefixBrandOverrideRow[]> {
  const rows = await listSkuPrefixBrandOverrides();
  return rows.map((r) => ({ id: r.id, skuPrefix: r.skuPrefix, brand: r.brand }));
}

export async function saveMeliSkuPrefixBrandOverride(input: { skuPrefix: string; brand: string }): Promise<void> {
  await upsertSkuPrefixBrandOverride(input);
  await recordAudit({
    action: "guardar_marca_por_prefijo_sku_meli",
    entityType: "meli_sku_prefix_brand_override",
    entityId: input.skuPrefix,
    after: { brand: input.brand },
  });
}

export async function deleteMeliSkuPrefixBrandOverride(id: string): Promise<void> {
  await deleteSkuPrefixBrandOverrideRow(id);
}

interface MeliSearchClient {
  predictCategory(siteId: string, query: string): Promise<{ categoryId: string; categoryName: string; domainId: string | null }[]>;
  getCategoryPath(categoryId: string): Promise<string[]>;
}

/**
 * Búsqueda de categorías de Mercado Libre por texto libre, SIN depender de
 * ningún grupo — la usa la pantalla "Categorías por palabra clave" para que
 * el usuario encuentre la categoría real antes de guardarla como palabra
 * clave (a diferencia de `previewCategoryForGroup`, acá el usuario SIEMPRE
 * revisa el resultado a mano antes de guardar nada, así que no hace falta
 * ningún filtro de guía de talles ni de palabra clave — es la herramienta
 * que alimenta esa lista, no la que la consume).
 *
 * Pedido real del usuario: Mercado Libre repite nombres de categoría
 * ("Cascos") en ramas totalmente distintas del árbol (bicicleta,
 * construcción, trabajo...), así que el nombre solo no alcanza para elegir
 * bien acá — se trae el camino completo (`categoryPath`, ver el comentario
 * grande en `CategoryPreview`) para cada uno de los hasta 5 resultados. Es
 * una búsqueda puntual que el usuario dispara a mano, así que las llamadas
 * extra (una por resultado) no pesan como pesarían en un listado masivo.
 */
export async function searchMeliCategories(
  meli: MeliSearchClient,
  query: string,
): Promise<{ categoryId: string; categoryName: string; categoryPath?: string[] }[]> {
  const results = await meli.predictCategory("MLC", query);
  return Promise.all(
    results.map(async (r) => {
      const categoryPath = await meli.getCategoryPath(r.categoryId).catch(() => undefined);
      return { categoryId: r.categoryId, categoryName: r.categoryName, categoryPath };
    }),
  );
}

export async function confirmGroupMapping(input: {
  groupKey: string;
  categoryId: string;
  categoryName: string;
  listingTypeId: string;
  attributeDefaults: MeliAttributeDefaultInput[];
  emptyGtinAttributeId?: string | null;
  emptyGtinValueId?: string | null;
  emptyGtinValueName?: string | null;
  /** Ver el comentario en `PublishGroupMapping` (@blacksand/core-domain) — productos ajustables de una sola talla (ej. chalecos tácticos) donde se quiere ignorar la talla de Shopify y publicar siempre "Standard". */
  forceStandardSize?: boolean;
  /** Ver el comentario en `PublishGroupMapping.defaultColorValueId` (@blacksand/core-domain) — color a usar cuando un producto del grupo no tiene color cargado en Shopify. */
  defaultColorValueId?: string | null;
  defaultColorValueName?: string | null;
}): Promise<void> {
  await upsertGroupMapping(input);
  await recordAudit({
    action: "confirmar_categoria_meli",
    entityType: "meli_category_group_mapping",
    entityId: input.groupKey,
    after: {
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      listingTypeId: input.listingTypeId,
      forceStandardSize: input.forceStandardSize ?? false,
      defaultColorValueName: input.defaultColorValueName ?? null,
    },
  });
}

export interface PublishBatchError {
  productName: string;
  sku: string;
  reason: string;
}

export interface PublishBatchResult {
  attempted: number;
  created: number;
  errors: PublishBatchError[];
  /**
   * La publicación en sí se crea igual aunque falle un paso "extra" no
   * crítico (hoy: copiar la descripción de Shopify) — se cuenta como
   * creada y el detalle queda acá, separado de `errors` (que sí implica
   * que el producto no quedó publicado).
   */
  warnings: PublishBatchError[];
}

/**
 * Publica hasta `limit` productos candidatos (de un grupo puntual, o de
 * todos los grupos ya confirmados si `groupKey === "all"`). Un producto que
 * falla (grupo sin confirmar, sin marca/imágenes, error real de la API)
 * queda en `errors` con el motivo — nunca corta el resto del lote. La
 * siguiente corrida omite automáticamente lo que ya se publicó, porque deja
 * de aparecer como candidato (`loadCandidateProducts` solo mira lo que
 * todavía no tiene mapeo a `mercadolibre`).
 */
export async function publishBatch(
  clients: PushChannelClients,
  groupKey: string | "all",
  limit: number,
  config: { defaultBrand: string | null },
  /**
   * "Crear producto" (subir un producto nuevo desde la app): cuando se pasa
   * esto, se publica SOLO el/los `variantId` indicados (típicamente uno
   * solo, el que se acaba de crear) aunque el grupo tenga otros candidatos
   * pendientes más viejos — sin esto, `groupKey` + `limit: 1` podría
   * terminar publicando un candidato distinto al que el usuario acaba de
   * crear (el orden de `loadCandidateProducts` no lo garantiza). `undefined`
   * = criterio de siempre ("Publicar en ML"), sin filtrar por variante.
   */
  onlyVariantIds?: Set<string>,
): Promise<PublishBatchResult> {
  if (!clients.mercadolibre) {
    throw new Error("Mercado Libre no está conectado (falta OAuth) — conéctalo en Configuración antes de publicar.");
  }
  if (!clients.shopify) {
    throw new Error("Shopify no está configurado — hace falta para traer las imágenes de cada producto.");
  }
  const meli = clients.mercadolibre;
  const shopify = clients.shopify;

  const channel = await getChannelByCode("mercadolibre");
  const allCandidates = await loadCandidateProducts();
  const candidates = (groupKey === "all" ? allCandidates : allCandidates.filter((c) => c.groupKey === groupKey))
    .filter((c) => !onlyVariantIds || onlyVariantIds.has(c.variantId))
    .slice(0, limit);

  const errors: PublishBatchError[] = [];
  const warnings: PublishBatchError[] = [];
  let created = 0;

  // Reglas de "marca fija por prefijo de SKU" (ver
  // `listMeliSkuPrefixBrandOverrides` más arriba) — se leen una sola vez
  // para todo el lote, igual que el resto de la config de publicación.
  const skuPrefixBrandOverrides = await listSkuPrefixBrandOverrides();

  // Los atributos COLOR y SIZE de una categoría (con sus listas de valores
  // permitidos) no se guardan en `MeliCategoryGroupMapping` — solo lo que el
  // usuario confirmó a mano — así que se piden de nuevo acá para poder
  // emparejar el color/talla de Shopify de cada producto contra las
  // opciones reales de Mercado Libre (`matchColorAttributeValue`,
  // `matchSizeAttributeValue`). Se cachean por grupo porque un lote suele
  // traer varios productos del mismo grupo/categoría.
  const attributeNeedsByGroup = new Map<string, GroupAttributeNeeds>();
  async function getAttributeNeedsForGroup(catGroupKey: string, categoryId: string): Promise<GroupAttributeNeeds> {
    const cached = attributeNeedsByGroup.get(catGroupKey);
    if (cached) return cached;
    const categoryAttributes = await meli.getCategoryAttributes(categoryId);
    const needs = resolveGroupAttributeNeeds(categoryAttributes);
    attributeNeedsByGroup.set(catGroupKey, needs);
    return needs;
  }

  for (const candidate of candidates) {
    // Caso real encontrado (septiembre 2026): ~20 productos quedaron
    // publicados DOS VECES en Mercado Libre — ver el comentario grande de
    // `findActiveChannelMapByVariant` (@blacksand/db). `candidates` ya viene
    // filtrado por `loadCandidateProducts` al INICIO de esta función, pero
    // ese filtro es de una sola vez: si otra llamada a `publishBatch` (un
    // doble clic, o más adelante el worker en la nube corriendo en
    // paralelo a la app) ya publicó esta misma variante MIENTRAS este lote
    // venía procesando los candidatos anteriores, hace falta revisarlo de
    // nuevo acá, justo antes de publicar, con el dato más fresco posible.
    const alreadyLive = await findActiveChannelMapByVariant(candidate.variantId, channel.id);
    if (alreadyLive) {
      warnings.push({
        productName: candidate.name,
        sku: candidate.sku,
        reason: `Ya existe una publicación activa en Mercado Libre para este producto (${alreadyLive.channelProductId}) — se omitió para no crear un duplicado. Si esto no parece correcto, revisa "Estado en Mercado Libre".`,
      });
      continue;
    }

    const mappingRow = await getGroupMapping(candidate.groupKey);
    if (!mappingRow) {
      errors.push({
        productName: candidate.name,
        sku: candidate.sku,
        reason: `El grupo "${candidate.groupKey}" todavía no tiene categoría confirmada — confírmala primero en "Publicar en ML".`,
      });
      continue;
    }

    const groupMapping: PublishGroupMapping = {
      categoryId: mappingRow.categoryId,
      listingTypeId: mappingRow.listingTypeId,
      attributeDefaults: parseAttributeDefaults(mappingRow.attributeDefaults),
      emptyGtinAttributeId: mappingRow.emptyGtinAttributeId,
      emptyGtinValueId: mappingRow.emptyGtinValueId,
      emptyGtinValueName: mappingRow.emptyGtinValueName,
      forceStandardSize: mappingRow.forceStandardSize,
      defaultColorValueId: mappingRow.defaultColorValueId,
      defaultColorValueName: mappingRow.defaultColorValueName,
    };

    try {
      const quantityOnHand = await getVariantOnHandTotal(candidate.variantId);
      const images = await shopify.getProductImages(candidate.channelShopifyProductId);
      const packageWeightGrams = candidate.channelShopifyVariantId
        ? await shopify.getVariantWeightGrams(candidate.channelShopifyVariantId)
        : null;
      const packageDimensions = await shopify.getPackageDimensionsCm(candidate.channelShopifyProductId);
      const { colorAttribute, sizeAttribute, sellerSkuAttributeId, requiresSizeGuide, needsGroupDefault } =
        await getAttributeNeedsForGroup(candidate.groupKey, groupMapping.categoryId);

      // Caso real encontrado ("CHALECO CON PLATAFORMA DE PECHO EMERSONGEAR
      // MULTICAM", categoría MLC158416): el grupo se había confirmado antes
      // de que `previewCategoryForGroup` empezara a evitar categorías con
      // guía de talles — Mercado Libre la sigue exigiendo igual al publicar
      // (`missing.fashion_grid.grid_id.values`), y esta app todavía no sabe
      // crear guías de talles (ver la nota grande de `requiresSizeGuide`,
      // @blacksand/core-domain). Se corta ACÁ con un motivo claro en vez de
      // dejar que la API lo rechace con un error críptico.
      if (requiresSizeGuide) {
        errors.push({
          productName: candidate.name,
          sku: candidate.sku,
          reason: `La categoría de este grupo (${groupMapping.categoryId}) exige una "guía de talles" (atributo SIZE_GRID_ID) que esta app todavía no sabe crear — vuelve a "Revisar categoría" para este grupo y elige otra categoría que no la exija.`,
        });
        continue;
      }

      // Caso real encontrado ("CHALECO PP 420 PLATE CARRIER MULTICAM
      // EMERSONGEAR EM7362", categoría MLC412075): el grupo se confirmó
      // antes de que esta categoría expusiera (o de que la app detectara)
      // el atributo GENDER como obligatorio, así que el `attributeDefaults`
      // guardado en su momento no lo incluye — Mercado Libre lo rechaza
      // igual al publicar (`item.attributes.missing_required`) porque la
      // categoría SÍ lo exige hoy. En vez de confiar ciegamente en la foto
      // vieja guardada en `MeliCategoryGroupMapping`, se recalculan los
      // atributos obligatorios de grupo EN VIVO (`needsGroupDefault`, ya
      // calculado arriba con los atributos actuales de la categoría) y se
      // compara contra lo guardado — cualquier obligatorio nuevo que falte
      // corta la publicación ACÁ, con un motivo claro que nombra el
      // atributo, en vez de la respuesta críptica de la API.
      const storedDefaultIds = new Set(groupMapping.attributeDefaults.map((a) => a.id));
      const missingRequiredDefaults = needsGroupDefault.filter((a) => a.required && !storedDefaultIds.has(a.id));
      if (missingRequiredDefaults.length > 0) {
        errors.push({
          productName: candidate.name,
          sku: candidate.sku,
          reason: `La categoría de este grupo ahora exige "${missingRequiredDefaults.map((a) => a.name).join(", ")}", que no estaba guardado cuando se confirmó este grupo — vuelve a "Revisar categoría" para este grupo y confírmalo de nuevo para completar este atributo.`,
        });
        continue;
      }

      const built = buildCreateItemPayload(
        {
          name: candidate.name,
          brand: candidate.brand,
          skuVariant: candidate.sku,
          price: candidate.price,
          barcodeVariant: candidate.barcodeVariant,
          quantityOnHand,
          packageWeightGrams,
          packageLengthCm: packageDimensions.lengthCm,
          packageWidthCm: packageDimensions.widthCm,
          packageHeightCm: packageDimensions.heightCm,
          color: candidate.color,
          size: candidate.size,
        },
        images,
        groupMapping,
        {
          defaultBrand: config.defaultBrand,
          currencyId: "CLP",
          priceMarkupPercent: MELI_PRICE_MARKUP_PERCENT,
          skuPrefixBrandOverrides,
        },
        colorAttribute,
        sizeAttribute,
        sellerSkuAttributeId,
      );

      if (!built.ok) {
        errors.push({ productName: candidate.name, sku: candidate.sku, reason: built.reason });
        continue;
      }

      const result = await meli.createItem(built.payload);

      // El `seller_custom_field` (SKU) que va dentro del `POST /items`
      // inicial (`built.payload.sellerCustomField`) no está quedando
      // guardado en esta cuenta cuando el ítem se crea con `family_name`
      // (modelo "User Products", ver el comentario en `createItem`) — se
      // confirmó probando contra la API real: el POST no da error, pero el
      // SKU queda vacío en la publicación. `updateItemStockAndSku` (un PUT
      // aparte) sí lo deja guardado de forma confiable para ítems ya
      // existentes (Fase 2a) — así que se fuerza acá también justo después
      // de crear, en vez de confiar en que el POST inicial lo haya guardado.
      //
      // Dos cosas más se agregaron después de que el usuario reportó que el
      // SKU seguía sin quedar guardado incluso con este PUT de respaldo:
      // 1. El modelo "User Products"/familias puede terminar creando el
      //    ítem con UNA variación interna aunque se publique como "simple"
      //    (sin `attribute_combinations` propias) — en ese caso el SKU va
      //    adentro de `variations[0]`, no en el campo del ítem, y un PUT al
      //    nivel del ítem no hace nada (ni error ni efecto). Se lee el ítem
      //    recién creado para detectar esto y apuntar el PUT al lugar
      //    correcto.
      // 2. Se vuelve a leer el ítem después del PUT para confirmar que el
      //    SKU realmente quedó guardado — si no, se avisa como advertencia
      //    explícita en vez de asumir que un PUT sin error significa éxito
      //    (que es justo el escenario silencioso que se reportó).
      try {
        const created = await meli.getItem(result.itemId);
        const targetVariationId = created.variations.length === 1 ? created.variations[0]!.channelVariantId : null;
        await meli.updateItemStockAndSku(result.itemId, targetVariationId, { sku: candidate.sku });

        const confirmed = await meli.getItem(result.itemId);
        const savedSku = targetVariationId
          ? confirmed.variations.find((v) => v.channelVariantId === targetVariationId)?.sku
          : confirmed.sku;
        if (savedSku !== candidate.sku) {
          warnings.push({
            productName: candidate.name,
            sku: candidate.sku,
            reason: `Se publicó, pero el SKU quedó como "${savedSku ?? "(vacío)"}" en Mercado Libre en vez de "${candidate.sku}" — revisa y corrige manualmente en Mercado Libre.`,
          });
        }

        // Ver el comentario de `sellerSkuAttributeId` en `GroupAttributeNeeds`
        // (@blacksand/core-domain): esta cuenta/categoría puede mostrar el
        // panel "Código de identificación (SKU)" del sitio a partir del
        // atributo `SELLER_SKU`, no del campo clásico de arriba — cuando la
        // categoría lo declara, `buildCreateItemPayload` ya lo mandó junto
        // con el resto de los atributos en el mismo `POST /items`, así que
        // acá solo se confirma (de solo lectura) que haya quedado guardado.
        if (sellerSkuAttributeId) {
          const savedSellerSku = confirmed.attributes.find((a) => a.id === sellerSkuAttributeId)?.valueName ?? null;
          if (savedSellerSku !== candidate.sku) {
            warnings.push({
              productName: candidate.name,
              sku: candidate.sku,
              reason: `Se publicó, pero el atributo SELLER_SKU quedó como "${savedSellerSku ?? "(vacío)"}" en vez de "${candidate.sku}" — es el campo que usa el panel "Código de identificación (SKU)" del sitio en esta categoría; revisa y corrige manualmente en Mercado Libre.`,
            });
          }
        }
      } catch (skuErr) {
        warnings.push({
          productName: candidate.name,
          sku: candidate.sku,
          reason: `Se publicó, pero no se pudo confirmar el SKU en Mercado Libre: ${
            skuErr instanceof Error ? skuErr.message : String(skuErr)
          } — revisa manualmente en Mercado Libre.`,
        });
      }

      // La descripción va en un endpoint aparte de Mercado Libre (ver
      // `setItemDescription`) — si esto falla, el ítem ya quedó creado y
      // publicado, así que no se cuenta como error del lote (rompería el
      // conteo de "creados"), pero sí se avisa como advertencia aparte.
      try {
        const descriptionHtml = await shopify.getProductDescriptionHtml(candidate.channelShopifyProductId);
        const description = descriptionHtml ? convertShopifyDescriptionForMeli(descriptionHtml) : "";
        if (description) {
          await meli.setItemDescription(result.itemId, description);
        } else if (descriptionHtml) {
          // Tenía HTML pero quedó vacío después de sacar tags/íconos/tablas
          // (p. ej. una descripción que era solo una imagen) — se avisa en
          // vez de quedar en silencio, para que no parezca "se olvidó".
          warnings.push({
            productName: candidate.name,
            sku: candidate.sku,
            reason:
              "Se publicó, pero la descripción de Shopify no tenía texto aprovechable (solo imágenes/formato) — se dejó sin descripción en Mercado Libre.",
          });
        }
      } catch (descErr) {
        warnings.push({
          productName: candidate.name,
          sku: candidate.sku,
          reason: `Se publicó, pero no se pudo copiar la descripción de Shopify: ${
            descErr instanceof Error ? descErr.message : String(descErr)
          }`,
        });
      }

      await upsertChannelProductMap({
        productId: candidate.productId,
        variantId: candidate.variantId,
        channelId: channel.id,
        channelProductId: result.itemId,
        channelVariantId: null,
        channelSku: candidate.sku,
        syncStatus: "sincronizado",
      });
      await upsertChannelSyncStatus({ productId: candidate.productId, channelId: channel.id, status: "sincronizado" });
      await recordAudit({
        action: "publicar_en_canal",
        entityType: "product",
        entityId: candidate.productId,
        after: {
          channel: "mercadolibre",
          itemId: result.itemId,
          sku: candidate.sku,
          categoryId: groupMapping.categoryId,
        },
      });
      created += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ productName: candidate.name, sku: candidate.sku, reason: message });
    }
  }

  return { attempted: candidates.length, created, errors, warnings };
}

export interface MeliDescriptionSyncResult {
  attempted: number;
  updated: number;
  /** Sin texto aprovechable en Shopify (vacío o solo imágenes/formato) — no se tocó la publicación. */
  skipped: number;
  /**
   * Nuevo (ronda 6 del bug SKU EM7405MC): la descripción de Mercado Libre
   * ya coincidía con la de Shopify, así que no se mandó ningún PUT/POST —
   * ver el comentario grande más abajo sobre por qué esto importa para el
   * volumen de escrituras automáticas hacia la API de Mercado Libre.
   */
  unchanged: number;
  errors: PublishBatchError[];
}

interface DescriptionSyncClients {
  shopify?: { getProductDescriptionHtml(productGid: string): Promise<string | null> };
  mercadolibre?: {
    setItemDescription(itemId: string, description: string): Promise<void>;
    getItemDescription(itemId: string): Promise<string>;
  };
}

/**
 * Copia la descripción actual de Shopify a la publicación de Mercado Libre
 * de CADA producto que ya está publicado en ambos canales — no solo los
 * recién creados por `publishBatch`. Existe aparte de ese flujo porque:
 * (a) las publicaciones creadas antes de que existiera el paso de
 * descripción se quedaron sin ella para siempre si nadie las vuelve a
 * tocar, y (b) si el usuario edita la descripción en Shopify más adelante,
 * nada más la vuelve a empujar — a diferencia de precio/stock, que sí se
 * empujan solos en cada edición o venta (ver `push.ts`), la descripción no
 * tiene un evento local que la dispare. Por eso `main/index.ts` corre esto
 * periódicamente (además del botón manual en "Publicar en ML"), así queda
 * sincronizada sin que el usuario tenga que hacer nada.
 *
 * **Cambio real (ronda 6 del bug SKU EM7405MC)**: antes de este cambio,
 * cada corrida (cada 30 minutos, TODO el catálogo publicado en ambos
 * canales, sin excepción) mandaba `PUT/POST /items/{id}/description` para
 * cada producto, SIN comparar si el texto había cambiado desde la corrida
 * anterior — la inmensa mayoría de las corridas terminaba reescribiendo
 * exactamente el mismo texto que ya estaba ahí. Investigando por qué el
 * usuario reportó un 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` nuevo
 * (algo que antes NO pasaba, ni siquiera con compras reales) se identificó
 * este bucle como el proceso automatizado más probable en generar el
 * volumen de escrituras repetidas hacia la API de Mercado Libre que un
 * sistema antiabuso podría marcar como sospechoso — ver el comentario
 * grande en `getItemDescription` (`@blacksand/connector-mercadolibre`).
 * Ahora se lee la descripción actual de Mercado Libre ANTES de escribir, y
 * si ya coincide con la de Shopify, no se manda ningún PUT/POST — cambia
 * un GET (barato, de lectura) por un PUT/POST (de escritura) en la
 * inmensa mayoría de las corridas, que es exactamente el tipo de llamada
 * que más le importa evitar a un sistema antiabuso.
 */
export async function syncMeliDescriptions(
  clients: DescriptionSyncClients,
  limit?: number,
): Promise<MeliDescriptionSyncResult> {
  if (!clients.shopify) throw new Error("Shopify no está configurado — hace falta para leer la descripción.");
  if (!clients.mercadolibre) throw new Error("Mercado Libre no está conectado (falta OAuth).");
  const shopify = clients.shopify;
  const meli = clients.mercadolibre;

  const products = await listProductsWithSyncStatus();
  const targets: { productName: string; sku: string; shopifyProductGid: string; meliItemId: string }[] = [];

  for (const p of products) {
    const shopifyMap = p.channelMap.find((m) => m.channel.code === "shopify");
    const meliMap = p.channelMap.find((m) => m.channel.code === "mercadolibre");
    // Solo tiene sentido cuando el producto ya está publicado en LOS DOS
    // canales — si todavía no existe en Mercado Libre, `publishBatch` es el
    // que lo crea (y ya copia la descripción al crearlo).
    if (!shopifyMap || !meliMap) continue;
    targets.push({
      productName: p.name,
      sku: p.sku,
      shopifyProductGid: shopifyMap.channelProductId,
      meliItemId: meliMap.channelProductId,
    });
  }

  const limited = typeof limit === "number" ? targets.slice(0, limit) : targets;
  const errors: PublishBatchError[] = [];
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const target of limited) {
    try {
      const descriptionHtml = await shopify.getProductDescriptionHtml(target.shopifyProductGid);
      const description = descriptionHtml ? convertShopifyDescriptionForMeli(descriptionHtml) : "";
      if (!description) {
        skipped += 1;
        continue;
      }
      // Ronda 6 (bug SKU EM7405MC): leer antes de escribir — ver el
      // comentario grande arriba y en `getItemDescription`. Si la lectura
      // en sí falla (cuenta/ítem con algún comportamiento no estándar), no
      // se bloquea el flujo — se sigue igual que antes de este cambio,
      // intentando la escritura directo.
      let current = "";
      try {
        current = await meli.getItemDescription(target.meliItemId);
      } catch {
        current = "";
      }
      if (current.trim() === description.trim()) {
        unchanged += 1;
        continue;
      }
      await meli.setItemDescription(target.meliItemId, description);
      updated += 1;
    } catch (err) {
      errors.push({
        productName: target.productName,
        sku: target.sku,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { attempted: limited.length, updated, skipped, unchanged, errors };
}
