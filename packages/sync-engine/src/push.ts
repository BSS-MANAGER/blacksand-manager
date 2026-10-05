import {
  getDb,
  getVariantWithChannelMap,
  updateVariantFields,
  setVariantQuantityOnHand,
  getVariantOnHandTotal,
  getOrCreateDefaultLocation,
  upsertChannelSyncStatus,
  setChannelListingStatus,
} from "@blacksand/db";
import type { ShopifyClient } from "@blacksand/connector-shopify";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { describeMeliError } from "@blacksand/connector-mercadolibre";

/**
 * Clientes ya construidos (con credenciales cargadas) para los canales
 * activos — construidos en la capa IPC, igual que en el importador de
 * Fase 1.
 *
 * `mercadolibreError` (ronda 4 del bug SKU EM7405MC): antes, si Mercado
 * Libre ESTABA configurado (el usuario ya lo había conectado alguna vez)
 * pero la app no lograba construir el cliente EN ESTE MOMENTO puntual
 * (token de refresco vencido/rotado, error de red al refrescarlo, etc.),
 * `buildChannelClients()` (`apps/desktop/src/main/ipc.ts`) dejaba
 * `mercadolibre` en `undefined` — exactamente el mismo valor que tiene un
 * canal que el usuario NUNCA conectó. `pushStockToOtherChannels` no podía
 * distinguir "nunca lo conectaste" (nada que avisar) de "lo conectaste
 * pero ahora mismo no se pudo hablar con la API" (un error real que el
 * usuario necesita saber, porque significa que NINGUNA venta se está
 * reflejando en Mercado Libre hasta que se resuelva) — en ambos casos el
 * push simplemente se omitía en silencio, sin ningún error visible en
 * ningún lado. Ahora `buildChannelClients()` atrapa ese fallo puntual y lo
 * guarda acá para que `pushStockToOtherChannels` pueda marcar el pedido
 * como error real (accionable) en vez de "sincronizado" sin haber tocado
 * nada — ver el bloque dedicado más abajo.
 */
export interface PushChannelClients {
  shopify?: ShopifyClient;
  mercadolibre?: MercadoLibreClient;
  mercadolibreError?: string;
}

export interface VariantPatch {
  sku?: string;
  price?: number;
  quantity?: number;
}

export interface PushChannelResult {
  channelCode: string;
  ok: boolean;
  error?: string;
  /**
   * Código corto (catálogo en `@blacksand/shared`, `sync-error-codes.ts`),
   * ej. "EN_REVISION" o "ERROR" — a pedido del usuario, la UI lo muestra
   * como badge compacto en vez del texto completo de `error`, que queda
   * disponible aparte como detalle (se abre a pedido).
   */
  errorCode?: string;
}

/** Forma mínima que necesita el bucle de push — la que ya trae `getVariantWithChannelMap`. */
interface ChannelMapForPush {
  id: string;
  channelId: string;
  channelProductId: string;
  channelVariantId: string | null;
  channel: { code: string };
  /**
   * Última foto conocida del estado real de la publicación (se llena con
   * el importador o con un push anterior) — se usa para saber si una
   * publicación que ESTABA pausada/en revisión necesita re-activarse
   * ahora que se está empujando stock > 0 (ver el bloque "reactivación
   * tras reposición" más abajo). `undefined` si el llamador no la trae
   * (`pushVariantToChannels`/`pushStockToOtherChannels` sí la incluyen,
   * vía `getVariantWithChannelMap`).
   */
  listingStatus?: string | null;
}

/**
 * Bucle compartido: por cada mapeo de canal, intenta escribir el patch en el
 * conector correspondiente y deja constancia en `channelProductMap`/
 * `channelSyncStatus` (sincronizado/error). Lo usan tanto la edición manual
 * (Fase 2a, `pushVariantToChannels`) como el push automático de stock tras
 * una venta (Fase 3, `pushStockToOtherChannels`) — misma mecánica, distinto
 * origen del cambio.
 */
async function applyPatchToChannelMaps(
  channelMaps: ChannelMapForPush[],
  productId: string,
  patch: VariantPatch,
  clients: PushChannelClients,
): Promise<PushChannelResult[]> {
  const db = getDb();
  const results: PushChannelResult[] = [];

  for (const map of channelMaps) {
    const channelCode = map.channel.code;
    const client: ShopifyClient | MercadoLibreClient | undefined =
      channelCode === "shopify" ? clients.shopify : channelCode === "mercadolibre" ? clients.mercadolibre : undefined;

    if (!client) {
      // Canal mapeado pero sin credenciales/cliente disponible ahora mismo
      // (canal desconectado): no es un error de esta variante puntual, se omite.
      continue;
    }

    try {
      if (channelCode === "shopify") {
        const shopify = client as ShopifyClient;
        if (patch.sku !== undefined || patch.price !== undefined) {
          await shopify.updateVariantPriceAndSku(map.channelProductId, map.channelVariantId || "", {
            price: patch.price,
            sku: patch.sku,
          });
        }
        if (patch.quantity !== undefined) {
          await shopify.setVariantInventoryQuantity(map.channelVariantId || "", patch.quantity);
        }
      } else if (channelCode === "mercadolibre") {
        const meli = client as MercadoLibreClient;
        if (patch.price !== undefined) {
          await meli.updateItemPrice(map.channelProductId, patch.price);
        }
        if (patch.quantity !== undefined || patch.sku !== undefined) {
          await meli.updateItemStockAndSku(map.channelProductId, map.channelVariantId || null, {
            availableQuantity: patch.quantity,
            sku: patch.sku,
          });
        }

        /**
         * A pedido del usuario: "necesito que cualquier modificación que yo
         * haga en la app se modifique también en shopify y en ML... si
         * cambio un sku... debe actualizarse en shopify y en ML". Este push
         * manual (`pushVariantToChannels`, botón "Guardar" en Productos) YA
         * empujaba el SKU a Mercado Libre desde antes — pero solo al campo
         * clásico `seller_custom_field` (arriba). Es EL MISMO problema que
         * "Corregir SKU incorrecto en Mercado Libre" encontró y corrigió
         * como algo puntual (ver `fixMeliSkuMismatches`,
         * `meli-sku-fix.ts`): para publicaciones de esta cuenta que usan el
         * modelo "User Products"/familias, el panel de Mercado Libre puede
         * estar leyendo/mostrando el SKU desde el atributo `SELLER_SKU`, no
         * desde el campo clásico — así que sin este bloque, cada edición
         * manual de SKU desde Productos iba a volver a caer en el mismo bug
         * ya reportado una vez, en vez de quedar resuelto de raíz.
         *
         * Igual que en `fixMeliSkuMismatches`: solo aplica a nivel de ÍTEM
         * (`channelVariantId` nulo) y solo si la publicación YA tiene el
         * atributo `SELLER_SKU` cargado (se detecta releyendo el ítem) —
         * para publicaciones con variación no se toca el atributo, mismo
         * motivo ya documentado ahí (reescribiría `attribute_combinations`
         * completo). Es best-effort: si esta lectura/escritura extra falla,
         * NO tumba el push principal (el campo clásico ya se actualizó
         * arriba) — el usuario puede correr "Corregir SKU incorrecto" en
         * "Estado en Mercado Libre" para detectar y corregir cualquier caso
         * que se haya escapado.
         */
        if (patch.sku !== undefined && !map.channelVariantId) {
          try {
            const itemForSkuCheck = await meli.getItem(map.channelProductId);
            if (itemForSkuCheck.attributes.some((a) => a.id === "SELLER_SKU")) {
              await meli.updateItemAttribute(map.channelProductId, "SELLER_SKU", patch.sku);
            }
          } catch {
            // Best-effort — ver el comentario grande de arriba.
          }
        }

        /**
         * Contraparte del bug `PAUSADO_SIN_STOCK` (ver el bloque grande en
         * el `catch` de abajo): cuando el stock de esta variante vuelve a
         * ser > 0 (se repuso) y la última foto conocida de la publicación
         * la tenía pausada/en revisión, Mercado Libre no siempre la
         * reactiva sola solo por recibir stock — a veces hay que pedirlo
         * explícitamente (`PUT /items/{id}` con `status: "active"`, mismo
         * mecanismo que "Estado en Mercado Libre" → "Reactivar"). Esto es
         * best-effort: si la reactivación falla (ej. la publicación sigue
         * bloqueada por otro motivo, o ya la reactivó Mercado Libre solo),
         * no debe tumbar el push principal, que YA se guardó como
         * exitoso más abajo — el usuario siempre puede reactivarla a mano
         * desde "Estado en Mercado Libre" si esto no alcanza.
         */
        if (
          patch.quantity !== undefined &&
          patch.quantity > 0 &&
          (map.listingStatus === "paused" || map.listingStatus === "under_review")
        ) {
          try {
            const freshItem = await meli.getItem(map.channelProductId);
            if (freshItem.status === "paused") {
              await meli.updateItemStatus(map.channelProductId, "active");
              const reactivated = await meli.getItem(map.channelProductId);
              await setChannelListingStatus(map.channelId, map.channelProductId, reactivated.status, reactivated.subStatus);
            } else {
              await setChannelListingStatus(map.channelId, map.channelProductId, freshItem.status, freshItem.subStatus);
            }
          } catch {
            // Best-effort — el push de stock ya se aplicó igual; la
            // publicación se puede reactivar a mano si esto no funcionó.
          }
        }
      }

      await db.channelProductMap.update({
        where: { id: map.id },
        data: { syncStatus: "sincronizado", lastError: null, lastErrorCode: null, lastSyncedAt: new Date() },
      });
      await upsertChannelSyncStatus({
        productId,
        channelId: map.channelId,
        status: "sincronizado",
      });
      results.push({ channelCode, ok: true });
    } catch (err) {
      // `describeMeliError` reescribe casos conocidos de la API de Mercado
      // Libre (ej. publicación "en revisión" que rechaza cambios de stock)
      // a un texto accionable, y devuelve además un código corto (`code`)
      // para el badge de la UI; para errores de Shopify o cualquier otro
      // caso no identificado de Mercado Libre, cae en el código genérico
      // "ERROR" y el mensaje se devuelve tal cual (ver
      // `@blacksand/shared/sync-error-codes.ts`).
      let code: string;
      let message: string;
      if (channelCode === "mercadolibre") {
        const described = describeMeliError(err);
        code = described.code;
        message = described.message;
      } else {
        code = "ERROR";
        message = err instanceof Error ? err.message : String(err);
      }

      // Caso real reportado por el usuario: varias publicaciones seguían
      // "en revisión" por más tiempo del típico (días, no horas) y no había
      // forma de saber, desde la app, qué es lo que Mercado Libre estaba
      // esperando — el error de `PUT /items/{id}` no lo dice. Mercado Libre
      // SÍ expone (a veces) el motivo puntual como `sub_status` en el
      // detalle del ítem (`GET /items/{id}`, ya usado por "Estado en ML").
      // Cuando el error es justo el de "en revisión", se intenta una
      // lectura extra (de solo lectura, no cuenta como otro intento de
      // escritura) para adjuntar ese motivo si Mercado Libre lo trae. Si la
      // lectura falla o `sub_status` viene vacío (documentado como no
      // siempre poblado — ver "Estado en Mercado Libre" en el estado del
      // proyecto), el mensaje base ya es igual de útil, así que un error acá
      // nunca debe tumbar el resto del push.
      //
      // Bug real reportado por el usuario (pedido #1153, SKU 1090): un
      // pedido de Shopify dejó esta variante en 0 stock, la app empujó ese
      // 0 a Mercado Libre, y Mercado Libre pausó la publicación SOLA por
      // quedarse sin stock — comportamiento normal y esperado de Mercado
      // Libre, no un problema de la app. Pero como el push de stock (este
      // mismo, o el reintento del sondeo de pedidos que corre después)
      // choca contra la publicación ya pausada, el error caía en el
      // genérico "en revisión" y tanto el pedido como el producto se veían
      // con el badge rojo "Error" — sin ninguna acción real pendiente: el
      // stock local YA se descontó bien. Cuando la lectura extra de abajo
      // confirma que la causa es stock 0 (se empujó `quantity: 0`, o la
      // publicación viene con `sub_status: ["out_of_stock"]`, o
      // `available_quantity` ya está en 0 del lado de Mercado Libre), se
      // reclasifica al código `PAUSADO_SIN_STOCK` (informativo, no error)
      // en vez de `EN_REVISION`, y además se guarda de inmediato el estado
      // real de la publicación (`listingStatus`/`listingSubStatus`) para
      // que "Productos" lo refleje sin esperar a la próxima importación.
      if (channelCode === "mercadolibre" && code === "EN_REVISION") {
        try {
          const meli = clients.mercadolibre;
          if (meli) {
            const item = await meli.getItem(map.channelProductId);
            await setChannelListingStatus(map.channelId, map.channelProductId, item.status, item.subStatus);

            const causedByZeroStock =
              patch.quantity === 0 ||
              item.availableQuantity === 0 ||
              item.subStatus.some((s) => /out_of_stock/i.test(s));

            if (causedByZeroStock) {
              code = "PAUSADO_SIN_STOCK";
              message =
                "Mercado Libre pausó esta publicación automáticamente porque el stock llegó a 0 — " +
                "es su comportamiento normal, no un error de la app. El stock local ya quedó " +
                "actualizado correctamente. Cuando vuelva a haber stock y se sincronice de nuevo, " +
                "Mercado Libre debería reactivarla sola; si no, se puede reactivar a mano desde " +
                "\"Estado en Mercado Libre\".";
            } else if (item.subStatus.length > 0) {
              message += ` Motivo que reporta Mercado Libre: ${item.subStatus.join(", ")}.`;
            }
          }
        } catch {
          // Lectura de detalle opcional — si falla, se guarda igual el
          // mensaje base ya calculado arriba (como `EN_REVISION`, sin
          // reclasificar).
        }
      }

      await db.channelProductMap.update({
        where: { id: map.id },
        data: { syncStatus: "error", lastError: message, lastErrorCode: code },
      });
      await upsertChannelSyncStatus({
        productId,
        channelId: map.channelId,
        status: "error",
        lastError: message,
        lastErrorCode: code,
      });
      results.push({ channelCode, ok: false, error: message, errorCode: code });
    }
  }

  return results;
}

/**
 * Fase 3g: a pedido explícito del usuario — "quiero corregir los errores y
 * los estados pendientes de los pedidos del dashboard" — reduce una lista
 * de `PushChannelResult` (posiblemente de VARIAS líneas/variantes de un
 * mismo pedido) a un único texto legible para guardar en
 * `Order.lastSyncError`, ej. "mercadolibre: Request failed with status
 * 401" o, si fallan dos canales distintos, ambos motivos separados por
 * " · ". Devuelve `null` cuando no hay ningún resultado con error (para
 * limpiar el campo en `Order` cuando un reintento sí funciona) — deduplica
 * mensajes idénticos repetidos entre líneas para no repetir el mismo error
 * una vez por cada producto del pedido.
 */
export function summarizePushErrors(results: PushChannelResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const unique = Array.from(new Set(failed.map((r) => `${r.channelCode}: ${r.error ?? "error desconocido"}`)));
  return unique.join(" · ");
}

/**
 * A pedido del usuario: contraparte de `summarizePushErrors` pero con los
 * códigos cortos en vez del texto completo — se guarda en
 * `Order.lastSyncErrorCode` y es lo que el Dashboard muestra como badge en
 * la tabla de pedidos (el texto completo de `summarizePushErrors` queda
 * disponible aparte, en el detalle que se abre al hacer clic en el badge).
 * Mismo criterio de deduplicación que `summarizePushErrors` — un código
 * único por canal, aunque varias líneas del pedido hayan fallado con el
 * mismo motivo.
 */
export function summarizePushErrorCodes(results: PushChannelResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const unique = Array.from(new Set(failed.map((r) => `${r.channelCode}: ${r.errorCode ?? "ERROR"}`)));
  return unique.join(" · ");
}

/**
 * Fase 2a (E.1/F push): aplica una edición manual de SKU/precio/stock de una
 * variante ya existente a la base local y la empuja de inmediato a cada
 * canal donde esa variante ya está mapeada (G.1). No crea publicaciones
 * nuevas en ningún canal — si la variante no tiene mapeo para un canal, ese
 * canal simplemente se omite (fuera de alcance de esta iteración).
 */
export async function pushVariantToChannels(
  variantId: string,
  patch: VariantPatch,
  clients: PushChannelClients,
  userId?: string | null,
): Promise<PushChannelResult[]> {
  // 1. La base local es la fuente de verdad: se escribe primero, siempre,
  // incluso si luego algún canal falla al empujar (queda marcado "error" en
  // vez de perderse el cambio).
  if (patch.sku !== undefined || patch.price !== undefined) {
    await updateVariantFields(variantId, { skuVariant: patch.sku, price: patch.price });
  }
  if (patch.quantity !== undefined) {
    const location = await getOrCreateDefaultLocation();
    await setVariantQuantityOnHand(variantId, location.id, patch.quantity, { userId });
  }

  const variant = await getVariantWithChannelMap(variantId);
  if (!variant) throw new Error("La variante ya no existe en la base local.");

  return applyPatchToChannelMaps(variant.channelMap, variant.productId, patch, clients);
}

/** Canales conectados (con cliente/credenciales disponibles ahora mismo) — ver el comentario grande más abajo, en `pushStockToOtherChannels`. */
function connectedChannelCodes(clients: PushChannelClients): string[] {
  const codes: string[] = [];
  if (clients.shopify) codes.push("shopify");
  if (clients.mercadolibre) codes.push("mercadolibre");
  return codes;
}

function channelDisplayName(code: string): string {
  if (code === "shopify") return "Shopify";
  if (code === "mercadolibre") return "Mercado Libre";
  return code;
}

/**
 * Fase 3 (F.3/F.4): tras una venta ya aplicada a la base local (pedido de
 * canal o venta de mostrador — el descuento de stock lo hace el llamador
 * con `applyInventoryMovement`, no esta función), empuja el nuevo stock
 * total a los demás canales donde la variante está mapeada. `excludeChannelCode`
 * es el canal donde ocurrió la venta (no tiene sentido re-escribirle el
 * stock que él mismo acaba de reportar); `null` empuja a todos los canales
 * mapeados — el caso de una venta de mostrador, que no viene de ningún canal.
 */
export async function pushStockToOtherChannels(
  variantId: string,
  excludeChannelCode: string | null,
  clients: PushChannelClients,
): Promise<PushChannelResult[]> {
  const variant = await getVariantWithChannelMap(variantId);
  if (!variant) throw new Error("La variante ya no existe en la base local.");

  const quantity = await getVariantOnHandTotal(variantId);
  const maps = excludeChannelCode
    ? variant.channelMap.filter((m) => m.channel.code !== excludeChannelCode)
    : variant.channelMap;

  const results = await applyPatchToChannelMaps(maps, variant.productId, { quantity }, clients);

  /**
   * Bug real reportado por el usuario (pedido #1151, SKU em745mc): "no se
   * esta realizando la actualizacion de stock conforme a las ventas que se
   * estan realizando por shopify... no se descontó en ML". Revisando el
   * código a fondo (no hay acceso a la base de datos real desde este
   * entorno de desarrollo para confirmarlo dato por dato): si el producto
   * vendido NUNCA se publicó en Mercado Libre — no existe ninguna fila
   * `ChannelProductMap` para ese canal, algo que hoy le pasa a la mayoría
   * del catálogo (304 productos en Shopify, 63 publicados en Mercado
   * Libre al momento de escribir esto — ver "Productos — visibilidad de
   * plataformas") — el bucle de arriba (`applyPatchToChannelMaps`) no
   * tenía NADA que recorrer para ese canal. No fallaba nada, así que el
   * pedido quedaba con `syncStatus: "sincronizado"` igual, sin ningún
   * aviso de que en Mercado Libre en realidad no se tocó nada — un pedido
   * "sincronizado" así es indistinguible en la UI de uno que sí actualizó
   * el stock en todos los canales.
   *
   * Desde ahora, si un canal está CONECTADO (hay credenciales/cliente
   * disponibles — `clients.shopify`/`clients.mercadolibre`) pero esta
   * variante puntual no tiene ninguna publicación mapeada ahí, se agrega
   * un resultado explícito con el código `SIN_PUBLICAR` (ver
   * `@blacksand/shared/sync-error-codes.ts`) — el pedido queda con
   * `syncStatus: "error"` y un motivo claro y accionable en vez de parecer
   * sincronizado sin haber hecho nada. Apretar "Reintentar" en el
   * Dashboard después de publicar el producto en ese canal vuelve a
   * intentar el push y esta vez sí encuentra el mapeo nuevo.
   */
  const mappedCodes = new Set(maps.map((m) => m.channel.code));
  for (const code of connectedChannelCodes(clients)) {
    if (code === excludeChannelCode) continue;
    if (mappedCodes.has(code)) continue;
    results.push({
      channelCode: code,
      ok: false,
      error: `El producto no está publicado en ${channelDisplayName(code)} — no hay ninguna publicación ahí para actualizar el stock. Publícalo primero (desde "Publicar en ML" o "Crear producto") y después usa "Reintentar" en este pedido.`,
      errorCode: "SIN_PUBLICAR",
    });
  }

  /**
   * Bug real reportado por el usuario (SKU EM7405MC, ronda 4): a diferencia
   * de `SIN_PUBLICAR` (canal conectado pero sin publicación para ESTA
   * variante), este caso es el opuesto — la variante SÍ tiene una
   * publicación mapeada en Mercado Libre, pero el cliente de Mercado Libre
   * no se pudo construir en este intento puntual (ver el comentario grande
   * en `PushChannelClients.mercadolibreError` arriba). Sin este bloque,
   * `applyPatchToChannelMaps` ya se había saltado esa fila en silencio
   * (`if (!client) continue`, más arriba) — cero resultado, cero error,
   * pedido marcado "sincronizado" igual. Ahora se agrega un resultado
   * explícito de error, así el pedido queda visible como "error" (y el
   * reintento automático del sondeo — ver `orders.ts`, ronda 3 — lo vuelve
   * a intentar solo en la próxima corrida, una vez que la conexión se
   * restablezca).
   */
  if (
    clients.mercadolibreError &&
    !clients.mercadolibre &&
    excludeChannelCode !== "mercadolibre" &&
    mappedCodes.has("mercadolibre") &&
    !results.some((r) => r.channelCode === "mercadolibre")
  ) {
    results.push({
      channelCode: "mercadolibre",
      ok: false,
      error: `No se pudo conectar con Mercado Libre para actualizar el stock: ${clients.mercadolibreError}. Es probable que haga falta reconectar la cuenta en Configuración. Se va a reintentar solo en la próxima revisión de pedidos.`,
      errorCode: "ERROR",
    });
  }

  return results;
}
