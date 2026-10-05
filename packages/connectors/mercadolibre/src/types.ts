export interface MeliAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  siteId: "MLC";
}

export interface MeliTokenSet {
  accessToken: string;
  refreshToken: string;
  userId: number;
  /** ISO datetime; Mercado Libre expira el access_token en horas (A.1/B.2). */
  expiresAt: string;
}

export interface MeliNormalizedVariation {
  channelVariantId: string; // variation id (número, como string)
  sku: string | null;
  availableQuantity: number | null;
  attributes: { name: string; value: string | null }[];
}

export interface MeliNormalizedItem {
  channelProductId: string; // item id, ej: MLC1234567890
  title: string;
  status: string; // active | paused | closed | ...
  /**
   * `sub_status` crudo de la API — motivos asociados al `status` (ej.
   * `["out_of_stock"]`). SIN VERIFICAR contra un ítem pausado/cerrado real
   * todavía (no hay acceso a la API en vivo desde este entorno de
   * desarrollo, mismo criterio que el resto de Fase 2b) — la
   * documentación pública de Mercado Libre no es clara sobre cuándo viene
   * poblado. Se guarda igual y se muestra tal cual en la pantalla "Estado
   * en Mercado Libre"; si en la práctica viene casi siempre vacío, esa
   * pantalla ya avisa que hay que revisar el detalle en el sitio de
   * Mercado Libre.
   */
  subStatus: string[];
  price: number | null;
  availableQuantity: number | null;
  sku: string | null;
  categoryId: string;
  pictures: { url: string }[];
  variations: MeliNormalizedVariation[];
  /**
   * Atributos crudos del ítem (id + valor de texto) — hoy solo se usa para
   * verificar, después de publicar, si el atributo `SELLER_SKU` (ver la
   * nota en `GroupAttributeNeeds` de `@blacksand/core-domain`) quedó
   * guardado con el SKU esperado. No se normaliza más porque el resto de
   * la app no lo necesita.
   */
  attributes: { id: string; valueName: string | null }[];
}

/** Fase 3a (F.3): pedidos leídos por sondeo para descontar stock. */
export interface MeliNormalizedOrderLine {
  channelProductId: string; // item id
  channelVariantId: string | null; // variation id, como string
  quantity: number;
  unitPrice: number;
}

export interface MeliNormalizedOrder {
  channelOrderId: string; // order id, como string
  dateCreated: string; // ISO
  status: string; // paid | cancelled | ...
  lines: MeliNormalizedOrderLine[];
}

// --- Fase 2b: publicar productos nuevos en Mercado Libre -----------------

/** Resultado de `domain_discovery/search` — la categoría más probable para un texto. */
export interface MeliCategoryPrediction {
  categoryId: string;
  categoryName: string;
  domainId: string | null;
}

export interface MeliCategoryAttributeValue {
  id: string;
  name: string;
}

/**
 * Un atributo de una categoría (`GET /categories/{id}/attributes`). `required`
 * viene de `tags.required` de la respuesta real — no se asume nada fijo por
 * categoría, cada una trae su propia lista. `values` viene poblado solo
 * cuando el atributo tiene una lista fija de opciones (`value_type: "list"`
 * o similar); texto libre / número quedan con `values: []`.
 */
export interface MeliCategoryAttribute {
  id: string;
  name: string;
  valueType: string; // string | number | list | boolean | ...
  required: boolean;
  values: MeliCategoryAttributeValue[];
}

export interface MeliListingType {
  id: string;
  name: string;
}

export interface MeliCreateItemAttribute {
  id: string;
  valueId?: string | null;
  valueName?: string | null;
}

/** Fase 2b: cuerpo normalizado para `POST /items` — sin variaciones (el catálogo central ya está aplanado a un SKU = un producto, ver Fase 2b). */
export interface MeliCreateItemInput {
  title: string;
  /**
   * Mercado Libre está habilitando progresivamente, cuenta por cuenta, un
   * modelo nuevo ("User Products"/familias) donde `POST /items` exige este
   * campo aunque el ítem no tenga variaciones — se descubrió recién contra
   * la API real de esta cuenta (`body.required_fields: [family_name]`), no
   * está en la documentación pública general. Para un ítem simple como los
   * de este proyecto, alcanza con que la familia tenga un solo miembro: se
   * reusa el mismo texto que el título saneado (máx. 60 caracteres, mismo
   * límite que exige Mercado Libre para este campo).
   */
  familyName: string;
  categoryId: string;
  price: number;
  currencyId: string; // "CLP" para el sitio MLC
  availableQuantity: number;
  condition: "new" | "used" | "not_specified";
  listingTypeId: string;
  sellerCustomField: string; // SKU
  pictures: { source: string }[];
  attributes: MeliCreateItemAttribute[];
  /**
   * Garantía — a diferencia de `attributes`, va en un arreglo aparte del
   * cuerpo de `POST /items` (confirmado contra la documentación oficial:
   * `sale_terms`, con `id`/`value_name`, no `value_id`). El usuario pidió
   * que TODOS los productos publicados salgan con garantía del vendedor de
   * 6 meses por defecto (ver `DEFAULT_SALE_TERMS` en `@blacksand/core-domain`).
   * "Tiempo de disponibilidad" (`MANUFACTURING_TIME`) queda deliberadamente
   * fuera de este arreglo — el usuario pidió que se quede sin completar,
   * tal cual viene predeterminado en Mercado Libre.
   */
  saleTerms: { id: string; valueName: string }[];
}

export interface MeliCreateItemResult {
  itemId: string;
}
