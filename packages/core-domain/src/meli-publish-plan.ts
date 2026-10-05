/**
 * Fase 2b: reglas puras para publicar un producto del catálogo central como
 * una publicación nueva de Mercado Libre. Vive en core-domain (sin depender
 * de ningún conector, mismo criterio que `matching.ts`) para poder probarse
 * sola — quien la usa (`packages/sync-engine/src/meli-publish.ts`) le pasa
 * los datos ya resueltos (atributos de la categoría, imágenes, etc.).
 *
 * Estas formas espejan (duck-typed, sin importar el paquete del conector)
 * las de `@blacksand/connector-mercadolibre` — `buildCreateItemPayload`
 * devuelve algo estructuralmente compatible con `MeliCreateItemInput`.
 */

export interface MeliAttributeValue {
  id: string;
  name: string;
}

export interface MeliAttributeSpec {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  values: MeliAttributeValue[];
}

export interface GroupAttributeNeeds {
  /**
   * El atributo "hermano" de GTIN que declara "este producto no tiene
   * GTIN" para esta categoría puntual — se detecta por heurística sobre
   * id/nombre (Mercado Libre no usa un único id global para esto en todas
   * las categorías). `null` si la categoría no exige GTIN o no tiene ese
   * mecanismo.
   */
  gtinFallback: { attributeId: string; values: MeliAttributeValue[] } | null;
  /**
   * Atributos requeridos con lista fija de valores que no se pueden
   * inferir por producto (no son BRAND ni GTIN) — el usuario elige UN
   * valor para todo el grupo en la pantalla "Publicar en ML".
   */
  needsGroupDefault: MeliAttributeSpec[];
  /**
   * El atributo de color de esta categoría, si existe — a diferencia del
   * resto de `needsGroupDefault`, el usuario pidió que esto NO se elija una
   * vez por grupo (dos productos del mismo grupo/categoría pueden tener
   * colores distintos), sino que se resuelva por producto a partir del
   * color que ya tiene cargado en Shopify (`ProductVariant.color`, ver
   * `matchColorAttributeValue`). `null` si la categoría no expone ningún
   * atributo de color.
   */
  colorAttribute: MeliAttributeSpec | null;
  /**
   * El atributo de talla de esta categoría, si existe (id "SIZE" o nombre
   * "Talla"/"Tamaño" — NO se confunde con "SIZE_GRID_ID"/"SIZE_GRID_ROW_ID",
   * el mecanismo aparte de "guía de talles" que algunas categorías de moda
   * exigen y que esta app todavía no soporta, ver la nota en
   * `resolveGroupAttributeNeeds`). Igual que `colorAttribute`, se resuelve
   * por producto (`matchSizeAttributeValue`) en vez de una vez por grupo: el
   * usuario pidió que salga "Standard" cuando el producto no tiene talla
   * cargada en Shopify, y la talla real de Shopify cuando sí la tiene.
   * `null` si la categoría no expone ningún atributo de talla simple.
   */
  sizeAttribute: MeliAttributeSpec | null;
  /**
   * `true` cuando la categoría exige una "guía de talles" (atributo
   * `SIZE_GRID_ID`, ver la nota grande más abajo en `resolveGroupAttributeNeeds`)
   * — Mercado Libre la exige aunque no aparezca marcada `required` en
   * `/categories/{id}/attributes` (así se confirmó con un chaleco táctico
   * real: `missing.fashion_grid.grid_id.values`), así que se detecta por la
   * sola presencia del atributo, no por su flag. Esta app todavía no sabe
   * crear guías de talles (recurso aparte de Mercado Libre, con esquema
   * distinto por rubro) — cuando esto sale `true`, la pantalla avisa para
   * que el usuario busque otra categoría (el usuario prefirió recategorizar
   * en vez de esperar a que se automatice esto).
   */
  requiresSizeGuide: boolean;
  /**
   * Id del atributo `SELLER_SKU`, si esta categoría lo declara — un
   * hallazgo real al investigar por qué el SKU quedaba vacío en el sitio
   * de Mercado Libre (panel "Código de identificación (SKU)") pese a que
   * `seller_custom_field` sí quedaba guardado por API: Mercado Libre tiene
   * DOS campos de SKU distintos y con búsqueda separada
   * (`?sku=` busca por `seller_custom_field`, `?seller_sku=` busca por el
   * atributo `SELLER_SKU`) — algunas categorías/cuentas (esta, con el
   * modelo "User Products"/familias) muestran ese panel a partir del
   * atributo, no del campo clásico. Cuando esto no es `null`,
   * `buildCreateItemPayload` manda el SKU TAMBIÉN como este atributo en el
   * mismo `POST /items` (no hace falta un PUT aparte: al ir en el mismo
   * body de creación no arriesga pisar otros atributos, a diferencia de un
   * PUT de `attributes` después, que no se probó si reemplaza el arreglo
   * completo — mismo riesgo ya confirmado con `tags`). `null` si la
   * categoría no expone este atributo (se manda igual `seller_custom_field`
   * como hasta ahora).
   */
  sellerSkuAttributeId: string | null;
}

const COLOR_ID_PATTERN = /^color$/i;
const COLOR_NAME_PATTERN = /^colou?r(es)?$/i;
const SIZE_ID_PATTERN = /^size$/i;
/**
 * Sin anclar (`^...$`) a propósito — se cambió después de un caso real:
 * la categoría "Chalecos" (MLC412075) expone el atributo de talla con el
 * nombre "Tamaño del chaleco táctico", no solo "Talla"/"Tamaño" a secas, y
 * el patrón anterior (anclado) no lo detectaba — la categoría quedaba sin
 * la casilla "Talla: usar siempre Standard" ni el emparejamiento
 * automático por producto, y el atributo cayó en el balde genérico de
 * `needsGroupDefault` en su lugar. Ahora matchea "talla"/"tamaño" como
 * palabra completa en cualquier parte del nombre (con límites de palabra,
 * `\b`, para no matchear a mitad de otra palabra como "detalla").
 */
const SIZE_NAME_PATTERN = /\btallas?\b|\btama[ñn]os?\b/i;
const SIZE_GRID_ID_PATTERN = /^size_grid_id$/i;
const SELLER_SKU_ID_PATTERN = /^seller_sku$/i;
const GENDER_NAME_PATTERN = /^g[eé]nero$/i;
const NO_GENDER_VALUE_NAME_PATTERN = /sin\s*g[eé]nero/i;
const MATERIAL_PRINCIPAL_NAME_PATTERN = /material\s*principal/i;
const STANDARD_VALUE_NAME_PATTERN = /^est[aá]ndar$|^standard$/i;
const POLYESTER_VALUE_NAME_PATTERN = /poli[eé]ster/i;

const GTIN_FALLBACK_ID_PATTERN = /EMPTY_?GTIN|GTIN_ABSENCE|SIN_GTIN|NO_GTIN/i;
const GTIN_FALLBACK_NAME_PATTERN = /sin\s*gtin|no\s*tiene\s*gtin|sin\s*c[oó]digo\s*de\s*barras|motivo.*gtin/i;

/**
 * Las dimensiones de paquete que exige el departamento "pymes" de Mercado
 * Libre (`item.attribute.missing.seller.package.dimensions`) NO aparecen en
 * `GET /categories/{id}/attributes` — es una validación de logística aparte
 * (probablemente ligada al programa de envíos de la cuenta), así que no hay
 * forma de detectarla leyendo los atributos reales de la categoría. Se
 * agregan siempre como si fueran requeridas por grupo — mandarlas de más en
 * una categoría que no las pida no debería romper nada (son atributos
 * genéricos de Mercado Envíos, no del esquema puntual de la categoría), y
 * si alguna vez no hace falta, se ajusta acá.
 */
/**
 * `required: false` a propósito: para la GRAN mayoría de los productos el
 * valor real ya sale solo de Shopify por producto (peso nativo de la
 * variante; largo/ancho/alto por metacampo, ver `getPackageDimensionsCm`
 * del conector) — obligar a completar esto en la pantalla de grupo
 * significaría escribir de nuevo un dato que el usuario ya cargó una vez
 * en Shopify. Queda disponible para completar a mano SOLO como respaldo,
 * por si algún producto puntual no tuviera el dato en Shopify, pero no
 * bloquea "Confirmar mapeo" si se deja vacío.
 */
const PACKAGE_DIMENSION_ATTRIBUTES: MeliAttributeSpec[] = [
  {
    id: "seller_package_height",
    name: "Alto del paquete (cm) — opcional, se completa solo con el metacampo de Shopify de cada producto",
    valueType: "number_unit",
    required: false,
    values: [],
  },
  {
    id: "seller_package_width",
    name: "Ancho del paquete (cm) — opcional, se completa solo con el metacampo de Shopify de cada producto",
    valueType: "number_unit",
    required: false,
    values: [],
  },
  {
    id: "seller_package_length",
    name: "Largo del paquete (cm) — opcional, se completa solo con el metacampo de Shopify de cada producto",
    valueType: "number_unit",
    required: false,
    values: [],
  },
  {
    id: "seller_package_weight",
    name: "Peso del paquete (g) — opcional, se completa solo con el peso de Shopify de cada producto",
    valueType: "number_unit",
    required: false,
    values: [],
  },
];

/** id -> unidad que Mercado Libre espera pegada al número (p. ej. "20 cm") en estos atributos de logística. */
const PACKAGE_DIMENSION_UNITS: Record<string, string> = {
  seller_package_height: "cm",
  seller_package_width: "cm",
  seller_package_length: "cm",
  seller_package_weight: "g",
};

/** Si el usuario ya escribió una unidad (cualquier letra), se respeta tal cual; si solo puso el número, se le pega la unidad esperada. */
function withPackageUnit(id: string, valueName: string | null | undefined): string | null | undefined {
  if (!valueName) return valueName;
  const unit = PACKAGE_DIMENSION_UNITS[id];
  if (!unit) return valueName;
  const trimmed = valueName.trim();
  return /[a-zA-Z]/.test(trimmed) ? trimmed : `${trimmed} ${unit}`;
}

/**
 * Separa los atributos requeridos de una categoría en lo que se puede
 * resolver por producto (marca, GTIN) y lo que necesita una decisión única
 * por grupo. No asume nada fijo por categoría — todo sale de la lista real
 * de atributos que devuelve `getCategoryAttributes`.
 *
 * Al principio esto solo juntaba los requeridos de tipo `list` (con
 * opciones fijas) — probando contra la API real aparecieron requeridos que
 * NO son de tipo lista (p. ej. "Modelo", texto libre; o las dimensiones de
 * paquete `seller_package_height/width/length/weight`, numéricas) y quedaban
 * completamente afuera de la pantalla de confirmación, así que Mercado
 * Libre los rechazaba recién al momento de publicar. Ahora se juntan TODOS
 * los requeridos (salvo marca/GTIN, que ya se resuelven por producto) sin
 * importar el tipo — la pantalla decide el control (selector si trae
 * `values`, campo de texto si no) usando el mismo `attributeDefaults`
 * genérico (`valueId` o `valueName`) para los dos casos.
 */
export function resolveGroupAttributeNeeds(attributes: MeliAttributeSpec[]): GroupAttributeNeeds {
  const required = attributes.filter((a) => a.required);
  const gtinRequired = required.some((a) => a.id === "GTIN");

  let gtinFallback: GroupAttributeNeeds["gtinFallback"] = null;
  if (gtinRequired) {
    const sibling = attributes.find(
      (a) => a.id !== "GTIN" && (GTIN_FALLBACK_ID_PATTERN.test(a.id) || GTIN_FALLBACK_NAME_PATTERN.test(a.name)),
    );
    if (sibling) {
      gtinFallback = { attributeId: sibling.id, values: sibling.values };
    }
  }

  const colorAttribute =
    attributes.find((a) => COLOR_ID_PATTERN.test(a.id) || COLOR_NAME_PATTERN.test(a.name)) ?? null;

  // No confundir con "SIZE_GRID_ID"/"SIZE_GRID_ROW_ID" (ver la nota grande
  // más abajo) — se excluye explícitamente cualquier atributo cuyo id ya
  // matchee `SIZE_GRID_ID_PATTERN`, así que aunque su nombre real también
  // contenga "talla"/"tamaño" (ej. "Tamaño según guía de talles"), nunca
  // se confunde con el atributo de talla simple.
  const sizeAttribute =
    attributes.find(
      (a) => !SIZE_GRID_ID_PATTERN.test(a.id) && (SIZE_ID_PATTERN.test(a.id) || SIZE_NAME_PATTERN.test(a.name)),
    ) ?? null;

  const needsGroupDefault = required.filter(
    (a) =>
      a.id !== "BRAND" &&
      a.id !== "GTIN" &&
      a.id !== gtinFallback?.attributeId &&
      a.id !== colorAttribute?.id &&
      a.id !== sizeAttribute?.id,
  );

  // Se agregan al final, salvo que la categoría ya las haya traído ella misma.
  const alreadyPresent = new Set(needsGroupDefault.map((a) => a.id));
  for (const packageAttr of PACKAGE_DIMENSION_ATTRIBUTES) {
    if (!alreadyPresent.has(packageAttr.id)) needsGroupDefault.push(packageAttr);
  }

  // El usuario pidió que "Género" salga siempre en "Sin género" y "Material
  // principal" en "Standard"/"Poliéster" para TODOS los productos — sin
  // importar si Mercado Libre marca el atributo como requerido en esta
  // categoría puntual (a diferencia del resto de `needsGroupDefault`, que
  // solo junta los `required`). Se agregan igual si la categoría los
  // expone (detectado por NOMBRE, mismo criterio que color/talla — no hay
  // un id fijo global para "Género"/"Material principal"), porque
  // `defaultAttributeAnswers` en la pantalla ya sabe rellenarlos solos; si
  // la categoría no los trae, no se agrega nada (no existen para mandar).
  for (const attr of attributes) {
    if (attr.id === colorAttribute?.id || attr.id === sizeAttribute?.id) continue;
    if (needsGroupDefault.some((a) => a.id === attr.id)) continue;
    if (GENDER_NAME_PATTERN.test(attr.name) || MATERIAL_PRINCIPAL_NAME_PATTERN.test(attr.name)) {
      needsGroupDefault.push(attr);
    }
  }

  // "Precios mayoristas" NO se resuelve acá: se confirmó (investigando
  // directo contra el sitio de Mercado Libre, capturando el tráfico de red
  // real) que no es un atributo de categoría — es una función interna del
  // panel de vendedores (`vendedores.mercadolibre.cl`) sin ningún campo o
  // endpoint expuesto por la API pública. Queda como paso manual del
  // usuario después de publicar cada producto (activar la casilla en el
  // sitio de Mercado Libre dejando los precios que Mercado Libre recomienda
  // por defecto).
  //
  // "SIZE_GRID_ID"/"SIZE_GRID_ROW_ID" (guía de talles) TAMPOCO se resuelve
  // como un atributo más acá: algunas categorías de moda (confirmado con un
  // chaleco táctico real, error `missing.fashion_grid.grid_id.values`)
  // exigen que el ítem quede asociado a una "guía de talles" — un recurso
  // APARTE que hay que crear antes con `POST /catalog/charts` (nombre,
  // dominio, atributos y filas específicas del dominio) y después
  // referenciar por id + fila en el ítem — no es simplemente elegir un
  // valor de una lista fija como el resto de los atributos de esta función.
  // Como el esquema exacto de esa guía varía por dominio (calzado pide
  // medidas de pie, ropa pediría otra cosa) y crearla mal escribiría basura
  // en la cuenta real de Mercado Libre, se dejó pendiente de diseño en vez
  // de adivinar — el usuario prefirió, mientras tanto, recategorizar a mano
  // los productos que caen acá (p. ej. equipamiento táctico bajo una
  // categoría de "Accesorios" en vez de "Ropa") en vez de esperar a que se
  // automatice. `requiresSizeGuide` se calcula por la sola PRESENCIA del
  // atributo `SIZE_GRID_ID` en la categoría (no por su flag `required`,
  // que en el caso real que falló venía en `false` y Mercado Libre lo
  // exigió igual) para que la pantalla lo avise ANTES de publicar, no
  // recién cuando la API lo rechaza.
  const requiresSizeGuide = attributes.some((a) => SIZE_GRID_ID_PATTERN.test(a.id));

  const sellerSkuAttributeId = attributes.find((a) => SELLER_SKU_ID_PATTERN.test(a.id))?.id ?? null;

  return {
    gtinFallback,
    needsGroupDefault,
    colorAttribute,
    sizeAttribute,
    requiresSizeGuide,
    sellerSkuAttributeId,
  };
}

/** Minúsculas y sin tildes — para comparar "Café" con "cafe" o "COFFEE"/"Coyote" sin depender de que Shopify y Mercado Libre escriban el color exactamente igual. */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Categoría de Mercado Libre que el usuario guardó a mano para un tipo de
 * producto puntual (ej. "bandana" -> tal categoría) — ver la nota grande en
 * `findKeywordOverride` más abajo sobre por qué existe esto.
 */
export interface MeliKeywordOverride {
  keyword: string;
  categoryId: string;
  categoryName: string;
}

/**
 * La predicción automática de categoría de Mercado Libre (`domain_discovery/
 * search`) puede fallar de forma sorprendente para un catálogo de nicho: se
 * confirmó con una "bandana táctica multicam" real que Mercado Libre la
 * predijo en "Artículos deportivos > Bastones" (bastones para caminar) — un
 * error de clasificación de texto, no algo que se pueda arreglar ajustando
 * el texto de búsqueda de forma confiable. Publicar con una categoría así
 * de equivocada hace que Mercado Libre termine pausando la publicación.
 *
 * En vez de seguir confiando ciegamente en la predicción de Mercado Libre
 * para "Publicar todo automáticamente", el usuario guarda, una vez por tipo
 * de producto, la categoría real correcta (buscada y verificada a mano) en
 * una lista de "palabra clave -> categoría" (`MeliCategoryKeywordOverride`
 * en el esquema). Antes de preguntarle a Mercado Libre, `previewCategoryForGroup`
 * revisa esta lista: si el texto de búsqueda (nombre del producto de
 * ejemplo, o el grupo) CONTIENE alguna palabra clave guardada, se usa esa
 * categoría directo, sin arriesgarse a una predicción de texto equivocada.
 *
 * Si hay más de una palabra clave que calza (ej. "bandana" y "bandana
 * multicam" ambas guardadas), se prefiere la más larga/específica — se
 * asume que el usuario la guardó a propósito para distinguir un caso más
 * puntual de uno más genérico.
 */
export function findKeywordOverride(
  overrides: MeliKeywordOverride[],
  text: string,
): MeliKeywordOverride | null {
  const normalizedText = normalizeForMatch(text);
  if (!normalizedText) return null;

  const matches = overrides.filter((o) => {
    const normalizedKeyword = normalizeForMatch(o.keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  });
  if (matches.length === 0) return null;

  return matches.reduce((best, current) => (current.keyword.length > best.keyword.length ? current : best));
}

/**
 * El usuario pidió que el color de cada publicación salga igual al que ya
 * tiene cargado en Shopify (`ProductVariant.color`, ver la nota en
 * `PublishProductInput`). El atributo COLOR de Mercado Libre casi siempre
 * tiene una lista fija de valores por categoría — se busca primero una
 * coincidencia exacta (sin tildes/mayúsculas) y después una donde uno
 * contenga al otro (p. ej. Shopify "Coyote Brown" vs. la opción de Mercado
 * Libre "Coyote"). Si no hay ninguna coincidencia, se manda igual como
 * texto libre (`valueName` sin `valueId`) en vez de omitirlo — varias
 * categorías aceptan un color fuera de la lista así; si esta cuenta en
 * particular no lo permite, el error de la API lo va a decir explícito
 * (mismo criterio del resto de Fase 2b).
 */
export function matchColorAttributeValue(
  colorAttribute: MeliAttributeSpec | null,
  shopifyColor: string | null | undefined,
): { valueId?: string; valueName: string } | null {
  const color = shopifyColor?.trim();
  if (!colorAttribute || !color) return null;

  const normalizedColor = normalizeForMatch(color);
  const exact = colorAttribute.values.find((v) => normalizeForMatch(v.name) === normalizedColor);
  if (exact) return { valueId: exact.id, valueName: exact.name };

  const partial = colorAttribute.values.find((v) => {
    const normalizedValue = normalizeForMatch(v.name);
    return normalizedValue.includes(normalizedColor) || normalizedColor.includes(normalizedValue);
  });
  if (partial) return { valueId: partial.id, valueName: partial.name };

  return { valueName: color };
}

/**
 * El usuario pidió que la talla de cada publicación salga igual a la que
 * Shopify tiene cargada (`ProductVariant.size`, ver la nota en
 * `PublishProductInput`) cuando el producto la tiene, y "Standard" cuando
 * no — mismo criterio de emparejamiento (exacto, después parcial, después
 * texto libre) que `matchColorAttributeValue`. A diferencia del color, acá
 * SIEMPRE se devuelve un valor (nunca `null`) mientras exista el atributo
 * de talla en la categoría: no hay ningún caso en el que el usuario quiera
 * dejarlo sin completar.
 */
export function matchSizeAttributeValue(
  sizeAttribute: MeliAttributeSpec | null,
  shopifySize: string | null | undefined,
): { valueId?: string; valueName: string } | null {
  if (!sizeAttribute) return null;
  const size = shopifySize?.trim();

  if (size) {
    const normalizedSize = normalizeForMatch(size);
    const exact = sizeAttribute.values.find((v) => normalizeForMatch(v.name) === normalizedSize);
    if (exact) return { valueId: exact.id, valueName: exact.name };

    const partial = sizeAttribute.values.find((v) => {
      const normalizedValue = normalizeForMatch(v.name);
      return normalizedValue.includes(normalizedSize) || normalizedSize.includes(normalizedValue);
    });
    if (partial) return { valueId: partial.id, valueName: partial.name };

    return { valueName: size };
  }

  // Sin talla cargada en Shopify -> "Standard" (pedido explícito del
  // usuario). Si la categoría no tiene una opción con ese nombre exacto en
  // su lista fija, se manda igual como texto libre en vez de omitir el
  // atributo — mismo criterio del resto de esta función.
  const standardValue = sizeAttribute.values.find((v) => STANDARD_VALUE_NAME_PATTERN.test(v.name));
  if (standardValue) return { valueId: standardValue.id, valueName: standardValue.name };
  return { valueName: "Standard" };
}

const MELI_TITLE_MAX_LENGTH = 60;
// Letras/números/espacios y puntuación básica — Mercado Libre rechaza
// emojis, símbolos raros y (en la práctica) títulos demasiado "decorados".
const UNSAFE_TITLE_CHARS = /[^\p{L}\p{N}\s.,\-/()]/gu;

/**
 * Mercado Libre no permite cualquier nombre de producto (longitud máxima,
 * sin caracteres raros) — a diferencia de Shopify. Best-effort: si Mercado
 * Libre igual rechaza un título puntual, ese error queda visible en el
 * resultado del lote de publicación en vez de adivinar más reglas de
 * moderación que no están documentadas públicamente.
 *
 * `reserveSuffixLength` (default 0): deja ese tanto de espacio libre al
 * final del límite de 60 caracteres — lo usa `buildCreateItemPayload` para
 * no cortar el nombre del producto a un largo que después, al pegarle
 * " - Talla X", termine pasándose del límite real de Mercado Libre (ver el
 * comentario grande de `sizeTitleSuffix` más abajo).
 */
export function sanitizeMeliTitle(rawTitle: string, reserveSuffixLength = 0): string {
  const cleaned = rawTitle.replace(UNSAFE_TITLE_CHARS, " ").replace(/\s+/g, " ").trim();
  const maxLength = Math.max(MELI_TITLE_MAX_LENGTH - reserveSuffixLength, 20);
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&rdquo;": '"',
  "&ldquo;": '"',
  "&ndash;": "-",
  "&mdash;": "-",
  "&hellip;": "...",
};

function decodeHtmlEntities(text: string): string {
  let out = text.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|rsquo|lsquo|rdquo|ldquo|ndash|mdash|hellip);/g, (m) => HTML_ENTITY_MAP[m] ?? m);
  // Entidades numéricas genéricas (&#123; / &#x7B;) que no están en el mapa de arriba.
  out = out.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(parseInt(code, 16)));
  return out;
}

// Emojis y pictogramas — Mercado Libre rechaza la descripción si los incluye
// ("solo texto plano", confirmado contra la documentación de la API).
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu;

/**
 * El editor de texto enriquecido de Shopify (y pegar contenido desde Word/
 * Google Docs) suele insertar comillas tipográficas, guiones largos,
 * viñetas y espacios especiales como CARACTERES UNICODE LITERALES, no como
 * entidades HTML (`decodeHtmlEntities` no los toca) — probando contra la
 * API real, Mercado Libre los rechaza igual que un tag o un emoji con
 * "The description must be in plain text" (`item.description.type.invalid`),
 * aunque ya no quede ningún `<tag>` ni emoji. Se normalizan a su equivalente
 * ASCII más cercano en vez de solo borrarlos, para no perder el sentido del
 * texto.
 */
const TYPOGRAPHIC_REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‒–—―]/g, "-"],
  [/…/g, "..."],
  [/[•●▪◦‣⁃·]/g, "-"],
  [/[  -   ]/g, " "],
  [/[​-‍﻿­]/g, ""],
];

function normalizeTypography(text: string): string {
  return TYPOGRAPHIC_REPLACEMENTS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/**
 * Red de seguridad final: después de sacar tags/entidades/emojis/tipografía
 * "inteligente", cualquier otro carácter que no sea letra, número, espacio
 * en blanco o puntuación básica se recorta directo — más barato que seguir
 * agregando casos puntuales cada vez que Mercado Libre rechaza uno nuevo, y
 * evita que un carácter decorativo no previsto tumbe la publicación (el
 * ítem ya se creó cuando esto corre — un texto de más se nota y se corrige
 * fácil, un error 400 que impide reintentar la descripción no).
 */
const UNSAFE_DESCRIPTION_CHARS = /[^\p{L}\p{N}\s.,;:!?¿¡()"'\-/%°#&@+*=_$|]/gu;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Adapta la descripción de un producto de Shopify (HTML, puede traer
 * tablas, íconos/imágenes, listas) al formato que exige Mercado Libre para
 * `POST /items/{id}/description`: SOLO texto plano, sin ningún tag HTML,
 * sin emojis ("no se pueden cambiar fuentes, tamaños ni resaltar texto" —
 * doc oficial). En vez de descartar tablas e íconos sin más (que es lo que
 * termina haciendo el campo `description` propio de Shopify cuando la
 * descripción es mayormente visual), las tablas se convierten a líneas de
 * texto separadas por " | " para no perder la información, y los íconos
 * (imágenes) se sacan directo porque no tienen forma de representarse en
 * texto plano.
 */
export function convertShopifyDescriptionForMeli(html: string): string {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Tablas -> filas de texto ("celda1 | celda2 | ...") ANTES de sacar tags,
  // porque hace falta la estructura de <tr>/<td> para separar las celdas.
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, tableInner: string) => {
    const rows = [...tableInner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
      const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
      return cells.filter((c) => c.length > 0).join(" | ");
    });
    return "\n" + rows.filter((r) => r.length > 0).join("\n") + "\n";
  });

  // Listas -> "- texto" por línea.
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, itemInner: string) => `\n- ${stripTags(itemInner)}`);

  // Íconos/imágenes: no tienen forma de representarse en texto plano, se sacan.
  text = text.replace(/<img[^>]*>/gi, "");

  // Saltos de línea explícitos antes de sacar el resto de los tags.
  text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6])>/gi, "\n");

  text = stripTags(text);
  text = decodeHtmlEntities(text);
  text = normalizeTypography(text);
  text = text.replace(EMOJI_PATTERN, "");
  text = text.replace(UNSAFE_DESCRIPTION_CHARS, "");
  text = text.replace(/[ \t]{2,}/g, " ");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

export interface PublishAttributeDefault {
  id: string;
  valueId?: string | null;
  valueName?: string | null;
}

export interface PublishGroupMapping {
  categoryId: string;
  listingTypeId: string;
  attributeDefaults: PublishAttributeDefault[];
  emptyGtinAttributeId: string | null;
  emptyGtinValueId: string | null;
  emptyGtinValueName: string | null;
  /**
   * El usuario pidió esto para productos ajustables de una sola talla (ej.
   * chalecos tácticos) que a veces igual traen algo cargado en el campo
   * "Talla"/"Tamaño" de Shopify — cuando es `true`, `buildCreateItemPayload`
   * ignora esa talla de Shopify para TODOS los productos del grupo y
   * publica siempre "Standard" (mismo valor que ya usa `matchSizeAttributeValue`
   * para un producto sin talla cargada). `false` = criterio de siempre (usar
   * la talla de Shopify cuando el producto la tiene).
   */
  forceStandardSize: boolean;
  /**
   * Color a usar cuando un producto del grupo NO tiene color cargado en
   * Shopify (o su color no matchea ningún valor fijo de la categoría) —
   * mismo patrón que `emptyGtinValueId`/`emptyGtinValueName`. Encontrado
   * con un caso real: "BARRIGUERA CON CINTURON" cayó en una categoría que
   * exige el atributo COLOR (`item.attributes.missing_required`) pero el
   * producto no tiene color cargado en Shopify — antes de esto,
   * `buildCreateItemPayload` simplemente omitía el atributo si no había
   * color de Shopify, y Mercado Libre recién lo rechazaba al publicar. Ver
   * el uso en `buildCreateItemPayload` más abajo: si la categoría EXIGE
   * color (`colorAttribute.required`) y ni el producto ni este default
   * resuelven un valor, la función devuelve un error claro ANTES de
   * llamar a la API en vez de mandar un payload que se sabe incompleto.
   * `null` = sin default configurado para este grupo.
   */
  defaultColorValueId: string | null;
  defaultColorValueName: string | null;
}

export interface PublishProductInput {
  name: string;
  brand: string | null;
  skuVariant: string;
  price: number | null;
  barcodeVariant: string | null;
  quantityOnHand: number;
  /**
   * Medidas reales de Shopify — cuando están cargadas, reemplazan el valor
   * manual de grupo para el atributo `seller_package_*` correspondiente
   * (ver `PACKAGE_DIMENSION_SOURCES` más abajo). El peso sale del campo
   * nativo de peso de la variante (`getVariantWeightGrams`); largo/ancho/alto
   * salen de metacampos del producto (`getPackageDimensionsCm`) porque
   * Shopify no expone el selector nativo de "Embalaje" por ninguna API.
   */
  packageWeightGrams: number | null;
  packageLengthCm: number | null;
  packageWidthCm: number | null;
  packageHeightCm: number | null;
  /** Color de la variante en Shopify (ver `matchColorAttributeValue`) — `null` si el producto no tiene color cargado. */
  color: string | null;
  /** Talla de la variante en Shopify (ver `matchSizeAttributeValue`) — `null` si el producto no tiene talla cargada (se publica como "Standard"). */
  size: string | null;
}

/**
 * El usuario pidió que TODOS los productos publicados salgan con garantía
 * del vendedor por 6 meses por defecto — va en `sale_terms` del cuerpo de
 * `POST /items`, no en `attributes` (confirmado contra la documentación
 * oficial de Mercado Libre).
 *
 * "Tiempo de disponibilidad" (`MANUFACTURING_TIME`) se sacó de acá a
 * pedido explícito del usuario: quiere que quede SIN completar, tal cual
 * viene predeterminado en Mercado Libre, en vez de forzar "1 día" en todas
 * las publicaciones.
 */
export const DEFAULT_SALE_TERMS: { id: string; valueName: string }[] = [
  { id: "WARRANTY_TYPE", valueName: "Garantía del vendedor" },
  { id: "WARRANTY_TIME", valueName: "6 meses" },
];

export interface PublishConfig {
  defaultBrand: string | null;
  currencyId: string; // "CLP" para el sitio MLC
  /**
   * Mercado Libre cobra más comisión que Shopify (y las publicaciones
   * nuevas necesitan un margen aparte) — el usuario pidió explícitamente
   * publicar siempre un 25% más caro que el precio de Shopify. Queda como
   * config (no hardcodeado adentro de `buildCreateItemPayload`) por si el
   * porcentaje cambia más adelante.
   */
  priceMarkupPercent: number;
  /**
   * Marcas fijas por prefijo de SKU (ej. "EM" -> "EmersonGear") — caso
   * real: productos sin "Proveedor" cargado en Shopify caían a
   * `defaultBrand` en vez de su marca real. A pedido explícito del
   * usuario, esto PISA cualquier otra fuente de marca (incluido el vendor
   * de Shopify) cuando el SKU matchea — ver `matchSkuPrefixBrand` más
   * abajo y el comentario grande en `MeliSkuPrefixBrandOverride`, esquema.
   * `[]`/`undefined` = sin reglas configuradas, se resuelve como antes.
   */
  skuPrefixBrandOverrides?: { skuPrefix: string; brand: string }[];
}

/**
 * Encuentra la marca fija configurada para el prefijo de SKU de un
 * producto — si más de un prefijo matchea (ej. "E" y "EM" ambos
 * configurados), gana el más largo/específico, mismo criterio que
 * `findKeywordOverride` para categorías por palabra clave. `null` si
 * ninguno matchea (el llamador sigue con el criterio normal: marca de
 * Shopify, después "Marca por defecto").
 */
export function matchSkuPrefixBrand(
  overrides: { skuPrefix: string; brand: string }[],
  sku: string,
): string | null {
  const upperSku = sku.trim().toUpperCase();
  if (!upperSku) return null;

  const matches = overrides.filter((o) => {
    const prefix = o.skuPrefix.trim().toUpperCase();
    return prefix.length > 0 && upperSku.startsWith(prefix);
  });
  if (matches.length === 0) return null;

  return matches.reduce((best, current) => (current.skuPrefix.length > best.skuPrefix.length ? current : best)).brand;
}

/**
 * Precio de venta chileno "elegante": termina en 990. Se redondea siempre
 * PARA ARRIBA al próximo `...990` (nunca para abajo) para no perder margen
 * — un precio recién calculado con el 25% de margen que cae, por ejemplo,
 * en $124.926 nunca debería bajar a $123.990 (perdería plata), así que
 * sube a $124.990. Ejemplo pedido por el usuario: 124926 -> 124990.
 */
export function roundToNext990(price: number): number {
  if (price <= 0) return price;
  return Math.ceil(price / 1000) * 1000 - 10;
}

/** Precio de Shopify + el margen configurado, ya redondeado a `...990` — lo que efectivamente se publica en Mercado Libre. */
export function computeMeliPrice(shopifyPrice: number, markupPercent: number): number {
  const withMarkup = shopifyPrice * (1 + markupPercent / 100);
  return roundToNext990(withMarkup);
}

export interface MeliPublishPayload {
  title: string;
  /** Ver el comentario en `MeliCreateItemInput` del conector — descubierto contra la API real, no en la doc pública. */
  familyName: string;
  categoryId: string;
  price: number;
  currencyId: string;
  availableQuantity: number;
  condition: "new";
  listingTypeId: string;
  sellerCustomField: string;
  pictures: { source: string }[];
  attributes: { id: string; valueId?: string | null; valueName?: string | null }[];
  saleTerms: { id: string; valueName: string }[];
}

export type BuildPayloadResult = { ok: true; payload: MeliPublishPayload } | { ok: false; reason: string };

/**
 * Arma el cuerpo final de `POST /items` combinando el producto puntual con
 * el mapeo ya confirmado de su grupo. Nunca lanza — un producto que no se
 * puede completar (sin marca, sin precio) vuelve `{ ok: false, reason }`
 * para que el llamador lo cuente como error del lote sin tumbar el resto.
 */
export function buildCreateItemPayload(
  product: PublishProductInput,
  images: string[],
  group: PublishGroupMapping,
  config: PublishConfig,
  colorAttribute: MeliAttributeSpec | null = null,
  sizeAttribute: MeliAttributeSpec | null = null,
  sellerSkuAttributeId: string | null = null,
): BuildPayloadResult {
  if (product.price === null || product.price <= 0) {
    return { ok: false, reason: "El producto no tiene precio válido en la base local." };
  }
  if (images.length === 0) {
    return { ok: false, reason: "El producto no tiene imágenes en Shopify — Mercado Libre exige al menos una." };
  }

  // La regla por prefijo de SKU (ej. "EM" -> "EmersonGear") PISA cualquier
  // otra fuente de marca cuando matchea — a pedido explícito del usuario
  // (ver el comentario grande de `skuPrefixBrandOverrides` en
  // `PublishConfig` más arriba). Si no matchea ninguna, sigue el criterio
  // de siempre: marca de Shopify, y si tampoco hay, la "Marca por
  // defecto" de Configuración.
  const skuPrefixBrand = matchSkuPrefixBrand(config.skuPrefixBrandOverrides ?? [], product.skuVariant);
  const brand = skuPrefixBrand ?? (product.brand?.trim() || config.defaultBrand?.trim() || null);
  if (!brand) {
    return {
      ok: false,
      reason: 'El producto no tiene marca y no hay "Marca por defecto" configurada en Configuración.',
    };
  }

  // Las 4 medidas de embalaje: cuando Shopify las tiene cargadas (peso
  // nativo de la variante; largo/ancho/alto vía metacampos, ver
  // `getPackageDimensionsCm` del conector), reemplazan el valor manual de
  // grupo correspondiente — el valor de grupo queda como respaldo para
  // cuando a un producto puntual le falte el dato en Shopify.
  const autoPackageValues: { id: string; value: number | null }[] = [
    { id: "seller_package_height", value: product.packageHeightCm },
    { id: "seller_package_width", value: product.packageWidthCm },
    { id: "seller_package_length", value: product.packageLengthCm },
    { id: "seller_package_weight", value: product.packageWeightGrams },
  ];
  const idsWithAutoValue = new Set(autoPackageValues.filter((a) => a.value !== null).map((a) => a.id));

  // Caso real encontrado ("BARRIGUERA CON CINTURON"): a diferencia de
  // largo/ancho/alto (que Mercado Libre no reclamó nunca, aunque falten),
  // el peso del paquete (`seller_package_weight`) SÍ lo rechazó como
  // obligatorio de verdad al publicar — `item.attribute.missing.seller.
  // package.dimensions`, departamento "pymes" — aunque no aparezca en
  // `GET /categories/{id}/attributes` (por eso `PACKAGE_DIMENSION_ATTRIBUTES`
  // lo marca `required: false` ahí, ver la nota grande más arriba: esa lista
  // es solo para la pantalla, no refleja lo que la API realmente exige al
  // publicar). El producto no tenía peso cargado en su variante de Shopify
  // (`packageWeightGrams` nulo) y el grupo tampoco tenía un "Peso del
  // paquete" de respaldo guardado — Mercado Libre recién lo rechazaba
  // DESPUÉS de intentar publicar. Se corta ACÁ, con un motivo claro, mismo
  // criterio que "sin marca"/"sin precio"/"sin imágenes"/"sin color" más
  // arriba, en vez de mandar un payload que se sabe incompleto.
  const hasWeightDefault = group.attributeDefaults.some(
    (a) => a.id === "seller_package_weight" && ((a.valueName?.trim() ?? "") !== "" || a.valueId),
  );
  if (!idsWithAutoValue.has("seller_package_weight") && !hasWeightDefault) {
    return {
      ok: false,
      reason:
        'Mercado Libre exige el peso del paquete ("seller_package_weight") y no hay ninguno disponible: el producto no tiene peso cargado en la variante de Shopify, y el grupo no tiene un "Peso del paquete (g)" de respaldo configurado en "Publicar en ML". Carga el peso en Shopify, o complétalo en el grupo.',
    };
  }

  // Caso real encontrado (grupo de "CHALECO CON PLATAFORMA DE PECHO
  // EMERSONGEAR MULTICAM", categoría MLC158416): el grupo tenía guardado un
  // `attributeDefaults` con id "SIZE" de una confirmación VIEJA, de antes de
  // que existiera `sizeAttribute`/`matchSizeAttributeValue` (que resuelve la
  // talla por producto, no por grupo). Sin este filtro, ese default viejo se
  // sumaba IGUAL al `attributes.push` de más abajo (línea con
  // `sizeAttribute!.id`), mandando el id "SIZE" DOS VECES en el mismo
  // `POST /items` — incluso si Mercado Libre no lo rechazara por duplicado,
  // es basura que puede pisar el valor correcto según el orden en que la API
  // lea el arreglo. Mismo riesgo con "COLOR" si algún grupo viejo lo tuviera
  // guardado así. Se excluyen acá, no al guardar el mapeo, para no tener que
  // migrar filas viejas de `MeliCategoryGroupMapping` a mano.
  const attributes: MeliPublishPayload["attributes"] = [
    { id: "BRAND", valueName: brand },
    ...group.attributeDefaults
      .filter((a) => !idsWithAutoValue.has(a.id) && a.id !== colorAttribute?.id && a.id !== sizeAttribute?.id)
      .map((a) => ({ ...a, valueName: withPackageUnit(a.id, a.valueName) })),
  ];

  for (const auto of autoPackageValues) {
    if (auto.value === null) continue;
    // Mercado Libre rechaza estos 4 atributos si el número no es un entero
    // exacto (confirmado en vivo: "PORTA FUSIL DOS PUNTAS" quedó con
    // seller_package_weight en algo como "550.4 g" y la API lo rechazó —
    // item.attribute.invalid.format.seller.package.dimensions, "Only
    // integers are accepted for dimensions and weight"). El valor puede
    // traer decimales reales desde Shopify: el peso se convierte desde
    // libras/onzas (453.592 g por libra, 28.3495 g por onza — ver
    // `getVariantWeightGrams` del conector de Shopify) y las medidas de
    // paquete vienen de un metacampo de texto libre que el usuario pudo
    // haber cargado como "20.5". Antes esto se redondeaba solo a 1
    // decimal (`Math.round(auto.value * 10) / 10`), lo que en la mayoría
    // de los casos igual dejaba un decimal — ahora se redondea al entero
    // más cercano, como exige la API, con un piso de 1 para no mandar "0 g"
    // en un producto real con peso/medida positiva pero menor a 0.5.
    const rounded = Math.max(1, Math.round(auto.value));
    attributes.push({ id: auto.id, valueName: withPackageUnit(auto.id, `${rounded}`) });
  }

  if (product.barcodeVariant) {
    attributes.push({ id: "GTIN", valueName: product.barcodeVariant });
  } else if (group.emptyGtinAttributeId) {
    attributes.push({
      id: group.emptyGtinAttributeId,
      valueId: group.emptyGtinValueId ?? undefined,
      valueName: group.emptyGtinValueName ?? undefined,
    });
  }

  // Si el producto no tiene color cargado en Shopify (o no matchea ningún
  // valor fijo de la categoría), se usa el "Color por defecto" del grupo
  // como respaldo, si está configurado — ver el comentario de
  // `defaultColorValueId` en `PublishGroupMapping`.
  const colorMatch =
    matchColorAttributeValue(colorAttribute, product.color) ??
    (colorAttribute && group.defaultColorValueName
      ? { valueId: group.defaultColorValueId ?? undefined, valueName: group.defaultColorValueName }
      : null);

  // Caso real que motivó esto: "BARRIGUERA CON CINTURON" — la categoría
  // exige COLOR (`colorAttribute.required`) pero el producto no tiene color
  // cargado en Shopify y el grupo no tenía un default configurado. Antes,
  // el atributo se omitía y Mercado Libre rechazaba recién al publicar
  // (`item.attributes.missing_required`). Ahora se corta ACÁ, con un
  // motivo claro, mismo criterio que "sin marca"/"sin precio"/"sin
  // imágenes" más arriba.
  if (colorAttribute?.required && !colorMatch) {
    return {
      ok: false,
      reason: `La categoría exige el atributo "${colorAttribute.name}" y el producto no tiene color cargado en Shopify. Cárgale un color en Shopify, o configura un "Color por defecto" para este grupo en "Publicar en ML".`,
    };
  }

  if (colorMatch) {
    attributes.push({ id: colorAttribute!.id, valueId: colorMatch.valueId, valueName: colorMatch.valueName });
  }

  // Ver el comentario de `forceStandardSize` en `PublishGroupMapping`: se
  // manda `null` en vez de `product.size` a propósito — reusa el mismo
  // camino que `matchSizeAttributeValue` ya tiene para "sin talla cargada"
  // (que resuelve a "Standard"), en vez de duplicar esa lógica acá.
  const sizeMatch = matchSizeAttributeValue(sizeAttribute, group.forceStandardSize ? null : product.size);
  if (sizeMatch) {
    attributes.push({ id: sizeAttribute!.id, valueId: sizeMatch.valueId, valueName: sizeMatch.valueName });
  }

  // Ver el comentario de `sellerSkuAttributeId` en `GroupAttributeNeeds`:
  // se manda ADEMÁS de `sellerCustomField` (no en su reemplazo) porque
  // Mercado Libre trata el SKU "clásico" y el atributo `SELLER_SKU` como
  // dos campos con búsqueda separada, y esta cuenta (modelo "User
  // Products"/familias) mostró el panel de SKU del sitio vacío usando solo
  // el campo clásico.
  if (sellerSkuAttributeId) {
    attributes.push({ id: sellerSkuAttributeId, valueName: product.skuVariant });
  }

  // Caso real reportado por el usuario: "CINTURON COBRA" tiene dos
  // variantes en Shopify (talla M y talla L) — como cada variante se
  // publica como un ítem SEPARADO de Mercado Libre (ver el comentario
  // grande de `familyName` más abajo: esta app no usa variaciones nativas
  // de un solo ítem), las dos publicaciones salían con el MISMO título,
  // sin ninguna forma de distinguirlas a simple vista en una búsqueda o en
  // el listado de publicaciones — el atributo de talla (si la categoría lo
  // expone) queda en la ficha técnica, pero no alcanza. Se agrega la talla
  // directo al título cuando el producto la tiene (`product.size`, mismo
  // dato que ya usa `matchSizeAttributeValue`) para que cada publicación
  // diga explícitamente de qué talla es — "CINTURON COBRA - Talla M" vs.
  // "CINTURON COBRA - Talla L". Respeta `forceStandardSize` (si el grupo
  // pidió ignorar la talla de Shopify para todo el grupo, tampoco se agrega
  // al título — sería agregar una talla que la publicación en realidad no
  // está usando). Se reserva el espacio del sufijo ANTES de sanear/truncar
  // el nombre (`sanitizeMeliTitle(product.name, reserveSuffixLength)`) para
  // que el resultado final nunca se pase del límite real de 60 caracteres
  // de Mercado Libre.
  const effectiveSize = group.forceStandardSize ? null : product.size?.trim() || null;
  const sizeTitleSuffix = effectiveSize
    ? ` - Talla ${effectiveSize.replace(UNSAFE_TITLE_CHARS, " ").replace(/\s+/g, " ").trim()}`
    : "";
  const sanitizedTitle = sanitizeMeliTitle(product.name, sizeTitleSuffix.length) + sizeTitleSuffix;

  return {
    ok: true,
    payload: {
      title: sanitizedTitle,
      // Ítem simple sin variaciones -> familia de un solo miembro: reusa el
      // mismo texto que el título, ya saneado al límite de 60 caracteres.
      familyName: sanitizedTitle,
      categoryId: group.categoryId,
      price: computeMeliPrice(product.price, config.priceMarkupPercent),
      currencyId: config.currencyId,
      availableQuantity: Math.max(0, product.quantityOnHand),
      condition: "new",
      listingTypeId: group.listingTypeId,
      sellerCustomField: product.skuVariant,
      pictures: images.map((url) => ({ source: url })),
      attributes,
      saleTerms: DEFAULT_SALE_TERMS,
    },
  };
}
