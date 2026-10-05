import type {
  MeliNormalizedItem,
  MeliNormalizedOrder,
  MeliCategoryPrediction,
  MeliCategoryAttribute,
  MeliListingType,
  MeliCreateItemInput,
  MeliCreateItemResult,
} from "./types.js";
import type { SyncErrorCode } from "@blacksand/shared";

const API_BASE = "https://api.mercadolibre.com";

export class MeliApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MeliApiError";
  }
}

/**
 * Humaniza errores CONOCIDOS y repetibles de la API de Mercado Libre, para
 * que el Dashboard/las pantallas de "Publicar en ML" muestren un motivo
 * accionable en vez del JSON crudo de la API. Caso real que motivó esto: un
 * pedido vendido mientras la publicación de ese producto en Mercado Libre
 * estaba "en revisión" (`under_review`) — Mercado Libre respondió 400 con
 * `code: "field_not_updatable"` al intentar actualizar `available_quantity`
 * ("Cannot update item MLC... [status:under_review, has_bids:false]"). No es
 * un bug de la app: es una restricción REAL y temporal de Mercado Libre
 * mientras dura la revisión (normalmente minutos a pocas horas) — el resto
 * de la publicación puede o no aceptar cambios, pero el campo bloqueado
 * específico no, hasta que la revisión termine. Reintentar más tarde (botón
 * "Reintentar" del Dashboard, que reusa el mismo mecanismo) alcanza, no hace
 * falta ningún cambio en el producto ni en la publicación.
 *
 * Si el mensaje no calza con este ni otro caso conocido, se devuelve TAL
 * CUAL vino de la API — mismo criterio que el resto del proyecto: nunca
 * ocultar un error nuevo/no identificado, solo aclarar los ya vistos en
 * vivo.
 *
 * IMPORTANTE: el mensaje traducido SIEMPRE incluye el ID de la publicación
 * (ej. "MLC4479066270") cuando la API lo trae — se descartaba en la
 * primera versión de este helper, y eso le impedía al usuario identificar
 * CUÁL publicación puntual está bloqueada cuando un pedido tiene varios
 * productos (`summarizePushErrors` además deduplica mensajes idénticos, así
 * que sin el ID dos publicaciones DISTINTAS con el mismo motivo se veían
 * como un solo error genérico en vez de dos).
 *
 * A pedido del usuario, ahora devuelve además un `code` corto (catálogo en
 * `@blacksand/shared`, `sync-error-codes.ts`) — la UI lo usa para mostrar
 * un badge compacto en las tablas en vez del texto completo, que queda
 * disponible aparte como `message` (se abre a pedido, no siempre visible).
 * El caso "en revisión" usa el código `EN_REVISION`; cualquier otro error
 * (de Mercado Libre no identificado, o de Shopify, que se resuelve en
 * `push.ts`) cae en el genérico `ERROR`.
 */
export interface DescribedMeliError {
  code: SyncErrorCode;
  message: string;
}

export function describeMeliError(err: unknown): DescribedMeliError {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof MeliApiError)) return { code: "ERROR", message };

  /**
   * Bug real reportado por el usuario (SKU EM7405MC, ronda 5): Mercado
   * Libre respondió 403 con `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` /
   * `"blocked_by":"PolicyAgent"` al intentar actualizar el stock de esta
   * publicación puntual. Esto NO es un error de autenticación normal (401,
   * token vencido) ni un 400 de validación — es una capa interna de
   * autorización de Mercado Libre ("PolicyAgent") que puede bloquear una
   * llamada de API concreta por una política de cuenta/publicación/
   * categoría que la propia API no explica en el mensaje de error. Está
   * documentado de forma muy pobre incluso por fuera de esta app —
   * desarrolladores externos reportan el mismo código en otros endpoints
   * (marcas, specs técnicos) sin que Mercado Libre aclare públicamente la
   * causa exacta. No hay ningún fix de código posible acá: no es un bug de
   * la app, es una decisión del lado de Mercado Libre — lo único que se
   * puede hacer es dejar de mostrar el JSON crudo y dar una pista clara de
   * dónde revisar.
   */
  if (err.status === 403 && /PA_UNAUTHORIZED_RESULT_FROM_POLICIES|PolicyAgent/i.test(message)) {
    return {
      code: "BLOQUEADO_POLITICA",
      message:
        "Mercado Libre bloqueó esta actualización por una política interna de la cuenta o de la " +
        "publicación (\"PolicyAgent\") — no es un error de la app ni del token. Suele deberse a una " +
        "restricción de la cuenta, de la categoría, o de la publicación puntual que Mercado Libre no " +
        "explica en el mensaje. Revisá esta publicación en el panel de Mercado Libre (mercadolibre.cl) " +
        "por si muestra algún aviso, y probá editar el stock de ahí directamente: si el panel también lo " +
        "rechaza, es una restricción de la cuenta o la publicación (no de la app) y hay que resolverla con " +
        "Soporte de Mercado Libre; si el panel SÍ lo permite pero la API sigue fallando, puede hacer falta " +
        "reconectar/reautorizar la app en Configuración.",
    };
  }

  if (err.status !== 400) return { code: "ERROR", message };

  if (/field_not_updatable/i.test(message) && /under_review/i.test(message)) {
    const fieldMatch = message.match(/"references"\s*:\s*\[\s*"([^"]+)"/);
    const field = fieldMatch ? fieldMatch[1] : "este campo";
    const itemMatch = message.match(/Cannot update item\s+(\S+)\s*\[/i);
    const itemLabel = itemMatch ? ` (publicación ${itemMatch[1]})` : "";
    return {
      code: "EN_REVISION",
      message:
        `Mercado Libre no permite modificar "${field}"${itemLabel} ahora mismo: la publicación ` +
        `está "en revisión" (under_review). Es una restricción temporal de Mercado Libre, no un ` +
        `error de la app — espera a que la revisión termine (normalmente minutos a pocas horas) ` +
        `y usa "Reintentar".`,
    };
  }

  return { code: "ERROR", message };
}

/** Resumen de una promoción/campaña tal como la lista Mercado Libre (solo campos que usamos). */
export interface MeliPromotionSummary {
  id: string;
  type: string | null;
  status: string | null;
  name: string | null;
  startDate: string | null;
  finishDate: string | null;
}

export interface MeliPromotionsProbeResult {
  ok: boolean;
  status: number;
  promotions: MeliPromotionSummary[];
  /** Solo si `ok` es false: lo que respondió Mercado Libre (recortado). */
  errorBody?: string;
}

interface MeliItemResponse {
  id: string;
  title: string;
  status: string;
  sub_status?: string[];
  price: number;
  available_quantity: number;
  category_id: string;
  seller_custom_field: string | null;
  pictures: { url: string }[];
  variations: Array<{
    id: number;
    available_quantity: number;
    // `id` (ej. "COLOR", "SIZE", o a veces "SELLER_SKU" — ver
    // `extractSellerSkuAttribute` más abajo) SÍ viene en la respuesta real
    // de la API aunque antes no se leía; se agrega para poder buscar el
    // SKU declarado como atributo cuando `seller_custom_field` viene vacío
    // (ver el comentario grande en `extractSellerSkuAttribute`).
    attribute_combinations: { id?: string; name: string; value_name: string | null }[];
    seller_custom_field?: string | null;
  }>;
  attributes?: { id: string; value_name: string | null }[];
}

/**
 * Bug real reportado por el usuario (SKU EM9724MC): la app mostraba
 * "meli-MLC4476818972-0" en vez del SKU real ("EM9724MC", el mismo que en
 * Shopify y en el propio panel de Mercado Libre) para varias publicaciones.
 * Causa raíz: Mercado Libre tiene DOS lugares distintos donde puede vivir
 * el SKU del vendedor — el campo clásico `seller_custom_field` (lo único
 * que este cliente leía hasta ahora) y, para publicaciones más nuevas o
 * editadas desde el panel actual de Mercado Libre, un ATRIBUTO de la
 * categoría con `id: "SELLER_SKU"` dentro de `attributes` (a nivel de la
 * publicación) o `attribute_combinations` (a nivel de cada variación).
 * Cuando el SKU vive solo en el atributo, `seller_custom_field` viene
 * `null` en la respuesta de la API — aunque el panel de Mercado Libre le
 * muestre igual "SKU: EM9724MC" al vendedor (lo lee de ahí). Sin este
 * fallback, el importador (`@blacksand/sync-engine/importer.ts`) no
 * encontraba ningún SKU real para emparejar contra el producto ya
 * existente (creado desde Shopify con ese mismo SKU) y terminaba creando
 * un producto "fantasma" nuevo con un SKU inventado
 * (`meli-<id>-<variación>`) en vez de reconocer la publicación como el
 * mismo producto. Documentado por Mercado Libre: developers.mercadolibre.com.ar
 * ("Items & Searches" — búsqueda por `seller_custom_field` vs. por el
 * atributo `SELLER_SKU`, dos mecanismos distintos y no intercambiables).
 */
function extractSellerSkuAttribute(attributes: { id?: string; value_name: string | null }[] | undefined): string | null {
  if (!attributes) return null;
  const found = attributes.find((a) => a.id === "SELLER_SKU");
  return found?.value_name ?? null;
}

/**
 * Cliente mínimo de la API REST (sección B.2). Fase 1: solo lectura
 * (búsqueda de publicaciones del vendedor autenticado + detalle de cada item).
 */
export class MercadoLibreClient {
  private accessToken: string;

  /**
   * `onUnauthorized` (opcional): si Mercado Libre responde 401 (access_token
   * vencido o invalidado — dura 6 h, no se puede alargar), el cliente le pide
   * a la app un token nuevo (renovándolo con el refresh_token), actualiza el
   * suyo y REINTENTA la misma llamada UNA vez, sin que el usuario note nada.
   * Recibe el token que falló para que quien renueva pueda detectar que otro
   * proceso ya lo renovó (el refresh_token es de un solo uso) y no gastarlo
   * dos veces. Devuelve el access_token nuevo, o `undefined` si no se pudo.
   */
  constructor(
    accessToken: string,
    private readonly onUnauthorized?: (failedAccessToken: string) => Promise<string | undefined>,
  ) {
    this.accessToken = accessToken;
  }

  /**
   * Toda llamada HTTP a la API pasa por acá: agrega el token y, ante un 401,
   * renueva el token y reintenta una sola vez (los cuerpos son strings, así
   * que se pueden reenviar tal cual). Cualquier otro status se devuelve sin
   * tocar — el manejo de errores sigue igual que antes en cada método.
   */
  private async authedFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const send = () =>
      fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.accessToken}` } });
    const first = await send();
    if (first.status !== 401 || !this.onUnauthorized) return first;

    const failedToken = this.accessToken;
    let fresh: string | undefined;
    try {
      fresh = await this.onUnauthorized(failedToken);
    } catch {
      return first;
    }
    if (!fresh) return first;
    this.accessToken = fresh;
    return send();
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.authedFetch(`${API_BASE}${path}`, {});
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MeliApiError(`Mercado Libre respondió ${response.status}: ${body}`, response.status);
    }
    return (await response.json()) as T;
  }

  /** Fase 2a: escritura (PUT /items/{id} y variantes) — Fase 1 solo usaba `get`. */
  private async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.authedFetch(`${API_BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new MeliApiError(
        `Mercado Libre respondió ${response.status} al actualizar: ${responseBody}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** Fase 2b: escritura de creación (POST) — devuelve el body también en el caso de error, porque ahí es donde Mercado Libre explica qué atributo/categoría rechazó. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.authedFetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = await response.text().catch(() => "");
    if (!response.ok) {
      throw new MeliApiError(`Mercado Libre respondió ${response.status}: ${responseBody}`, response.status);
    }
    return responseBody ? (JSON.parse(responseBody) as T) : (undefined as T);
  }

  /** Fase 2a: actualiza el precio de una publicación existente. */
  async updateItemPrice(itemId: string, price: number): Promise<void> {
    await this.put(`/items/${itemId}`, { price });
  }

  /**
   * Fase 2a: actualiza stock y/o SKU (seller_custom_field) de una publicación
   * existente o de una de sus variaciones. Si `variationId` viene, el cambio
   * se aplica dentro de `variations: [...]` (formato que exige la API de ML
   * para publicaciones con variaciones); si no, se aplica sobre el item
   * directamente.
   */
  async updateItemStockAndSku(
    itemId: string,
    variationId: string | null,
    patch: { availableQuantity?: number; sku?: string },
  ): Promise<void> {
    if (patch.availableQuantity === undefined && patch.sku === undefined) return;

    if (variationId) {
      const variation: Record<string, unknown> = { id: Number(variationId) };
      if (patch.availableQuantity !== undefined) variation.available_quantity = patch.availableQuantity;
      if (patch.sku !== undefined) variation.seller_custom_field = patch.sku;
      await this.put(`/items/${itemId}`, { variations: [variation] });
      return;
    }

    const body: Record<string, unknown> = {};
    if (patch.availableQuantity !== undefined) body.available_quantity = patch.availableQuantity;
    if (patch.sku !== undefined) body.seller_custom_field = patch.sku;
    await this.put(`/items/${itemId}`, body);
  }

  async getAuthorizedUserId(): Promise<number> {
    const me = await this.get<{ id: number }>("/users/me");
    return me.id;
  }

  /**
   * SOLO LECTURA — prueba de acceso al área de Promociones de Mercado Libre
   * (`GET /seller-promotions/users/{id}?app_version=v2`): lista las
   * promociones/campañas que la cuenta tiene o a las que puede unirse.
   *
   * No lanza error ante un rechazo de la API: devuelve `ok:false` con el
   * status y el texto que respondió Mercado Libre, porque justamente lo que
   * se quiere averiguar es SI el token/la app tienen permiso (un 403/401 es
   * una respuesta útil, no una falla). No modifica nada en Mercado Libre.
   */
  async probeSellerPromotions(userId: number): Promise<MeliPromotionsProbeResult> {
    const response = await this.authedFetch(`${API_BASE}/seller-promotions/users/${userId}?app_version=v2`, {});
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, status: response.status, promotions: [], errorBody: text.slice(0, 600) };
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: response.status, promotions: [], errorBody: `Respuesta no es JSON: ${text.slice(0, 300)}` };
    }
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { results?: unknown[] } | null)?.results)
        ? ((parsed as { results: unknown[] }).results)
        : [];
    const promotions = rawList.map((entry): MeliPromotionSummary => {
      const p = (entry ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
      return {
        id: str(p.id) ?? "",
        type: str(p.type),
        status: str(p.status),
        name: str(p.name),
        startDate: str(p.start_date),
        finishDate: str(p.finish_date),
      };
    });
    return { ok: true, status: response.status, promotions };
  }

  /**
   * IDs de todas las publicaciones del vendedor, en CUALQUIER estado
   * (paginado por offset, un `status` a la vez).
   *
   * Antes esto pedía `/users/{id}/items/search` SIN filtro de `status` —
   * la documentación pública de Mercado Libre no dice con claridad qué
   * trae ese endpoint por defecto cuando no se especifica, y el caso real
   * que motivó este cambio es justo encontrar publicaciones PAUSADAS o
   * CERRADAS (algunas cerradas automáticamente por Mercado Libre después
   * de publicarlas, ej. por datos incompletos) — si el default resultaba
   * ser "solo activas", esas publicaciones quedaban invisibles para
   * siempre en la app aunque el usuario ya las hubiera arreglado. Para no
   * depender de un comportamiento no documentado, se pide cada estado
   * conocido de forma explícita y se juntan los ids sin duplicados. Esto
   * multiplica las llamadas de LISTADO (baratas, 50 ids por página) pero
   * no las de detalle (`getItem` se sigue llamando una vez por id único).
   */
  async listAllItemIds(sellerId: number): Promise<string[]> {
    const statuses = ["active", "paused", "closed", "under_review", "inactive", "payment_required"];
    const ids = new Set<string>();
    for (const status of statuses) {
      let offset = 0;
      const limit = 50;
      for (;;) {
        const page = await this.get<{ results: string[]; paging: { total: number } }>(
          `/users/${sellerId}/items/search?limit=${limit}&offset=${offset}&status=${status}`,
        );
        for (const id of page.results) ids.add(id);
        offset += limit;
        if (offset >= page.paging.total || page.results.length === 0) break;
      }
    }
    return [...ids];
  }

  /**
   * Cambia el estado de una publicación existente — `PUT /items/{id}` con
   * `status`. Documentado por Mercado Libre para "active"/"paused"/"closed".
   *
   * OJO — la dirección importa, no es simétrico:
   * - Ir HACIA "closed" (cerrar/"eliminar" una publicación, a pedido del
   *   usuario: "necesito que la app también me permita borrar publicaciones
   *   de ML directamente desde la app") es la operación estándar y siempre
   *   documentada — Mercado Libre NO expone un DELETE real de publicaciones
   *   para una cuenta con historial; "cerrar" es el equivalente funcional
   *   (deja de estar visible/comprable) y es lo que usa
   *   `closeMeliListing` (@blacksand/sync-engine/meli-listing-status.ts).
   * - Ir DESDE "closed" hacia "active" (reactivar) NO siempre funciona así
   *   de simple (depende del motivo del cierre) — en ese caso Mercado Libre
   *   responde con un error claro, que el llamador debe mostrar tal cual en
   *   vez de asumir que "reactivar" siempre funciona (ver `reactivateMeliListing`).
   */
  async updateItemStatus(itemId: string, status: "active" | "paused" | "closed"): Promise<void> {
    await this.put(`/items/${itemId}`, { status });
  }

  /**
   * Corrige UN atributo puntual (por `id`) de una publicación YA EXISTENTE
   * — generaliza lo que antes era código exclusivo de `updateItemBrand`
   * (mismo `PUT /items/{id}` con `attributes: [{id, value_name}]`), para
   * poder reusarlo también al corregir el atributo `SELLER_SKU` (ver
   * "Corregir SKU incorrecto en Mercado Libre",
   * `@blacksand/sync-engine/meli-sku-fix.ts`).
   *
   * A diferencia de `tags` (ver `updateItemStockAndSku` más arriba — ESE
   * sí reemplaza el array completo, confirmado en vivo con un error real),
   * la documentación de Mercado Libre describe `attributes` en un
   * `PUT /items/{id}` como una actualización por `id`: solo se toca el
   * atributo que se manda, el resto de la publicación (color, talla,
   * imágenes, etc.) queda igual. Esto SIGUE SIN VERIFICARSE contra esta
   * cuenta puntual para ningún atributo salvo BRAND (no hay acceso a la
   * API en vivo desde este entorno de desarrollo, y esta cuenta ya mostró
   * comportamiento no estándar antes con el modelo "User Products"/
   * `family_name`) — por eso cualquier pantalla que use esto ofrece probar
   * con 1-2 publicaciones primero y revisar en el panel de Mercado Libre
   * que nada más se haya movido, antes de correrlo contra todo un lote.
   */
  async updateItemAttribute(itemId: string, attributeId: string, valueName: string): Promise<void> {
    await this.put(`/items/${itemId}`, { attributes: [{ id: attributeId, value_name: valueName }] });
  }

  /**
   * Corrige el atributo BRAND de una publicación YA EXISTENTE — ver el
   * comentario grande en `updateItemAttribute` arriba (mismo mecanismo,
   * generalizado desde esta función). Caso real que motivó esto: varios
   * productos con SKU que empieza con "EM" (EmersonGear) quedaron
   * publicados con la "Marca por defecto" de Configuración ("BLACK SAND
   * SECURITY") en vez de su marca real, porque esos productos no tenían el
   * campo "Proveedor" (vendor) cargado en Shopify al momento de publicar
   * (`buildCreateItemPayload`, @blacksand/core-domain, usa `product.brand`
   * y solo cae al default de grupo cuando viene vacío).
   */
  async updateItemBrand(itemId: string, brandValueName: string): Promise<void> {
    await this.updateItemAttribute(itemId, "BRAND", brandValueName);
  }

  async getItem(itemId: string): Promise<MeliNormalizedItem> {
    const item = await this.get<MeliItemResponse>(`/items/${itemId}`);
    return {
      channelProductId: item.id,
      title: item.title,
      status: item.status,
      subStatus: item.sub_status ?? [],
      price: item.price ?? null,
      availableQuantity: item.available_quantity ?? null,
      // Ver `extractSellerSkuAttribute` arriba — `seller_custom_field` sigue
      // siendo la fuente principal (es lo más común), el atributo
      // "SELLER_SKU" es el fallback para publicaciones que solo guardan el
      // SKU ahí.
      sku: item.seller_custom_field ?? extractSellerSkuAttribute(item.attributes),
      categoryId: item.category_id,
      pictures: item.pictures.map((p) => ({ url: p.url })),
      variations: item.variations.map((v) => ({
        channelVariantId: String(v.id),
        sku: v.seller_custom_field ?? extractSellerSkuAttribute(v.attribute_combinations),
        availableQuantity: v.available_quantity ?? null,
        attributes: v.attribute_combinations.map((a) => ({ name: a.name, value: a.value_name })),
      })),
      attributes: (item.attributes ?? []).map((a) => ({ id: a.id, valueName: a.value_name ?? null })),
    };
  }

  /**
   * Fase 3a (F.3): pedidos creados desde `sinceIso` (paginado por
   * offset/limit, igual que `listAllItemIds`). No filtra por `status` —
   * el llamador decide qué hacer con pedidos cancelados; se marca
   * explícito para eso.
   *
   * Nota: la forma exacta de `order_items[].item` (nombres de campos como
   * `variation_id`) se confirma contra la API real durante la prueba —
   * este método se escribe defensivo (campos opcionales) para que un
   * cambio de forma se note con un error claro en vez de fallar en
   * silencio, siguiendo el mismo criterio que ya aplicó en este proyecto
   * al conector de OAuth de Mercado Libre.
   */
  async searchRecentOrders(sellerId: number, sinceIso: string): Promise<MeliNormalizedOrder[]> {
    interface MeliOrderSearchResponse {
      results: Array<{
        id: number | string;
        date_created: string;
        status: string;
        order_items: Array<{
          item: { id: string; variation_id?: number | string | null };
          quantity: number;
          unit_price: number;
        }>;
      }>;
      paging: { total: number };
    }

    const orders: MeliNormalizedOrder[] = [];
    let offset = 0;
    const limit = 50;
    const fromParam = encodeURIComponent(sinceIso);
    for (;;) {
      const page = await this.get<MeliOrderSearchResponse>(
        `/orders/search?seller=${sellerId}&order.date_created.from=${fromParam}&limit=${limit}&offset=${offset}`,
      );
      for (const order of page.results) {
        orders.push({
          channelOrderId: String(order.id),
          dateCreated: order.date_created,
          status: order.status,
          lines: order.order_items.map((line) => ({
            channelProductId: line.item.id,
            channelVariantId: line.item.variation_id != null ? String(line.item.variation_id) : null,
            quantity: line.quantity,
            unitPrice: line.unit_price,
          })),
        });
      }
      offset += limit;
      if (offset >= page.paging.total || page.results.length === 0) break;
    }
    return orders;
  }

  // --- Fase 2b: publicar productos nuevos en Mercado Libre ---------------

  /**
   * Predice la categoría más probable para un texto de producto
   * (`domain_discovery/search`). Se usa una vez por GRUPO de productos (no
   * una vez por producto) — ver `packages/sync-engine/src/meli-publish.ts`.
   */
  async predictCategory(siteId: string, query: string): Promise<MeliCategoryPrediction[]> {
    interface DomainDiscoveryResult {
      category_id: string;
      category_name: string;
      domain_id?: string;
    }
    const results = await this.get<DomainDiscoveryResult[]>(
      `/sites/${siteId}/domain_discovery/search?q=${encodeURIComponent(query)}&limit=5`,
    );
    return results.map((r) => ({
      categoryId: r.category_id,
      categoryName: r.category_name,
      domainId: r.domain_id ?? null,
    }));
  }

  /**
   * Pedido real del usuario: Mercado Libre repite el mismo nombre de
   * categoría ("Cascos") en varias ramas totalmente distintas del árbol
   * (bicicleta, construcción, trabajo, moto...) — el nombre solo no alcanza
   * para saber cuál es cuál. `GET /categories/{id}` devuelve `path_from_root`
   * (de la categoría raíz del sitio hasta esta categoría, inclusive); acá se
   * devuelve solo la lista de nombres en ese orden, ej.
   * `["Vehículos", "Accesorios para Vehículos", "Cascos y Protección", "Cascos"]`
   * — lista para mostrar como "Vehículos > Accesorios... > Cascos" sin que
   * el llamador tenga que recorrer la estructura cruda de la API.
   */
  async getCategoryPath(categoryId: string): Promise<string[]> {
    interface CategoryResponse {
      path_from_root: { id: string; name: string }[];
    }
    const category = await this.get<CategoryResponse>(`/categories/${categoryId}`);
    return category.path_from_root.map((p) => p.name);
  }

  /**
   * Atributos de una categoría, con `required` ya resuelto desde `tags` —
   * el llamador nunca necesita conocer la forma cruda de `tags` de la API.
   */
  async getCategoryAttributes(categoryId: string): Promise<MeliCategoryAttribute[]> {
    interface CategoryAttributeResponse {
      id: string;
      name: string;
      value_type: string;
      tags?: { required?: boolean };
      values?: { id: string; name: string }[];
    }
    const attrs = await this.get<CategoryAttributeResponse[]>(`/categories/${categoryId}/attributes`);
    return attrs.map((a) => ({
      id: a.id,
      name: a.name,
      valueType: a.value_type,
      required: Boolean(a.tags?.required),
      values: (a.values ?? []).map((v) => ({ id: v.id, name: v.name })),
    }));
  }

  /** Tipos de publicación disponibles en un sitio (afectan costo/exposición) — para el selector de Configuración/Publicar en ML. */
  async getListingTypes(siteId: string): Promise<MeliListingType[]> {
    interface ListingTypeResponse {
      id: string;
      name: string;
    }
    const types = await this.get<ListingTypeResponse[]>(`/sites/${siteId}/listing_types`);
    return types.map((t) => ({ id: t.id, name: t.name }));
  }

  /**
   * Crea una publicación nueva y simple (sin variaciones — el catálogo
   * central ya está aplanado a un SKU = un producto, ver Fase 2b). Si
   * Mercado Libre rechaza la categoría/algún atributo, el error trae el
   * detalle crudo de la API incrustado en `.message` (única forma de que
   * cruce el puente IPC de Electron, igual criterio que el resto del
   * proyecto) para poder ajustar el mapeo de esa categoría sin adivinar.
   */
  async createItem(input: MeliCreateItemInput): Promise<MeliCreateItemResult> {
    // Esta cuenta ya está en el modelo nuevo de "User Products"/familias
    // (ver el comentario de `familyName` en types.ts): con `family_name`
    // presente, Mercado Libre responde 400 "The fields [title] are invalid
    // for requested call" si además se manda `title` — el nombre visible
    // de la publicación sale de `family_name` (+ los atributos), no de un
    // campo `title` aparte. Se confirmó probando contra la API real.
    const body = {
      family_name: input.familyName,
      category_id: input.categoryId,
      price: input.price,
      currency_id: input.currencyId,
      available_quantity: input.availableQuantity,
      buying_mode: "buy_it_now",
      condition: input.condition,
      listing_type_id: input.listingTypeId,
      seller_custom_field: input.sellerCustomField,
      pictures: input.pictures,
      attributes: input.attributes.map((a) => ({
        id: a.id,
        ...(a.valueId ? { value_id: a.valueId } : {}),
        ...(a.valueName ? { value_name: a.valueName } : {}),
      })),
      ...(input.saleTerms.length > 0
        ? { sale_terms: input.saleTerms.map((t) => ({ id: t.id, value_name: t.valueName })) }
        : {}),
    };
    const result = await this.post<{ id: string }>("/items", body);
    return { itemId: result.id };
  }

  /**
   * La descripción NO se manda dentro de `POST /items` (a diferencia de
   * Shopify) — Mercado Libre la maneja con un endpoint aparte, y solo acepta
   * texto plano (`plain_text`), no HTML. Se llama tanto justo después de
   * crear el ítem (primera vez, no tiene descripción todavía) como desde
   * `syncMeliDescriptions` para ítems ya publicados (que YA tienen una) —
   * Mercado Libre exige POST para crearla la primera vez y PUT para
   * reemplazarla; probando contra la API real, un POST sobre un ítem que ya
   * tiene descripción responde 400 "Item already has a description, use PUT
   * instead" en vez de simplemente reemplazarla. Se intenta POST primero
   * (funciona para la mayoría — ítems recién creados) y solo se reintenta
   * con PUT si Mercado Libre contesta exactamente ese error, en vez de
   * consultar antes si ya tiene descripción (un viaje extra a la API por
   * cada ítem, para el caso menos común).
   */
  async setItemDescription(itemId: string, description: string): Promise<void> {
    try {
      await this.post(`/items/${itemId}/description`, { plain_text: description });
    } catch (err) {
      if (err instanceof MeliApiError && /already has a description/i.test(err.message)) {
        await this.put(`/items/${itemId}/description`, { plain_text: description });
        return;
      }
      throw err;
    }
  }

  /**
   * Investigación real (ronda 6 del bug SKU EM7405MC): el usuario reportó
   * que el 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`/`PolicyAgent` (ronda
   * 5) es nuevo — en pruebas anteriores el stock SÍ se sincronizaba solo,
   * incluso con compras reales. Revisando qué llama a la API de Mercado
   * Libre de forma automática y periódica (no solo cuando hay una venta),
   * se encontró que `syncMeliDescriptions` corre cada
   * `MELI_DESCRIPTION_SYNC_INTERVAL_MINUTES` (30 min por defecto,
   * `apps/desktop/src/main/index.ts`) y, ANTES de este cambio, escribía
   * `PUT/POST /items/{id}/description` para CADA producto publicado en
   * ambos canales, en CADA corrida, sin comparar si el texto realmente
   * cambió — un catálogo con varias decenas de publicaciones dual-canal
   * generaba así decenas de escrituras automáticas por hora, todos los
   * días, indefinidamente. Sumado al reintento automático sin límite de la
   * ronda 3 (que además reescribe `available_quantity` en cada sondeo de 5
   * minutos mientras un pedido siga en error), esto es el patrón de tráfico
   * automatizado más plausible para explicar por qué una cuenta que antes
   * sincronizaba sin problema empezó a chocar con el PolicyAgent de
   * Mercado Libre — un volumen alto y sostenido de escrituras repetidas
   * (muchas de ellas redundantes, sin cambios reales) es exactamente el
   * tipo de patrón que un sistema antifraude/antiabuso suele marcar. Este
   * método permite comparar ANTES de escribir, para que
   * `syncMeliDescriptions` deje de reescribir descripciones que no
   * cambiaron — ver el uso en `meli-publish.ts`. Si el ítem todavía no
   * tiene ninguna descripción cargada, Mercado Libre responde 404 acá; se
   * trata como "sin descripción todavía" (string vacío) en vez de
   * propagar el error, para no romper el flujo normal de creación.
   */
  async getItemDescription(itemId: string): Promise<string> {
    try {
      const result = await this.get<{ plain_text?: string; text?: string }>(`/items/${itemId}/description`);
      return result.plain_text ?? result.text ?? "";
    } catch (err) {
      if (err instanceof MeliApiError && err.status === 404) return "";
      throw err;
    }
  }

  /** Trae el catálogo completo del vendedor (usado por el importador de Fase 1). */
  async fetchAllItems(onProgress?: (done: number, total: number) => void): Promise<MeliNormalizedItem[]> {
    const sellerId = await this.getAuthorizedUserId();
    const ids = await this.listAllItemIds(sellerId);
    const items: MeliNormalizedItem[] = [];
    for (const id of ids) {
      items.push(await this.getItem(id));
      onProgress?.(items.length, ids.length);
    }
    return items;
  }
}
