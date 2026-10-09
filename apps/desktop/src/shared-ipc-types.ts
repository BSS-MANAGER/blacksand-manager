/**
 * Contrato IPC entre preload y renderer. Vive en apps/desktop porque es
 * específico de esta app de escritorio (no de los paquetes de dominio).
 */
export interface DashboardRow {
  id: string;
  productName: string;
  channelCode: string;
  status: "sincronizado" | "pendiente" | "error" | "conflicto";
  stockDiff: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Código corto del error (ver `@blacksand/shared/sync-error-codes.ts`) — `null` mientras `status !== "error"`. */
  lastErrorCode: string | null;
}

export interface ChannelStatusRow {
  code: "shopify" | "mercadolibre" | "meta";
  name: string;
  isActive: boolean;
  configured: boolean;
  lastVerified: string | null;
  detail: string | null;
}

export interface ProductVariantChannelRow {
  code: string;
  status: string;
  /** channelProductId guardado en ChannelProductMap — si es null, esta variante no está mapeada a ese canal (Fase 2a no crea publicaciones nuevas). */
  channelProductId: string | null;
  lastError: string | null;
  /** Código corto del error — ver `@blacksand/shared/sync-error-codes.ts`. */
  lastErrorCode: string | null;
  /**
   * A pedido del usuario ("¿'Publicar en ML' es Shopify menos Mercado
   * Libre?"): el resumen de reconciliación de Productos necesitaba este
   * dato A NIVEL DE VARIANTE (antes solo vivía en `ProductRow.channels`, a
   * nivel de producto) para contar exactamente igual que
   * `loadCandidateProducts` (`@blacksand/sync-engine/meli-publish.ts`), que
   * arma "Publicar en ML" variante por variante, no producto por producto
   * — ver el comentario grande en `totalShopify`/`yaEnMeli` (ProductosPage).
   */
  listingStatus: string | null;
}

export interface ProductVariantRow {
  id: string;
  skuVariant: string;
  barcodeVariant: string | null;
  price: number | null;
  quantityOnHand: number;
  channels: ProductVariantChannelRow[];
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  totalStock: number;
  /**
   * `status` acá es `syncStatus` (si ESTA APP logró empujar su último
   * cambio a ese canal) — `listingStatus` es el estado REAL de la
   * publicación en el canal (para Mercado Libre: activa/pausada/cerrada/
   * ..., ver el comentario grande en `ChannelProductMap.listingStatus`,
   * esquema; `null` = sin revisar todavía, o el canal no trackea esto).
   * Son cosas distintas a propósito — ver "Estado en Mercado Libre" para
   * el detalle completo por publicación.
   */
  channels: {
    code: string;
    status: string;
    /** Código corto del error — ver `@blacksand/shared/sync-error-codes.ts`. `null` mientras `status !== "error"`. */
    lastErrorCode: string | null;
    listingStatus: string | null;
    /** Motivos que Mercado Libre asocia al `listingStatus` (ej. `["out_of_stock"]`) — `[]` si no aplica/no se sabe. */
    listingSubStatus: string[];
  }[];
  variants: ProductVariantRow[];
}

export interface ProductUpdateInput {
  variantId: string;
  sku?: string;
  price?: number;
  quantity?: number;
}

export interface ProductUpdateChannelResult {
  channelCode: string;
  ok: boolean;
  error?: string;
  /** Código corto del error — ver `@blacksand/shared/sync-error-codes.ts`. */
  errorCode?: string;
  /** Aviso informativo (ej. "la app nunca sube stock, no se cambió nada"). */
  note?: string;
}

export interface ProductUpdateResult {
  ok: true;
  results: ProductUpdateChannelResult[];
}

/**
 * "Eliminar producto" — ver el comentario grande en `BlacksandApi.products.delete`
 * más abajo. `channels` usa los mismos códigos que `Channel.code`
 * ("shopify", "mercadolibre") más el valor especial "venta_presencial"
 * (pedido con `channelId` null, ver el comentario en `Order.channelId`).
 */
export type ProductDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: "has_history"; channels: string[]; orderCount: number };

/**
 * "Crear producto" — a pedido del usuario: subir un producto nuevo desde la
 * app y que se publique solo en Shopify y (cuando la categoría del grupo ya
 * está confirmada) en Mercado Libre. SKU único, sin variantes de color/
 * talla (decisión del usuario). `imagePaths`: rutas locales en el
 * computador del usuario, elegidas con `products.pickImages()` — el main
 * process lee los bytes del disco directo, nunca cruzan el puente IPC como
 * archivo/Buffer.
 */
export interface CreateProductInput {
  sku: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  price: number;
  quantityOnHand: number;
  imagePaths: string[];
}

/** Resultado de publicar (o no) en Mercado Libre en el mismo acto de crear — ver `createProductAndPublish` (@blacksand/sync-engine). */
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
  stockWarning: string | null;
  imageWarnings: string[];
  meli: CreateProductMeliOutcome;
}

export interface ReconciliationRow {
  id: string;
  channelCode: string;
  channelProductId: string;
  channelVariantId: string | null;
  channelSku: string | null;
  candidates: { variantId: string; productId: string; sku: string; name: string }[];
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  userName: string | null;
  /** Fase 3: resumen legible de `after` (p. ej. líneas de pedido sin mapeo) — null cuando no aplica. */
  detail: string | null;
}

export interface ShopifyConfigInput {
  shopDomain: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
}

export interface MercadoLibreConfigInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ImportResult {
  channel: string;
  totalItems: number;
  matched: number;
  ambiguous: number;
  createdNew: number;
  /** Solo canal "mercadolibre" — ver `ImportSummary.removedListings` en @blacksand/sync-engine. */
  removedListings?: number;
}

/** Fase 3e: resultado de "Actualizar N° de pedido" — backfill de `orderNumber` para pedidos que ya estaban en la app antes de que ese campo existiera. */
export interface BackfillOrderNumbersResult {
  shopifyUpdated: number;
  /** Pedidos de Shopify que no se pudieron actualizar (ya no existen en Shopify, ej. borrados). */
  shopifyErrors: number;
  mercadolibreUpdated: number;
  /** Fase 3f: ventas de mostrador que recibieron su correlativo "VP-#0001" recién ahora. */
  posUpdated: number;
}

/** Fase 3g: resultado de reintentar la sincronización de un pedido puntual. */
export interface RetryOrderSyncResult {
  syncStatus: "sincronizado" | "error";
  /** Detalle legible del error, si `syncStatus` sigue en "error" después del reintento. */
  lastSyncError: string | null;
  /** Código corto del error — ver `@blacksand/shared/sync-error-codes.ts`. */
  lastSyncErrorCode: string | null;
}

/** Fase 3a: resumen del sondeo de pedidos, por canal. */
export interface OrderIngestSummaryRow {
  channel: string;
  ordersSeen: number;
  ordersNew: number;
  /** Fase 3c: pedidos cancelados detectados en esta corrida (nuevos-ya-cancelados + transiciones a cancelado). */
  ordersCancelled: number;
  unmappedLines: number;
  /** Bug real SKU EM7405MC (ronda 3): pedidos ya conocidos que no habían quedado "sincronizado" y se reintentaron solos en esta corrida — ver el comentario grande en `OrderIngestSummary.ordersRetried` (@blacksand/sync-engine). */
  ordersRetried: number;
  /** Bug real SKU EM7405MC (ronda 6): pedidos ya conocidos que NO se reintentaron en esta corrida porque su error no se puede resolver con un reintento (`SIN_PUBLICAR`/`BLOQUEADO_POLITICA`) — ver `NON_AUTO_RETRIABLE_ERROR_CODES` (@blacksand/sync-engine). */
  ordersRetrySkipped: number;
  /** Bug #1151: desde cuándo se buscó realmente en esta corrida — para mostrarlo en el Dashboard y que quede claro que ya no es una ventana fija de 24h. */
  sinceIso: string;
  /** Bug real SKU EM7405MC (ronda 4): presente solo cuando Mercado Libre estaba configurado pero no se pudo conectar en esta corrida puntual (token vencido/rotado, error de red) — ver `OrderIngestSummary.connectionError` (@blacksand/sync-engine). */
  connectionError?: string;
}

/** Fase 3d: una línea de producto de un pedido — SKU y cantidad, para mostrar en el Dashboard. */
export interface OrderLineSummary {
  sku: string;
  quantity: number;
}

/** Fase 3a/3b: fila de "Pedidos recientes" del Dashboard (pedidos de canal + ventas de mostrador). */
export interface RecentOrderRow {
  id: string;
  channelCode: string | null; // null = venta de mostrador
  /** Fase 3d: número de pedido tal cual lo reconoce el usuario en la tienda de origen (ej. "#1023" en Shopify; en Mercado Libre, el mismo id que usan como número de venta). Null en ventas de mostrador y en pedidos ingresados antes de que existiera este campo. */
  orderNumber: string | null;
  orderDate: string;
  itemCount: number;
  /** Fase 3d: SKU y cantidad de cada línea del pedido. */
  items: OrderLineSummary[];
  total: number;
  status: string;
  syncStatus: string;
  /** Fase 3g: detalle legible del último intento de push de stock a los demás canales cuando `syncStatus === "error"` (ej. "mercadolibre: Request failed with status 401"); null mientras nunca hubo error o después de un reintento exitoso. */
  lastSyncError: string | null;
  /** Código corto del error (ver `@blacksand/shared/sync-error-codes.ts`) — lo que la tabla muestra como badge; `lastSyncError` queda como detalle completo, aparte. */
  lastSyncErrorCode: string | null;
  /** Fase 3c: null mientras el pedido no está cancelado. */
  cancelledAt: string | null;
  /** Fase 3c: true = se repuso stock; false = no se repuso (el producto igual salió del inventario); null = cancelado, pendiente de que el usuario decida. Siempre null si `status !== "cancelado"`. */
  restocked: boolean | null;
}

/** Fase 3c: fila de "Pedidos cancelados pendientes de revisión" del Dashboard — pedidos donde todavía no se sabe si hay que reponer stock. */
export interface PendingCancellationRow {
  id: string;
  channelCode: string | null;
  channelOrderId: string | null;
  /** Fase 3d: ver comentario en `RecentOrderRow`. */
  orderNumber: string | null;
  orderDate: string;
  cancelledAt: string | null;
  itemCount: number;
  /** Fase 3d: SKU y cantidad de cada línea del pedido. */
  items: OrderLineSummary[];
  total: number;
}

/** Fase 3b: una línea del carrito de venta presencial. */
export interface PosSaleItemInput {
  variantId: string;
  quantity: number;
  unitPrice: number;
  unitCost?: number;
}

export interface PosSaleInput {
  items: PosSaleItemInput[];
  paymentMethod?: string;
  observations?: string;
}

export interface PosSalePushResultRow {
  variantId: string;
  results: ProductUpdateChannelResult[];
}

export interface PosSaleResult {
  ok: true;
  orderId: string;
  /** Fase 3f: correlativo "VP-#0001" recién asignado a esta venta de mostrador. */
  orderNumber: string;
  pushResults: PosSalePushResultRow[];
}

// --- Fase 2b: publicar productos de Shopify en Mercado Libre -------------

export interface MeliPublishGroupRow {
  groupKey: string;
  sampleProductName: string;
  productCount: number;
  confirmed: boolean;
  categoryId: string | null;
  categoryName: string | null;
}

export interface MeliAttributeValueRow {
  id: string;
  name: string;
}

export interface MeliAttributeSpecRow {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  values: MeliAttributeValueRow[];
}

export interface MeliGroupNeedsRow {
  gtinFallback: { attributeId: string; values: MeliAttributeValueRow[] } | null;
  needsGroupDefault: MeliAttributeSpecRow[];
  /**
   * `true` cuando esta categoría exige una "guía de talles" (Mercado Libre
   * la pide por fuera de los atributos normales — ver el comentario grande
   * en `resolveGroupAttributeNeeds` de `@blacksand/core-domain`) que esta
   * app todavía no sabe crear. La pantalla "Publicar en ML" usa esto para
   * avisar ANTES de publicar y sugerir buscar otra categoría, en vez de que
   * el usuario se entere recién con el error de la API.
   */
  requiresSizeGuide: boolean;
  /**
   * `true` cuando esta categoría tiene un atributo de talla (Mercado Libre
   * lo pide, sin importar si `needsGroupDefault` lo incluye — la talla se
   * resuelve por producto, no por grupo, ver `matchSizeAttributeValue` en
   * `@blacksand/core-domain`). La pantalla usa esto para ofrecer el
   * checkbox "Talla: siempre Standard para este grupo" (para productos
   * ajustables de una sola talla, ej. chalecos tácticos) solo cuando tiene
   * sentido — si la categoría no tiene talla, no hay nada que forzar.
   */
  hasSizeAttribute: boolean;
  /**
   * `true` cuando esta categoría EXIGE un atributo de color
   * (`colorAttribute.required` en `@blacksand/core-domain`). Caso real que
   * motivó esto: "BARRIGUERA CON CINTURON" cayó en una categoría que exige
   * COLOR, pero el producto no tiene color cargado en Shopify — Mercado
   * Libre rechazó la publicación (`item.attributes.missing_required`). La
   * pantalla usa esto para ofrecer el selector "Color por defecto" (se usa
   * solo para productos del grupo sin color propio en Shopify) cuando de
   * verdad hace falta.
   */
  colorRequired: boolean;
  /**
   * Lista fija de colores de esta categoría (id + nombre), para poblar el
   * selector de "Color por defecto" — `[]` si la categoría no tiene
   * atributo de color, o no expone una lista fija de valores.
   */
  colorValues: MeliAttributeValueRow[];
}

export interface MeliCategoryPreviewResult {
  /**
   * `categoryPath` (pedido real del usuario): el camino completo desde la
   * raíz del árbol de Mercado Libre hasta esta categoría, ej.
   * `["Vehículos", "Accesorios para Vehículos", "Cascos y Protección", "Cascos"]`
   * — Mercado Libre repite nombres de categoría en ramas totalmente
   * distintas (bicicleta, construcción, trabajo...), así que el nombre
   * solo no alcanza para distinguirlas. `undefined` solo si la consulta del
   * camino falló puntualmente — nunca bloquea mostrar el resto.
   */
  predictions: { categoryId: string; categoryName: string; categoryPath?: string[] }[];
  attributes: MeliAttributeSpecRow[];
  groupNeeds: MeliGroupNeedsRow;
  /**
   * `"keyword_override"` cuando `predictions[0]` salió de una palabra clave
   * que el usuario guardó a mano (categoría ya verificada por una persona)
   * en vez de la predicción de texto de Mercado Libre — ver la pantalla
   * "Categorías por palabra clave" y el comentario en `findKeywordOverride`
   * de `@blacksand/core-domain`. "Publicar todo automáticamente" solo
   * confirma sola una categoría nueva cuando esto es `"keyword_override"`;
   * si es `"ml_prediction"`, el grupo queda para revisión manual.
   */
  categorySource: "keyword_override" | "ml_prediction";
}

export interface MeliKeywordOverrideRow {
  id: string;
  keyword: string;
  categoryId: string;
  categoryName: string;
}

export interface MeliBulkCategoryPreviewRow {
  groupKey: string;
  sampleProductName: string;
  productCount: number;
  preview: MeliCategoryPreviewResult;
  suggestedKeyword: string;
}

export interface MeliCategorySearchResultRow {
  categoryId: string;
  categoryName: string;
  /** Ver el comentario grande en `MeliCategoryPreviewResult.predictions`. */
  categoryPath?: string[];
}

export interface MeliAttributeDefaultInput {
  id: string;
  valueId?: string;
  valueName?: string;
}

export interface MeliConfirmGroupMappingInput {
  groupKey: string;
  categoryId: string;
  categoryName: string;
  listingTypeId: string;
  attributeDefaults: MeliAttributeDefaultInput[];
  emptyGtinAttributeId?: string;
  emptyGtinValueId?: string;
  emptyGtinValueName?: string;
  /** Productos ajustables de una sola talla (ej. chalecos tácticos): ignora la talla de Shopify y publica siempre "Standard" para todo el grupo. `false` si se omite. */
  forceStandardSize?: boolean;
  /** Color a usar para productos del grupo que no tienen color cargado en Shopify — ver `colorRequired`/`colorValues` en `MeliGroupNeedsRow`. `undefined`/vacío = sin default (ver el comentario de `PublishGroupMapping.defaultColorValueId` en `@blacksand/core-domain`). */
  defaultColorValueId?: string;
  defaultColorValueName?: string;
}

export interface MeliPublishBatchErrorRow {
  productName: string;
  sku: string;
  reason: string;
}

export interface MeliPublishBatchResult {
  attempted: number;
  created: number;
  errors: MeliPublishBatchErrorRow[];
  warnings: MeliPublishBatchErrorRow[];
}

export interface MeliListingTypeRow {
  id: string;
  name: string;
}

export interface MeliDescriptionSyncResult {
  attempted: number;
  updated: number;
  skipped: number;
  /** Ronda 6 (bug SKU EM7405MC): ya estaba igual, no se mandó ningún PUT/POST — ver `meli-publish.ts`. */
  unchanged: number;
  errors: MeliPublishBatchErrorRow[];
}

/**
 * Una publicación de Mercado Libre que la app conoce, con su estado REAL
 * (no el `syncStatus` de si esta app logró empujar su último cambio — ver
 * el comentario grande en `ChannelProductMap.listingStatus`, esquema). Se
 * llena al correr "Importar de Mercado Libre" (o el botón "Actualizar
 * estado" de la pantalla "Estado en Mercado Libre", que dispara lo mismo).
 */
export interface MeliListingIssueRow {
  productId: string;
  productName: string;
  sku: string;
  channelProductId: string;
  /** `null` = nunca se revisó con esta versión de la app. Valores crudos de Mercado Libre: "active" | "paused" | "closed" | "under_review" | "inactive" | "payment_required" | ... */
  listingStatus: string | null;
  listingSubStatus: string[];
  listingStatusCheckedAt: string | null;
}

export type MeliListingReactivateResult = { ok: true } | { ok: false; reason: string };

/**
 * "Eliminar publicación" (a pedido del usuario). Mercado Libre no expone un
 * borrado permanente vía API para una cuenta con historial — esto CIERRA la
 * publicación (`PUT /items/{id}` status=closed), ver el comentario grande
 * en `closeMeliListing` (@blacksand/sync-engine/meli-listing-status.ts).
 */
export type MeliListingCloseResult = { ok: true } | { ok: false; reason: string };

// --- Cerrar publicaciones duplicadas (ver meli-duplicate-fix.ts, @blacksand/sync-engine) ---

/**
 * Caso real encontrado (septiembre 2026): ~20 productos quedaron publicados
 * DOS VECES en Mercado Libre — dos `channelProductId` distintos para la
 * MISMA variante local, por un doble clic en "Publicar lote"/"Publicar
 * todo automáticamente" (ya corregido, ver `publishGuardRef` en
 * `PublicarMeliPage.tsx` y `findActiveChannelMapByVariant` en
 * @blacksand/db). Esta pantalla ayuda a limpiar los que ya quedaron
 * duplicados ANTES del fix.
 */
export interface MeliDuplicateItem {
  channelProductId: string;
  listingStatus: string | null;
  /**
   * `1` = el más viejo según el registro de auditoría ("publicar_en_canal"
   * de esta app). `null` cuando no se encontró un evento de auditoría para
   * ESTE ítem puntual en particular — puede ser una publicación anterior a
   * esta app, o creada por otra vía (ver `recommendedKeep` del grupo).
   */
  createdOrder: number | null;
}

export interface MeliDuplicateGroup {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  /** Todas las publicaciones activas (no cerradas) encontradas para esta misma variante — normalmente 2. */
  items: MeliDuplicateItem[];
  /**
   * `channelProductId` que se recomienda CONSERVAR (el más viejo) — solo se
   * calcula cuando TODOS los ítems del grupo tienen un evento de auditoría
   * propio (así se sabe con certeza que son duplicados creados por esta
   * app, y en qué orden). `null` = no hay recomendación automática
   * confiable; el usuario debe revisar a mano antes de elegir cuál cerrar
   * (ver el caso real de "SOPORTE TÁCTICO PARA CELULAR", que tenía una
   * publicación extra sin evento de auditoría — podía ser una publicación
   * legítima anterior, no necesariamente parte del bug).
   */
  recommendedKeep: string | null;
}

export interface MeliDuplicateCloseOutcome {
  channelProductId: string;
  result: MeliListingCloseResult;
}

// --- Corregir marca por prefijo de SKU (ver meli-brand-fix.ts, @blacksand/sync-engine) ---

/**
 * Caso real que motivó esto: productos con SKU que empieza con "EM"
 * (EmersonGear) quedaron publicados en Mercado Libre con la marca
 * "BLACK SAND SECURITY" (la "Marca por defecto" de Configuración) en vez
 * de su marca real, porque no tenían "Proveedor" cargado en Shopify al
 * momento de publicar.
 */
export interface MeliBrandFixPreviewRow {
  channelProductId: string;
  productId: string | null;
  productName: string;
  sku: string;
  listingStatus: string | null;
  /** Marca leída EN VIVO desde el ítem real de Mercado Libre — no la de la base local. `null` si el ítem no tiene BRAND cargado. */
  currentMeliBrand: string | null;
  /** Si no se pudo leer el ítem (ej. token vencido), el motivo — la fila igual se muestra. */
  readError: string | null;
}

export interface MeliBrandFixItemResult {
  channelProductId: string;
  productName: string;
  sku: string;
  ok: boolean;
  reason?: string;
}

export interface MeliBrandFixRunResult {
  attempted: number;
  fixed: number;
  results: MeliBrandFixItemResult[];
}

// --- Marca automática por prefijo de SKU, para publicaciones NUEVAS (ver matchSkuPrefixBrand, @blacksand/core-domain) ---

/**
 * Distinto de "Corregir marca por prefijo de SKU" (arriba, que corrige
 * publicaciones que YA EXISTEN): esto es la regla permanente que hace que
 * toda publicación NUEVA con ese prefijo de SKU salga con la marca
 * correcta desde el principio, sin depender de que el producto tenga
 * "Proveedor" cargado en Shopify. Pisa cualquier otra fuente de marca
 * (incluido el vendor de Shopify) cuando el SKU matchea.
 */
export interface MeliSkuPrefixBrandOverrideRow {
  id: string;
  skuPrefix: string;
  brand: string;
}

// --- Corregir SKU incorrecto en Mercado Libre (ver meli-sku-fix.ts, @blacksand/sync-engine) ---

/**
 * A pedido directo del usuario ("revisa los productos publicados en ML y
 * corrige los sku que estan con error"), después del fix de LECTURA del
 * SKU (ver `extractSellerSkuAttribute`, @blacksand/connector-mercadolibre)
 * — esto corrige lo que está guardado EN Mercado Libre, no solo cómo la
 * app lo lee. A diferencia de "Corregir marca por prefijo de SKU", el
 * valor correcto no lo elige el usuario: es el SKU que la variante ya
 * tiene en la base local (Shopify).
 */
export interface MeliSkuFixPreviewRow {
  channelProductId: string;
  channelVariantId: string | null;
  productId: string | null;
  productName: string;
  /** SKU correcto — el que ya tiene la variante en la base local (Shopify). */
  expectedSku: string;
  /** SKU real leído EN VIVO desde Mercado Libre. `null` si no se pudo leer (ver `readError`). */
  currentMeliSku: string | null;
  listingStatus: string | null;
  /** Si el ítem ya tiene el atributo SELLER_SKU cargado (a nivel de publicación) — informativo, la corrección lo usa internamente. */
  hasSellerSkuAttribute: boolean;
  mismatched: boolean;
  /** Si no se pudo leer el ítem (ej. token vencido), el motivo — la fila igual se muestra. */
  readError: string | null;
}

export interface MeliSkuFixItemInput {
  channelProductId: string;
  channelVariantId: string | null;
  expectedSku: string;
  productName: string;
  hasSellerSkuAttribute: boolean;
}

export interface MeliSkuFixItemResult {
  channelProductId: string;
  channelVariantId: string | null;
  productName: string;
  expectedSku: string;
  ok: boolean;
  reason?: string;
}

export interface MeliSkuFixRunResult {
  attempted: number;
  fixed: number;
  results: MeliSkuFixItemResult[];
}

// --- Auditoría de Stock (Shopify vs Mercado Libre, ver stock-audit.ts, @blacksand/sync-engine) ---

/**
 * A pedido directo del usuario, caso real: "el inventario de casco wendy en
 * shopify es 9 y en ML es 10, algo pasó, revisalo y corrige". La app no
 * decide sola cuál de los dos números es el correcto (puede ser un ajuste
 * legítimo hecho directo en una plataforma, no necesariamente un bug) — se
 * muestran los tres valores para que el usuario elija cuál aplicar.
 */
export interface StockAuditRow {
  variantId: string;
  productName: string;
  sku: string;
  /** Lo que la base local de la app cree hoy que hay (puede no coincidir con ninguno de los dos canales si ninguno se releyó todavía). */
  localQuantity: number;
  /** Leído EN VIVO desde Shopify. `null` si no se pudo leer (ver `readError`). */
  shopifyQuantity: number | null;
  /** Leído EN VIVO desde Mercado Libre. `null` si no se pudo leer (ver `readError`). */
  meliQuantity: number | null;
  /** `true` solo si los dos valores en vivo se pudieron leer Y no coinciden entre sí. */
  mismatched: boolean;
  readError: string | null;
}

export interface StockAuditApplyResult {
  ok: boolean;
  reason?: string;
  results?: ProductUpdateChannelResult[];
}

// --- Descuentos masivos (ver bulk-discount.ts, @blacksand/sync-engine, y discount.ts, @blacksand/shared) ---

export type DiscountRoundingMode = "none" | "tens" | "ending90";
export type DiscountOnSaleMode = "skip" | "from_price" | "from_compare";
/** Acción de la pantalla "Descuentos": bajar el precio, subirlo (sobre el precio normal guardado), o volver al precio normal guardado. */
export type PriceChangeModeIpc = "discount" | "increase" | "restore";

export interface DiscountPreviewVariant {
  variantGid: string;
  sku: string | null;
  title: string;
  /** Precio actual EN VIVO en Shopify (el que paga el cliente). */
  price: number | null;
  /** Precio de comparación actual EN VIVO (el que la tienda muestra tachado) — `null` si no tiene. */
  compareAtPrice: number | null;
  /** Precio NORMAL guardado en la app (al que se vuelve con "Restaurar"). `null` solo si la variante no tiene precio. */
  baselinePrice: number | null;
}

export interface DiscountPreviewProduct {
  productGid: string;
  title: string;
  /** ACTIVE | DRAFT | ARCHIVED, tal cual lo devuelve Shopify. */
  status: string;
  variants: DiscountPreviewVariant[];
}

export interface DiscountApplyInput {
  productGids: string[];
  mode: PriceChangeModeIpc;
  /** Se ignora cuando `mode` es "restore". */
  percent: number;
  rounding: DiscountRoundingMode;
  onSaleMode: DiscountOnSaleMode;
}

export interface DiscountApplyOutcome {
  productGid: string;
  title: string;
  status: "aplicado" | "omitido" | "error";
  detail: string;
  variantsChanged: number;
}

export interface DiscountApplyResult {
  batchId: string;
  applied: number;
  skipped: number;
  failed: number;
  outcomes: DiscountApplyOutcome[];
}

export interface DiscountBatchRow {
  batchId: string;
  appliedAt: string;
  kind: PriceChangeModeIpc;
  percent: number;
  rounding: DiscountRoundingMode;
  onSaleMode: DiscountOnSaleMode;
  productsApplied: number;
  variantsApplied: number;
  productsReverted: number;
}

/** Un precio normal guardado (una fila por variante de Shopify) — para exportarlos a un archivo de respaldo. */
export interface DiscountBaselineRow {
  variantGid: string;
  productGid: string;
  productTitle: string;
  sku: string | null;
  baselinePrice: number;
}

export interface DiscountRevertOutcome {
  productGid: string;
  title: string;
  status: "revertido" | "omitido" | "error";
  detail: string;
}

export interface DiscountRevertResult {
  batchId: string;
  reverted: number;
  skipped: number;
  failed: number;
  outcomes: DiscountRevertOutcome[];
}

/** Promoción/campaña de Mercado Libre tal como la lista su API (solo lectura). */
export interface MeliPromotionRow {
  id: string;
  type: string | null;
  status: string | null;
  name: string | null;
  startDate: string | null;
  finishDate: string | null;
}

/** Resultado de la prueba de acceso a Promociones de Mercado Libre (solo lectura, no modifica nada). */
export interface MeliPromotionsProbeResult {
  ok: boolean;
  /** Código HTTP que respondió Mercado Libre (200 = hay acceso; 401/403 = falta permiso o token). */
  status: number;
  promotions: MeliPromotionRow[];
  /** Solo si `ok` es false: lo que respondió Mercado Libre. */
  errorBody?: string;
}

/** Estado del worker de sincronización en la nube (su "latido" en la base). `null` = nunca ha corrido. */
export interface CloudWorkerStatus {
  lastRunAt: string;
  /** Segundos desde la última corrida, medidos con el reloj de la base de datos. */
  secondsSinceRun: number;
  lastOkAt: string | null;
  lastSummary: string | null;
  /** Error de la última corrida; `null` si salió bien. */
  lastError: string | null;
}

export interface BlacksandApi {
  dashboard: {
    getSyncStatus(): Promise<DashboardRow[]>;
  };
  channels: {
    getStatus(): Promise<ChannelStatusRow[]>;
    saveShopifyConfig(input: ShopifyConfigInput): Promise<{ ok: true; shopName: string; scopes: string[] }>;
    saveMercadoLibreConfig(input: MercadoLibreConfigInput): Promise<{ ok: true }>;
    startMercadoLibreOAuth(): Promise<{ ok: true }>;
    /**
     * Segundo paso del OAuth de Mercado Libre: Mercado Libre exige que el
     * redirect_uri sea una dirección pública real (rechaza "localhost"), así
     * que no hay servidor local que capture el `code` automáticamente. El
     * usuario pega aquí la URL completa (o solo el `code`) de la página a la
     * que Mercado Libre lo redirige después de autorizar.
     */
    completeMercadoLibreOAuth(pastedUrlOrCode: string): Promise<{ ok: true }>;
    /** Fase 2b: marca por defecto usada al publicar en Mercado Libre cuando el producto no tiene marca propia. */
    getMeliPublishDefaults(): Promise<{ defaultBrand: string | null }>;
    saveMeliPublishDefaults(input: { defaultBrand: string }): Promise<{ ok: true }>;
  };
  products: {
    list(): Promise<ProductRow[]>;
    /**
     * Fase 2a: edita SKU/precio/stock de una variante ya existente y la
     * empuja de inmediato a los canales donde ya está mapeada. No crea
     * publicaciones nuevas en ningún canal.
     */
    update(input: ProductUpdateInput): Promise<ProductUpdateResult>;
    /** "Crear producto": abre el selector nativo de archivos para elegir fotos — devuelve las rutas locales elegidas (o `[]` si el usuario canceló). */
    pickImages(): Promise<string[]>;
    /** "Crear producto": crea el producto en Shopify (y en Mercado Libre en el mismo acto, si la categoría del grupo ya está confirmada) y lo guarda en el catálogo central. */
    createAndPublish(input: CreateProductInput): Promise<CreateProductResult>;
    /**
     * Elimina un producto del catálogo central (y en cascada sus variantes,
     * stock y mapeos de canal) — SOLO borra el registro local de la app,
     * nunca llama a Shopify ni a Mercado Libre. Pensado para productos
     * "fantasma" que quedaron en la base sin existir de verdad en ningún
     * canal (ver `deleteProduct` en @blacksand/db).
     *
     * Si el producto tiene pedidos en su historial y `force` no es `true`,
     * NO borra nada — devuelve `{ deleted: false, reason: "has_history",
     * channels, orderCount }` para que la UI muestre una advertencia
     * concreta (en qué plataforma(s) hay ventas y cuántos pedidos) antes de
     * decidir. Si el usuario confirma igual, se vuelve a llamar con
     * `force: true`: ahí sí borra, después de copiar el SKU/nombre de cada
     * línea de pedido afectada a un snapshot (para que el historial de
     * pedidos siga siendo legible aunque el producto ya no exista).
     */
    delete(productId: string, force?: boolean): Promise<ProductDeleteResult>;
  };
  reconciliation: {
    listPending(): Promise<ReconciliationRow[]>;
    confirmMatch(mapId: string, centralVariantId: string): Promise<{ ok: true }>;
    ignore(mapId: string): Promise<{ ok: true }>;
  };
  audit: {
    list(): Promise<AuditRow[]>;
  };
  sync: {
    runImportNow(channel: "shopify" | "mercadolibre"): Promise<ImportResult>;
    /**
     * Fase 3a: sondea pedidos nuevos en los canales conectados y descuenta
     * stock (botón manual — el scheduler ya lo hace solo cada N minutos).
     * `customLookbackHours` (opcional, bug #1151): catch-up explícito para
     * revisar más atrás que el checkpoint automático — ej. "revisar los
     * últimos 30 días" si se sospecha que se perdió un pedido viejo.
     */
    runOrderPollNow(customLookbackHours?: number): Promise<OrderIngestSummaryRow[]>;
  };
  orders: {
    /** Fase 3a/3b: últimos pedidos (de canal o mostrador), para el Dashboard. */
    listRecent(): Promise<RecentOrderRow[]>;
    /** Fase 3c: pedidos cancelados pendientes de que el usuario decida "reponer"/"no reponer". */
    listPendingCancellations(): Promise<PendingCancellationRow[]>;
    /** Fase 3c: resuelve a mano un pedido cancelado pendiente — ajusta stock (si corresponde) y lo empuja a todos los canales mapeados. */
    resolveCancellation(orderId: string, restocked: boolean): Promise<{ ok: true }>;
    /** Fase 3e: rellena `orderNumber` (el correlativo de la tienda) para pedidos que ya estaban en la app antes de que ese campo existiera. */
    backfillOrderNumbers(): Promise<BackfillOrderNumbersResult>;
    /** Fase 3g: reintenta el push de stock de un pedido puntual (con `syncStatus` "error" o "pendiente") hacia los demás canales. No vuelve a tocar el inventario local, solo reintenta la comunicación con los canales. */
    retrySync(orderId: string): Promise<RetryOrderSyncResult>;
  };
  pos: {
    /** Fase 3b: registra una venta de mostrador — descuenta stock y lo empuja a todos los canales mapeados. */
    registerSale(input: PosSaleInput): Promise<PosSaleResult>;
  };
  meliPublish: {
    /** Fase 2b: grupos de productos de Shopify sin publicar en Mercado Libre, agrupados por categoría central. */
    listCandidateGroups(): Promise<MeliPublishGroupRow[]>;
    /**
     * Predice la categoría de Mercado Libre para un grupo (o busca otra con
     * `customQuery`) y trae los atributos que necesitan una decisión.
     * `includeAllPaths` (default `false`): trae el camino completo
     * (`categoryPath`) para TODAS las alternativas del selector, no solo la
     * elegida — úsalo en la pantalla "Revisar categoría" (un grupo a la
     * vez), NO en "Publicar todo automáticamente" (que llama esto en
     * cadena por cada grupo pendiente y solo usa `predictions[0]`).
     */
    previewCategory(groupKey: string, customQuery?: string, includeAllPaths?: boolean): Promise<MeliCategoryPreviewResult>;
    /** Guarda la categoría/atributos confirmados para un grupo — se reusa para todos los productos de ese grupo al publicar. */
    confirmGroupMapping(input: MeliConfirmGroupMappingInput): Promise<{ ok: true }>;
    /** Publica hasta `limit` productos del grupo indicado ("all" = todos los grupos ya confirmados). */
    runBatch(groupKey: string, limit: number): Promise<MeliPublishBatchResult>;
    getListingTypes(): Promise<MeliListingTypeRow[]>;
    /**
     * Copia la descripción actual de Shopify a TODOS los productos que ya
     * están publicados en Mercado Libre (no solo los recién publicados) —
     * cubre tanto las publicaciones creadas antes de que existiera este
     * paso como cambios posteriores en la descripción de Shopify. También
     * corre solo en segundo plano cada cierto tiempo (`main/index.ts`);
     * esto es para forzarlo de inmediato desde la pantalla.
     */
    syncDescriptions(): Promise<MeliDescriptionSyncResult>;
    /** Lista las palabras clave -> categoría que el usuario guardó a mano (pantalla "Categorías por palabra clave"). */
    listKeywordOverrides(): Promise<MeliKeywordOverrideRow[]>;
    /** Guarda (o reemplaza) la categoría verificada a mano para una palabra clave. */
    saveKeywordOverride(input: { keyword: string; categoryId: string; categoryName: string }): Promise<{ ok: true }>;
    deleteKeywordOverride(id: string): Promise<{ ok: true }>;
    /** Busca categorías de Mercado Libre por texto libre — para encontrar la categoría real antes de guardarla como palabra clave. */
    searchCategories(query: string): Promise<MeliCategorySearchResultRow[]>;
    /** Trae la predicción de categoría de TODOS los grupos pendientes de una vez, para revisarlos y confirmarlos en una sola pantalla ("Revisión masiva de categorías") en vez de uno por uno. */
    previewAllPendingCategories(): Promise<MeliBulkCategoryPreviewRow[]>;
  };
  meliListing: {
    /** Estado real (activa/pausada/cerrada/...) de cada publicación de Mercado Libre que la app conoce — pantalla "Estado en Mercado Libre". */
    listIssues(): Promise<MeliListingIssueRow[]>;
    /** Reactiva una publicación pausada (`PUT /items/{id}` status=active) — no se ofrece para publicaciones cerradas, ver el comentario en `reactivateMeliListing` (@blacksand/sync-engine). */
    reactivate(channelProductId: string): Promise<MeliListingReactivateResult>;
    /** "Eliminar publicación" — en realidad la CIERRA en Mercado Libre (`PUT /items/{id}` status=closed); no hay borrado permanente vía API. Ver `closeMeliListing` (@blacksand/sync-engine). */
    close(channelProductId: string): Promise<MeliListingCloseResult>;
  };
  meliDuplicateFix: {
    /** Agrupa, por variante local, las publicaciones de Mercado Libre que quedaron duplicadas (ver el comentario grande en `MeliDuplicateGroup`) — sin tocar nada todavía. */
    preview(): Promise<MeliDuplicateGroup[]>;
    /** Cierra (ver `closeMeliListing`) cada `channelProductId` que el usuario eligió en la pantalla de revisión. */
    close(channelProductIds: string[]): Promise<MeliDuplicateCloseOutcome[]>;
  };
  meliBrandFix: {
    /** Busca publicaciones de Mercado Libre cuyo SKU empiece con `skuPrefix` y lee su marca actual (en vivo, desde la API) — para revisar antes de corregir nada. */
    preview(skuPrefix: string): Promise<MeliBrandFixPreviewRow[]>;
    /** Corrige el atributo BRAND en Mercado Libre para esos productos; si `updateLocalBrand`, también actualiza `Product.brand` en la base local. */
    run(skuPrefix: string, newBrand: string, updateLocalBrand: boolean): Promise<MeliBrandFixRunResult>;
  };
  meliSkuPrefixBrand: {
    /** Reglas de marca fija por prefijo de SKU, para toda publicación NUEVA de ahora en adelante (no corrige lo ya publicado — para eso, `meliBrandFix`). */
    list(): Promise<MeliSkuPrefixBrandOverrideRow[]>;
    save(input: { skuPrefix: string; brand: string }): Promise<{ ok: true }>;
    delete(id: string): Promise<{ ok: true }>;
  };
  meliSkuFix: {
    /** Escanea TODAS las publicaciones de Mercado Libre ya emparejadas a un producto central y compara, en vivo, su SKU real contra el SKU correcto (Shopify) — sin pedir ningún dato al usuario. */
    preview(): Promise<MeliSkuFixPreviewRow[]>;
    /** Corrige el SKU en Mercado Libre para las filas indicadas (normalmente, las que `preview` marcó `mismatched: true`). */
    run(items: MeliSkuFixItemInput[]): Promise<MeliSkuFixRunResult>;
  };
  stockAudit: {
    /** Lee EN VIVO el stock de Shopify y de Mercado Libre para cada variante publicada en ambos canales, y compara contra lo que la app tiene guardado localmente. */
    preview(): Promise<StockAuditRow[]>;
    /** Aplica `quantity` como el valor correcto: lo guarda en local y lo empuja a Shopify y Mercado Libre (reusa el mismo camino que "Guardar" en Productos). */
    apply(variantId: string, quantity: number): Promise<StockAuditApplyResult>;
  };
  discount: {
    /** Catálogo completo EN VIVO de Shopify con precio y precio de comparación de cada variante. */
    preview(): Promise<DiscountPreviewProduct[]>;
    /** Aplica el descuento a los productos elegidos: precio actual → precio de comparación, y precio nuevo = actual − porcentaje. Recalcula todo con datos frescos de Shopify (no usa los números de la vista previa). */
    apply(input: DiscountApplyInput): Promise<DiscountApplyResult>;
    /** Historial de cambios de precio aplicados, del más reciente al más viejo. */
    listBatches(): Promise<DiscountBatchRow[]>;
    /** Todos los precios normales guardados (una fila por variante) — para el respaldo en archivo. */
    listBaselines(): Promise<DiscountBaselineRow[]>;
    /** Restaura precio y precio de comparación de antes del descuento (solo variantes cuyo precio sigue siendo el del descuento). */
    revert(batchId: string): Promise<DiscountRevertResult>;
  };
  shipping: {
    getStatus(): Promise<ShippingGmailStatus>;
    /** Guarda el ID de cliente y el secreto de la app de Google Cloud del usuario (el secreto va a la bóveda). */
    saveGoogleClient(input: { clientId: string; clientSecret: string }): Promise<ShippingGmailStatus>;
    /** Abre el navegador para autorizar el acceso de SOLO LECTURA a Gmail; resuelve cuando el usuario termina. */
    connectGmail(): Promise<ShippingGmailStatus>;
    disconnectGmail(): Promise<ShippingGmailStatus>;
    /** Lee los correos nuevos de Blue Express / Mercado Libre y registra los días de despacho. */
    sync(): Promise<ShippingSyncResult>;
    getMonth(year: number, month: number): Promise<ShippingMonthSummaryDto>;
    /** `dispatched = null` quita el ajuste manual de ese día. */
    setDayOverride(day: string, dispatched: boolean | null, note?: string | null): Promise<{ ok: true }>;
    setDailyRate(rate: number): Promise<{ ok: true }>;
  };
  cloudWorker: {
    /** Cuándo corrió por última vez el worker de sincronización en la nube y si salió bien. */
    getStatus(): Promise<CloudWorkerStatus | null>;
  };
  meliPromotions: {
    /** SOLO LECTURA: consulta las promociones de la cuenta de Mercado Libre para comprobar que la app tiene acceso al área de Promociones. */
    probe(): Promise<MeliPromotionsProbeResult>;
  };
}

export interface ShippingGmailStatus {
  clientConfigured: boolean;
  clientId: string | null;
  connected: boolean;
  email: string | null;
  lastSyncAt: string | null;
  dailyRate: number;
}

export interface ShippingSyncResult {
  /** Correos que coinciden con la búsqueda en Gmail. */
  found: number;
  /** De esos, cuántos no se habían leído antes. */
  newEmails: number;
  /** Cuántos resultaron ser comprobantes de despacho válidos. */
  newEvents: number;
  ignored: number;
  syncedAt: string;
}

export interface ShippingDayDto {
  day: string; // YYYY-MM-DD
  dispatched: boolean;
  fromEmails: boolean;
  carriers: ("BLUE_EXPRESS" | "MERCADO_LIBRE")[];
  packages: number;
  /** Detalle por correo: transportista, paquetes y números de orden de servicio (BX) / de venta (ML). */
  events: { carrier: "BLUE_EXPRESS" | "MERCADO_LIBRE"; packages: number; refs: string[] }[];
  override: boolean | null;
  note: string | null;
}

export interface ShippingMonthSummaryDto {
  year: number;
  month: number;
  daysInMonth: number;
  dispatchedDays: number;
  dailyRate: number;
  amount: number;
  days: ShippingDayDto[];
}

export const IPC_CHANNELS = {
  dashboardGetSyncStatus: "dashboard:getSyncStatus",
  channelsGetStatus: "channels:getStatus",
  channelsSaveShopifyConfig: "channels:saveShopifyConfig",
  channelsSaveMercadoLibreConfig: "channels:saveMercadoLibreConfig",
  channelsStartMercadoLibreOAuth: "channels:startMercadoLibreOAuth",
  channelsCompleteMercadoLibreOAuth: "channels:completeMercadoLibreOAuth",
  productsList: "products:list",
  productsUpdate: "products:update",
  productsPickImages: "products:pickImages",
  productsCreateAndPublish: "products:createAndPublish",
  productsDelete: "products:delete",
  reconciliationListPending: "reconciliation:listPending",
  reconciliationConfirmMatch: "reconciliation:confirmMatch",
  reconciliationIgnore: "reconciliation:ignore",
  auditList: "audit:list",
  syncRunImportNow: "sync:runImportNow",
  syncRunOrderPollNow: "sync:runOrderPollNow",
  ordersListRecent: "orders:listRecent",
  ordersListPendingCancellations: "orders:listPendingCancellations",
  ordersResolveCancellation: "orders:resolveCancellation",
  ordersBackfillOrderNumbers: "orders:backfillOrderNumbers",
  ordersRetrySync: "orders:retrySync",
  posRegisterSale: "pos:registerSale",
  channelsGetMeliPublishDefaults: "channels:getMeliPublishDefaults",
  channelsSaveMeliPublishDefaults: "channels:saveMeliPublishDefaults",
  meliPublishListCandidateGroups: "meli:publishListCandidateGroups",
  meliPublishPreviewCategory: "meli:publishPreviewCategory",
  meliPublishConfirmGroupMapping: "meli:publishConfirmGroupMapping",
  meliPublishRunBatch: "meli:publishRunBatch",
  meliGetListingTypes: "meli:getListingTypes",
  meliSyncDescriptions: "meli:syncDescriptions",
  meliPublishListKeywordOverrides: "meli:publishListKeywordOverrides",
  meliPublishSaveKeywordOverride: "meli:publishSaveKeywordOverride",
  meliPublishDeleteKeywordOverride: "meli:publishDeleteKeywordOverride",
  meliPublishSearchCategories: "meli:publishSearchCategories",
  meliPublishPreviewAllPendingCategories: "meli:publishPreviewAllPendingCategories",
  meliListingListIssues: "meli:listingListIssues",
  meliListingReactivate: "meli:listingReactivate",
  meliListingClose: "meli:listingClose",
  meliDuplicateFixPreview: "meli:duplicateFixPreview",
  meliDuplicateFixClose: "meli:duplicateFixClose",
  meliBrandFixPreview: "meli:brandFixPreview",
  meliBrandFixRun: "meli:brandFixRun",
  meliSkuPrefixBrandList: "meli:skuPrefixBrandList",
  meliSkuPrefixBrandSave: "meli:skuPrefixBrandSave",
  meliSkuPrefixBrandDelete: "meli:skuPrefixBrandDelete",
  meliSkuFixPreview: "meli:skuFixPreview",
  meliSkuFixRun: "meli:skuFixRun",
  stockAuditPreview: "stockAudit:preview",
  stockAuditApply: "stockAudit:apply",
  discountPreview: "discount:preview",
  discountApply: "discount:apply",
  discountListBatches: "discount:listBatches",
  discountListBaselines: "discount:listBaselines",
  discountRevert: "discount:revert",
  meliPromotionsProbe: "meliPromotions:probe",
  cloudWorkerStatus: "cloudWorker:status",
  shippingGetStatus: "shipping:getStatus",
  shippingSaveGoogleClient: "shipping:saveGoogleClient",
  shippingConnectGmail: "shipping:connectGmail",
  shippingDisconnectGmail: "shipping:disconnectGmail",
  shippingSync: "shipping:sync",
  shippingGetMonth: "shipping:getMonth",
  shippingSetDayOverride: "shipping:setDayOverride",
  shippingSetDailyRate: "shipping:setDailyRate",
} as const;
