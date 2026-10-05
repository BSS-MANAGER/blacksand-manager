import {
  getChannelByCode,
  findChannelProductMap,
  findOrderByChannelOrderId,
  createChannelOrder,
  updateOrderSyncStatus,
  updateOrderCancellationState,
  listPendingCancellations as listPendingCancellationsDb,
  getOrderForCancellation,
  listOrdersMissingOrderNumber,
  updateOrderNumber,
  listPosSalesMissingOrderNumber,
  nextSequenceValue,
  getOrCreateDefaultLocation,
  applyInventoryMovement,
  recordAudit,
} from "@blacksand/db";
import { formatVentaPresencialNumber } from "@blacksand/core-domain";
import type { ShopifyClient } from "@blacksand/connector-shopify";
import { fetchRecentShopifyOrders, fetchOrderNamesByIds } from "@blacksand/connector-shopify";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import {
  pushStockToOtherChannels,
  summarizePushErrors,
  summarizePushErrorCodes,
  type PushChannelClients,
  type PushChannelResult,
} from "./push.js";

/**
 * Ronda 6 del bug SKU EM7405MC: el reintento automático de la ronda 3 no
 * tenía ningún límite ni excepción — reintentaba TODO pedido no
 * sincronizado, en CADA corrida del sondeo (cada 5 minutos por defecto),
 * para siempre, sin importar el motivo del error. Para la mayoría de los
 * motivos esto tiene sentido (el canal puede volver a estar disponible en
 * cualquier momento), pero para estos dos códigos puntuales reintentar NO
 * puede arreglar nada por sí solo — requieren una acción del usuario fuera
 * de la app (`SIN_PUBLICAR`: publicar el producto; `BLOQUEADO_POLITICA`:
 * que Mercado Libre levante la restricción de política, algo que ningún
 * reintento puede forzar, ver `describeMeliError`) — así que reintentarlos
 * cada 5 minutos indefinidamente es tráfico automatizado puro, sin ningún
 * beneficio, hacia la misma publicación una y otra vez. Se identificó este
 * patrón (junto con el de `syncMeliDescriptions`, ver
 * `meli-publish.ts`/`getItemDescription`) como un candidato real para
 * explicar por qué una cuenta que antes sincronizaba sin problema empezó a
 * chocar con el PolicyAgent de Mercado Libre. Apretar "Reintentar" a mano
 * en el Dashboard SIGUE funcionando para estos códigos (por si el usuario
 * ya resolvió la causa) — esto solo frena el reintento AUTOMÁTICO del
 * sondeo periódico.
 *
 * `PAUSADO_SIN_STOCK` (bug pedido #1153) se suma acá por el mismo motivo:
 * mientras el stock de esta variante siga en 0, reintentar el push de ESTE
 * pedido puntual (que ya cumplió su función real — el stock local ya
 * quedó descontado) solo repite la misma llamada rechazada por Mercado
 * Libre cada 5 minutos, sin ningún beneficio. La reactivación real ocurre
 * sola cuando esta variante reciba un push de stock > 0 (ver el bloque
 * "reactivación tras reposición" en `push.ts`), no reintentando este
 * pedido viejo.
 */
const NON_AUTO_RETRIABLE_ERROR_CODES = new Set(["SIN_PUBLICAR", "BLOQUEADO_POLITICA", "PAUSADO_SIN_STOCK"]);

export interface OrderIngestSummary {
  channel: "shopify" | "mercadolibre";
  ordersSeen: number;
  ordersNew: number;
  ordersCancelled: number;
  unmappedLines: number;
  /**
   * Bug real reportado por el usuario (SKU EM7405MC, ronda 3): un pedido de
   * Shopify que YA estaba publicado en ambas plataformas seguía sin
   * descontar stock en Mercado Libre. Causa raíz: cuando el sondeo vuelve a
   * ver un pedido que ya conoce (`findOrderByChannelOrderId` lo encuentra),
   * el código de acá abajo SOLO miraba si se había cancelado — si no, hacía
   * `continue` sin fijarse en el estado de sincronización. Un pedido que
   * quedó con `syncStatus: "error"` la primera vez (por ejemplo, un error
   * transitorio de la API justo al momento de ingresarlo — token vencido,
   * timeout, rate limit) se quedaba en ese estado PARA SIEMPRE: nada volvía
   * a intentarlo solo, dependía 100% de que el usuario notara el badge de
   * error en el Dashboard y apretara "Reintentar" a mano en ESE pedido
   * puntual. Ahora cada corrida del sondeo reintenta automáticamente
   * (mismo mecanismo que "Reintentar", `retryOrderSync`) cualquier pedido
   * ya conocido que no haya quedado "sincronizado" — este contador cuenta
   * cuántos pedidos se reintentaron en esta corrida.
   */
  ordersRetried: number;
  /**
   * Nuevo (ronda 6 del bug SKU EM7405MC): cuántos pedidos ya conocidos NO
   * se reintentaron en esta corrida porque su último error es de un tipo
   * que un reintento automático no puede resolver por sí solo (ver
   * `NON_AUTO_RETRIABLE_ERROR_CODES`) — reduce el ruido/tráfico automático
   * sin ocultar el pedido (sigue apareciendo en "Pedidos recientes" con su
   * badge de error de siempre, y "Reintentar" a mano lo sigue intentando).
   */
  ordersRetrySkipped: number;
  /**
   * Bug real reportado por el usuario: un pedido de Shopify (#1151, SKU
   * em745mc) nunca descontó stock en Mercado Libre porque el sondeo usaba
   * SIEMPRE una ventana fija "ahora - 24h" (`ORDER_POLL_LOOKBACK_HOURS`) sin
   * ningún recuerdo de cuándo fue la última revisión — un pedido que llegó
   * mientras la app estuvo cerrada más de 24h (dejar el PC apagado un fin de
   * semana, por ejemplo) quedaba FUERA de esa ventana para siempre: cada
   * corrida futura sigue mirando solo "ahora - 24h", que nunca vuelve a
   * cubrir ese momento. No quedaba ningún error visible en ningún lado — el
   * pedido simplemente nunca se procesaba. Ver `computeOrderPollLookbackHours`
   * en `apps/desktop/src/main/ipc.ts` para el checkpoint persistente que
   * arregla esto. Este campo expone desde cuándo se buscó realmente en esta
   * corrida puntual, para que la UI pueda mostrarlo.
   */
  sinceIso: string;
  /**
   * Bug real reportado por el usuario (SKU EM7405MC, ronda 4): si Mercado
   * Libre estaba conectado pero el cliente no se pudo construir en esta
   * corrida puntual (token de refresco vencido/rotado, error de red — ver
   * `PushChannelClients.mercadolibreError` en `push.ts`), antes esta
   * corrida simplemente NO incluía ningún resumen para `mercadolibre` —
   * igual que si el usuario nunca lo hubiera conectado, sin ningún aviso.
   * Cuando este campo viene con un motivo, es ese caso puntual: no se
   * revisaron pedidos de Mercado Libre en esta corrida por un problema de
   * conexión, no porque no haya nada que revisar. `undefined`/vacío en el
   * resto de los casos (incluido "nunca se conectó Mercado Libre", que
   * sigue sin generar ningún resumen, tal como antes).
   */
  connectionError?: string;
}

interface ResolvedLine {
  variantId: string;
  quantity: number;
  unitPrice: number;
}

interface UnmatchedLine {
  channelProductId: string | null;
  channelVariantId: string | null;
  quantity: number;
}

interface ExistingOrderForCancellation {
  id: string;
  status: string;
  stockDeducted: boolean;
  items: { variantId: string; quantity: number }[];
}

/**
 * Fase 3c (cancelaciones): pedido real reportado por el usuario — "hago un
 * pedido y lo cancelo, necesito que se refleje en la app como pedido
 * cancelado, y que la app sincronice el stock según si elijo reponer el
 * inventario o no en la tienda". Antes, un pedido cancelado se descartaba
 * de plano (`if (order.cancelled) continue`) — nunca aparecía en la app ni
 * tocaba el stock, sin importar si ya se había ingresado activo antes o no.
 *
 * Ahora un pedido cancelado se procesa en dos escenarios posibles:
 * 1. Se ve cancelado por primera vez (nunca estuvo activo en la app): se
 *    crea directo con `status: "cancelado"`. Si no se repuso, el efecto es
 *    igual a una venta (el producto salió del inventario) y se descuenta
 *    stock recién ahora; si se repuso, o no se sabe, el efecto neto es cero
 *    y no se toca stock.
 * 2. Ya estaba ingresado como pedido activo (se había descontado stock al
 *    recibirlo) y el canal ahora lo reporta cancelado: si se repuso, se
 *    revierte el descuento; si no se repuso, el stock queda como está (ya
 *    reflejaba la venta); si no se sabe, tampoco se toca nada todavía.
 *
 * La decisión de "se repuso o no" depende del canal:
 * - Shopify SÍ la expone en el propio pedido (`restockType` de las líneas
 *   de reembolso — ver `detectShopifyRestock` en el conector) y se aplica
 *   sola, sin pedirle nada al usuario.
 * - Mercado Libre NO la expone — ahí siempre queda `restocked: null`
 *   (pendiente de revisión) hasta que el usuario elija "Reponer stock" o
 *   "No reponer" en la tarjeta nueva del Dashboard (ver
 *   `resolveOrderCancellation` más abajo, que hace exactamente ese ajuste
 *   a pedido del usuario en vez de automático).
 *
 * Sea cual sea el camino, el push del nuevo stock a los DEMÁS canales usa
 * la misma función que ya usan los pedidos activos (`pushStockToOtherChannels`,
 * excluye el canal de origen) — la única diferencia es que la detección
 * automática de Shopify SÍ excluye el canal de origen (confía en que
 * Shopify ya se corrigió solo), mientras que la resolución MANUAL
 * (`resolveOrderCancellation`) empuja a TODOS los canales sin excluir
 * ninguno, porque no hay ninguna garantía de que el canal de origen se
 * haya ajustado solo (el caso más importante: Mercado Libre, que no
 * gestiona su propio stock de forma independiente de esta app).
 */
async function applyCancellationToExistingOrder(
  existing: ExistingOrderForCancellation,
  restocked: boolean | null,
  cancelReason: string | null,
  originChannelCode: "shopify" | "mercadolibre",
  pushClients: PushChannelClients,
): Promise<void> {
  const location = await getOrCreateDefaultLocation();
  let newStockDeducted = existing.stockDeducted;

  if (restocked === true && existing.stockDeducted) {
    // El canal repuso el stock al cancelar — se revierte el descuento local y se empuja a los demás canales.
    const allResults: PushChannelResult[] = [];
    for (const item of existing.items) {
      await applyInventoryMovement(item.variantId, location.id, item.quantity, {
        type: "cancelacion_reposicion",
        referenceType: "order",
        referenceId: existing.id,
      });
      const pushResults = await pushStockToOtherChannels(item.variantId, originChannelCode, pushClients);
      allResults.push(...pushResults);
    }
    newStockDeducted = false;
    const lastSyncError = summarizePushErrors(allResults);
    const lastSyncErrorCode = summarizePushErrorCodes(allResults);
    await updateOrderSyncStatus(existing.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);
  } else if (restocked === false && !existing.stockDeducted) {
    // No debería pasar en la práctica (un pedido ya ingresado siempre arrancó con stockDeducted=true),
    // se deja la rama por completitud/robustez ante cualquier secuencia rara de eventos.
    const allResults: PushChannelResult[] = [];
    for (const item of existing.items) {
      await applyInventoryMovement(item.variantId, location.id, -item.quantity, {
        type: "cancelacion_sin_reposicion",
        referenceType: "order",
        referenceId: existing.id,
      });
      const pushResults = await pushStockToOtherChannels(item.variantId, originChannelCode, pushClients);
      allResults.push(...pushResults);
    }
    newStockDeducted = true;
    const lastSyncError = summarizePushErrors(allResults);
    const lastSyncErrorCode = summarizePushErrorCodes(allResults);
    await updateOrderSyncStatus(existing.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);
  }
  // restocked === false && existing.stockDeducted (el caso normal para "no repuesto"): el stock ya
  // está descontado desde que se ingresó el pedido activo — no hace falta ningún movimiento nuevo.
  // restocked === null: queda pendiente de revisión manual, tampoco se toca el stock todavía.

  await updateOrderCancellationState(existing.id, {
    cancelledAt: new Date(),
    restocked,
    cancelReason,
    stockDeducted: newStockDeducted,
  });

  await recordAudit({
    action: "pedido_cancelado",
    entityType: "order",
    entityId: existing.id,
    after: { channel: originChannelCode, restocked, motivo: cancelReason },
  });
}

export async function ingestShopifyOrders(
  client: ShopifyClient,
  sinceIso: string,
  pushClients: PushChannelClients,
): Promise<OrderIngestSummary> {
  const channel = await getChannelByCode("shopify");
  const location = await getOrCreateDefaultLocation();
  const orders = await fetchRecentShopifyOrders(client, sinceIso);

  let ordersNew = 0;
  let ordersCancelled = 0;
  let unmappedLines = 0;
  let ordersRetried = 0;
  let ordersRetrySkipped = 0;

  for (const order of orders) {
    const existing = await findOrderByChannelOrderId(channel.id, order.channelOrderId);

    if (existing) {
      if (order.cancelled && existing.status !== "cancelado") {
        await applyCancellationToExistingOrder(existing, order.restocked, order.cancelReason, "shopify", pushClients);
        ordersCancelled += 1;
      } else if (existing.syncStatus !== "sincronizado") {
        // Ver el comentario grande en `OrderIngestSummary.ordersRetried` —
        // reintento automático de un pedido que ya conocíamos pero que no
        // quedó sincronizado la primera vez. Ronda 6: salvo que el último
        // error sea de un tipo que un reintento no puede resolver solo —
        // ver `NON_AUTO_RETRIABLE_ERROR_CODES`.
        if (existing.lastSyncErrorCode && NON_AUTO_RETRIABLE_ERROR_CODES.has(existing.lastSyncErrorCode)) {
          ordersRetrySkipped += 1;
        } else {
          await retryOrderSync(existing.id, pushClients);
          ordersRetried += 1;
        }
      }
      continue;
    }

    const resolved: ResolvedLine[] = [];
    const unmatched: UnmatchedLine[] = [];
    for (const line of order.lines) {
      const map = line.channelProductId
        ? await findChannelProductMap(channel.id, line.channelProductId, line.channelVariantId)
        : null;
      if (map?.variantId) {
        resolved.push({ variantId: map.variantId, quantity: line.quantity, unitPrice: line.unitPrice });
      } else {
        unmatched.push({ channelProductId: line.channelProductId, channelVariantId: line.channelVariantId, quantity: line.quantity });
      }
    }
    unmappedLines += unmatched.length;

    if (order.cancelled) {
      // Nunca se vio activo: recién ahora se crea, directo como cancelado.
      // Solo "no repuesto" (restocked === false) saca stock de verdad — si
      // se repuso o no se sabe todavía, el efecto neto es cero por ahora.
      const shouldDeductStock = order.restocked === false;
      const createdOrder = await createChannelOrder({
        channelId: channel.id,
        channelOrderId: order.channelOrderId,
        orderNumber: order.name,
        orderDate: new Date(order.createdAt),
        status: "cancelado",
        items: resolved,
        cancellation: { cancelledAt: new Date(), restocked: order.restocked, cancelReason: order.cancelReason },
        stockDeducted: shouldDeductStock,
      });
      if (!createdOrder) continue; // otro proceso (app / worker en la nube) ya lo ingresó — ver `createChannelOrder`
      ordersNew += 1;
      ordersCancelled += 1;

      if (shouldDeductStock) {
        const allResults: PushChannelResult[] = [];
        for (const line of resolved) {
          await applyInventoryMovement(line.variantId, location.id, -line.quantity, {
            type: "cancelacion_sin_reposicion",
            referenceType: "order",
            referenceId: createdOrder.id,
          });
          const pushResults = await pushStockToOtherChannels(line.variantId, "shopify", pushClients);
          allResults.push(...pushResults);
        }
        const lastSyncError = summarizePushErrors(allResults);
        const lastSyncErrorCode = summarizePushErrorCodes(allResults);
        await updateOrderSyncStatus(createdOrder.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);
      }

      await recordAudit({
        action: "pedido_cancelado",
        entityType: "order",
        entityId: createdOrder.id,
        after: {
          channel: "shopify",
          channelOrderId: order.channelOrderId,
          nombre: order.name,
          restocked: order.restocked,
          motivo: order.cancelReason,
          lineasResueltas: resolved.length,
          lineasSinMapeo: unmatched.length,
        },
      });
      continue;
    }

    const createdOrder = await createChannelOrder({
      channelId: channel.id,
      channelOrderId: order.channelOrderId,
      orderNumber: order.name,
      orderDate: new Date(order.createdAt),
      status: "recibido",
      items: resolved,
    });
    if (!createdOrder) continue; // otro proceso (app / worker en la nube) ya lo ingresó — ver `createChannelOrder`
    ordersNew += 1;

    const allResults: PushChannelResult[] = [];
    for (const line of resolved) {
      await applyInventoryMovement(line.variantId, location.id, -line.quantity, {
        type: "venta_online",
        referenceType: "order",
        referenceId: createdOrder.id,
      });
      const pushResults = await pushStockToOtherChannels(line.variantId, "shopify", pushClients);
      allResults.push(...pushResults);
    }
    const lastSyncError = summarizePushErrors(allResults);
    const lastSyncErrorCode = summarizePushErrorCodes(allResults);
    await updateOrderSyncStatus(createdOrder.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);

    await recordAudit({
      action: "ingresar_pedido",
      entityType: "order",
      entityId: createdOrder.id,
      after: {
        channel: "shopify",
        channelOrderId: order.channelOrderId,
        nombre: order.name,
        lineasResueltas: resolved.length,
        lineasSinMapeo: unmatched.length,
        sinMapeo: unmatched,
      },
    });
  }

  return {
    channel: "shopify",
    ordersSeen: orders.length,
    ordersNew,
    ordersCancelled,
    unmappedLines,
    ordersRetried,
    ordersRetrySkipped,
    sinceIso,
  };
}

/**
 * Fase 3c: a diferencia de Shopify (que ahora filtra por `updated_at`, ver
 * el conector), el filtro de búsqueda de pedidos de Mercado Libre
 * (`/orders/search`) que ya está verificado en producción es por
 * `date_created` — cambiarlo a ciegas a un filtro de "última actualización"
 * sin poder probarlo contra la API real es más riesgoso que simplemente
 * mirar más atrás en el tiempo con el mismo filtro que ya funciona. Esta
 * ventana (7 días por defecto) es aparte de `ORDER_POLL_LOOKBACK_HOURS` (24h,
 * la que se usa para detectar pedidos NUEVOS) — se usa solo para volver a
 * revisar si algún pedido ya conocido se canceló mientras tanto. Ajustable
 * si hace falta más adelante (por ejemplo, si las cancelaciones tardías de
 * esta cuenta suelen pasar bastante después de comprado).
 */
const MELI_CANCEL_RECHECK_HOURS = 24 * 7;

export async function ingestMercadoLibreOrders(
  client: MercadoLibreClient,
  sinceIso: string,
  pushClients: PushChannelClients,
): Promise<OrderIngestSummary> {
  const channel = await getChannelByCode("mercadolibre");
  const location = await getOrCreateDefaultLocation();
  const sellerId = await client.getAuthorizedUserId();

  const recheckSinceIso = new Date(
    Math.min(new Date(sinceIso).getTime(), Date.now() - MELI_CANCEL_RECHECK_HOURS * 60 * 60 * 1000),
  ).toISOString();
  const orders = await client.searchRecentOrders(sellerId, recheckSinceIso);

  let ordersNew = 0;
  let ordersCancelled = 0;
  let unmappedLines = 0;
  let ordersRetried = 0;
  let ordersRetrySkipped = 0;

  for (const order of orders) {
    const existing = await findOrderByChannelOrderId(channel.id, order.channelOrderId);
    const isCancelled = order.status === "cancelled";

    if (existing) {
      if (isCancelled && existing.status !== "cancelado") {
        // Mercado Libre no expone si hay que reponer — siempre queda pendiente de revisión manual (restocked: null).
        await applyCancellationToExistingOrder(existing, null, null, "mercadolibre", pushClients);
        ordersCancelled += 1;
      } else if (existing.syncStatus !== "sincronizado") {
        // Ver el comentario grande en `OrderIngestSummary.ordersRetried`.
        // Ronda 6: salvo códigos que un reintento no puede resolver solo —
        // ver `NON_AUTO_RETRIABLE_ERROR_CODES`.
        if (existing.lastSyncErrorCode && NON_AUTO_RETRIABLE_ERROR_CODES.has(existing.lastSyncErrorCode)) {
          ordersRetrySkipped += 1;
        } else {
          await retryOrderSync(existing.id, pushClients);
          ordersRetried += 1;
        }
      }
      continue;
    }

    const resolved: ResolvedLine[] = [];
    const unmatched: UnmatchedLine[] = [];
    for (const line of order.lines) {
      const map = await findChannelProductMap(channel.id, line.channelProductId, line.channelVariantId);
      if (map?.variantId) {
        resolved.push({ variantId: map.variantId, quantity: line.quantity, unitPrice: line.unitPrice });
      } else {
        unmatched.push({ channelProductId: line.channelProductId, channelVariantId: line.channelVariantId, quantity: line.quantity });
      }
    }
    unmappedLines += unmatched.length;

    if (isCancelled) {
      // Nunca se vio activo, y Mercado Libre no dice si hay que reponer —
      // se crea "cancelado" pendiente de revisión manual, sin tocar stock.
      const createdOrder = await createChannelOrder({
        channelId: channel.id,
        channelOrderId: order.channelOrderId,
        orderDate: new Date(order.dateCreated),
        status: "cancelado",
        items: resolved,
        cancellation: { cancelledAt: new Date(), restocked: null, cancelReason: null },
        stockDeducted: false,
      });
      if (!createdOrder) continue; // otro proceso (app / worker en la nube) ya lo ingresó — ver `createChannelOrder`
      ordersNew += 1;
      ordersCancelled += 1;

      await recordAudit({
        action: "pedido_cancelado",
        entityType: "order",
        entityId: createdOrder.id,
        after: {
          channel: "mercadolibre",
          channelOrderId: order.channelOrderId,
          restocked: null,
          lineasResueltas: resolved.length,
          lineasSinMapeo: unmatched.length,
        },
      });
      continue;
    }

    const createdOrder = await createChannelOrder({
      channelId: channel.id,
      channelOrderId: order.channelOrderId,
      orderDate: new Date(order.dateCreated),
      status: "recibido",
      items: resolved,
    });
    if (!createdOrder) continue; // otro proceso (app / worker en la nube) ya lo ingresó — ver `createChannelOrder`
    ordersNew += 1;

    const allResults: PushChannelResult[] = [];
    for (const line of resolved) {
      await applyInventoryMovement(line.variantId, location.id, -line.quantity, {
        type: "venta_online",
        referenceType: "order",
        referenceId: createdOrder.id,
      });
      const pushResults = await pushStockToOtherChannels(line.variantId, "mercadolibre", pushClients);
      allResults.push(...pushResults);
    }
    const lastSyncError = summarizePushErrors(allResults);
    const lastSyncErrorCode = summarizePushErrorCodes(allResults);
    await updateOrderSyncStatus(createdOrder.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);

    await recordAudit({
      action: "ingresar_pedido",
      entityType: "order",
      entityId: createdOrder.id,
      after: {
        channel: "mercadolibre",
        channelOrderId: order.channelOrderId,
        lineasResueltas: resolved.length,
        lineasSinMapeo: unmatched.length,
        sinMapeo: unmatched,
      },
    });
  }

  return {
    channel: "mercadolibre",
    ordersSeen: orders.length,
    ordersNew,
    ordersCancelled,
    unmappedLines,
    ordersRetried,
    ordersRetrySkipped,
    sinceIso: recheckSinceIso,
  };
}

/**
 * Punto de entrada único llamado por el sondeo periódico (scheduler) y por
 * el botón manual "Revisar pedidos ahora". Solo consulta los canales que
 * vengan con un cliente disponible en `pushClients` (canal conectado).
 */
export async function pollAllChannelOrders(
  pushClients: PushChannelClients,
  lookbackHours: number,
): Promise<OrderIngestSummary[]> {
  const sinceIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const summaries: OrderIngestSummary[] = [];

  if (pushClients.shopify) {
    summaries.push(await ingestShopifyOrders(pushClients.shopify, sinceIso, pushClients));
  }
  if (pushClients.mercadolibre) {
    summaries.push(await ingestMercadoLibreOrders(pushClients.mercadolibre, sinceIso, pushClients));
  } else if (pushClients.mercadolibreError) {
    // Ver el comentario grande en `OrderIngestSummary.connectionError`
    // (ronda 4, SKU EM7405MC): Mercado Libre está configurado pero no se
    // pudo conectar en esta corrida puntual — se deja constancia explícita
    // en vez de simplemente no incluir ningún resumen para este canal.
    summaries.push({
      channel: "mercadolibre",
      ordersSeen: 0,
      ordersNew: 0,
      ordersCancelled: 0,
      unmappedLines: 0,
      ordersRetried: 0,
      ordersRetrySkipped: 0,
      sinceIso,
      connectionError: pushClients.mercadolibreError,
    });
  }

  return summaries;
}

export interface PendingCancellationRow {
  id: string;
  channelCode: string | null;
  channelOrderId: string | null;
  /** Fase 3d: número de pedido "humano" del canal — ver comentario en schema.prisma. Cae a `channelOrderId` cuando no se guardó aparte (siempre el caso hoy para Mercado Libre, que usa el mismo id como número de venta). */
  orderNumber: string | null;
  orderDate: string;
  cancelledAt: string | null;
  itemCount: number;
  /** Fase 3d: SKU y cantidad de cada línea del pedido, para mostrar en el Dashboard. */
  items: { sku: string; quantity: number }[];
  total: number;
}

/**
 * Fase 3c: pedidos cancelados esperando que el usuario elija "reponer" o
 * "no reponer" — hoy, siempre los de Mercado Libre (no expone esa
 * información por API), y en teoría cualquier caso raro de Shopify sin
 * información de reposición clara. Alimenta la tarjeta nueva del Dashboard.
 */
export async function listPendingCancellations(): Promise<PendingCancellationRow[]> {
  const rows = await listPendingCancellationsDb();
  return rows.map((r) => ({
    id: r.id,
    channelCode: r.channel?.code ?? null,
    channelOrderId: r.channelOrderId,
    orderNumber: r.orderNumber ?? r.channelOrderId,
    orderDate: r.orderDate.toISOString(),
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    itemCount: r.items.reduce((sum, i) => sum + i.quantity, 0),
    // Ver el comentario equivalente en ipc.ts (ordersListRecent) — mismo
    // fallback para líneas cuyo producto se borró con historial.
    items: r.items.map((i) => ({
      sku: i.variant?.skuVariant ?? i.skuSnapshot ?? "Producto eliminado",
      quantity: i.quantity,
    })),
    total: r.total,
  }));
}

/**
 * Fase 3c: resuelve A MANO un pedido cancelado que quedó pendiente de
 * revisión — hoy, la única forma de decidir la reposición de un pedido de
 * Mercado Libre (ver el comentario grande arriba de `applyCancellationToExistingOrder`
 * para el porqué de la asimetría con Shopify). A diferencia de la detección
 * automática de Shopify (que excluye el canal de origen al empujar el
 * nuevo stock, porque ya confirmó que ese canal se corrigió solo), acá se
 * empuja a TODOS los canales mapeados sin excluir ninguno — no hay ninguna
 * señal de que Mercado Libre haya ajustado su propio stock solo al
 * cancelar (a diferencia de cuando vende, ahí si maneja su propio
 * descuento), así que conviene escribírselo explícito también a él.
 */
export async function resolveOrderCancellation(
  orderId: string,
  restocked: boolean,
  pushClients: PushChannelClients,
): Promise<{ ok: true }> {
  const order = await getOrderForCancellation(orderId);
  if (!order) throw new Error("El pedido ya no existe.");
  if (order.status !== "cancelado") throw new Error("Este pedido no está cancelado.");
  if (order.restocked !== null) throw new Error("Este pedido ya tiene una decisión de reposición guardada.");

  const location = await getOrCreateDefaultLocation();
  let newStockDeducted = order.stockDeducted;

  if (restocked && order.stockDeducted) {
    for (const item of order.items) {
      await applyInventoryMovement(item.variantId, location.id, item.quantity, {
        type: "cancelacion_reposicion",
        referenceType: "order",
        referenceId: order.id,
      });
      await pushStockToOtherChannels(item.variantId, null, pushClients);
    }
    newStockDeducted = false;
  } else if (!restocked && !order.stockDeducted) {
    for (const item of order.items) {
      await applyInventoryMovement(item.variantId, location.id, -item.quantity, {
        type: "cancelacion_sin_reposicion",
        referenceType: "order",
        referenceId: order.id,
      });
      await pushStockToOtherChannels(item.variantId, null, pushClients);
    }
    newStockDeducted = true;
  }

  await updateOrderCancellationState(order.id, {
    cancelledAt: order.cancelledAt ?? new Date(),
    restocked,
    stockDeducted: newStockDeducted,
  });

  await recordAudit({
    action: "resolver_cancelacion_pedido",
    entityType: "order",
    entityId: order.id,
    after: { restocked },
  });

  return { ok: true };
}

export interface BackfillOrderNumbersResult {
  shopifyUpdated: number;
  shopifyErrors: number;
  mercadolibreUpdated: number;
  /** Fase 3f: ventas de mostrador que recibieron recién su correlativo "VP-#0001". */
  posUpdated: number;
}

/**
 * Fase 3e (correlativo de pedidos): a pedido explícito del usuario —
 * "que los pedidos sean los correlativos de mi tienda, tambien quiero
 * actualizar los que ya estanban en la app" — este backfill rellena
 * `Order.orderNumber` para pedidos que se ingresaron ANTES de que ese
 * campo existiera (Fase 3d), donde hoy la columna "N° pedido" del
 * Dashboard cae al `channelOrderId` (poco legible en Shopify, un GID
 * interno).
 *
 * Shopify: se pide el `name` real (el correlativo, ej. "#1023") en lotes
 * de 50 vía `fetchOrderNamesByIds` — un pedido que ya no exista en
 * Shopify (borrado) simplemente no vuelve con nombre y se cuenta como
 * error, sin cortar el resto del lote.
 *
 * Mercado Libre: NO hace falta pedir nada a la API — el `channelOrderId`
 * guardado YA ES el número que Mercado Libre le muestra al vendedor como
 * número de venta (ver el comentario grande en `RecentOrderRow`), así que
 * acá simplemente se copia a `orderNumber` para que quede guardado de
 * forma permanente en vez de depender del fallback en tiempo de lectura.
 *
 * Fase 3f: mismo botón, ahora también rellena el correlativo "VP-#0001" de
 * las ventas de mostrador que se registraron antes de que existiera ese
 * correlativo (`listPosSalesMissingOrderNumber`, ordenadas por fecha para
 * asignar los números en el mismo orden en que ocurrieron las ventas). No
 * hace falta ninguna llamada a un canal — usa el mismo contador atómico
 * (`nextSequenceValue`) que una venta nueva.
 *
 * Se puede correr las veces que haga falta — solo toca pedidos/ventas que
 * todavía tienen `orderNumber: null`, así que uno ya actualizado (o uno
 * nuevo, que ya se guarda con su número desde que se ingresa/registra) no
 * se vuelve a tocar.
 */
export async function backfillOrderNumbers(
  pushClients: PushChannelClients,
): Promise<BackfillOrderNumbersResult> {
  let shopifyUpdated = 0;
  let shopifyErrors = 0;
  let mercadolibreUpdated = 0;
  let posUpdated = 0;

  if (pushClients.shopify) {
    const pending = await listOrdersMissingOrderNumber("shopify");
    const ids = pending.map((o) => o.channelOrderId).filter((id): id is string => id !== null);
    if (ids.length > 0) {
      const names = await fetchOrderNamesByIds(pushClients.shopify, ids);
      for (const order of pending) {
        const name = order.channelOrderId ? names.get(order.channelOrderId) : undefined;
        if (name) {
          await updateOrderNumber(order.id, name);
          shopifyUpdated += 1;
        } else {
          shopifyErrors += 1;
        }
      }
    }
  }

  const pendingMeli = await listOrdersMissingOrderNumber("mercadolibre");
  for (const order of pendingMeli) {
    if (order.channelOrderId) {
      await updateOrderNumber(order.id, order.channelOrderId);
      mercadolibreUpdated += 1;
    }
  }

  const pendingPos = await listPosSalesMissingOrderNumber();
  for (const sale of pendingPos) {
    const sequenceValue = await nextSequenceValue("venta_presencial");
    await updateOrderNumber(sale.id, formatVentaPresencialNumber(sequenceValue));
    posUpdated += 1;
  }

  await recordAudit({
    action: "actualizar_numeros_de_pedido",
    entityType: "order",
    entityId: "batch",
    after: { shopifyUpdated, shopifyErrors, mercadolibreUpdated, posUpdated },
  });

  return { shopifyUpdated, shopifyErrors, mercadolibreUpdated, posUpdated };
}

export interface RetryOrderSyncResult {
  syncStatus: "sincronizado" | "error";
  lastSyncError: string | null;
  /** Código corto del error (ver `summarizePushErrorCodes`) — `null` si `syncStatus === "sincronizado"`. */
  lastSyncErrorCode: string | null;
}

/**
 * Fase 3g: a pedido explícito del usuario — "quiero corregir los errores y
 * los estados pendientes de los pedidos del dashboard" — reintenta el push
 * de stock de UN pedido puntual hacia los demás canales, para pedidos que
 * quedaron con `syncStatus: "error"` (típicamente porque el canal estaba
 * caído o el token venció justo en ese momento) o, más raro, atascados en
 * "pendiente" por alguna excepción a mitad del ingreso/venta original.
 *
 * Reusa exactamente la misma función de push que ya corrió la primera vez
 * (`pushStockToOtherChannels`) — empuja el STOCK TOTAL actual de cada
 * variante del pedido (no un delta), así que reintentar las veces que haga
 * falta es seguro y no duplica nada; NO vuelve a tocar el inventario local
 * (`applyInventoryMovement` no se llama de nuevo acá, a diferencia de
 * ingresar un pedido nuevo) — este reintento es solo sobre la comunicación
 * con los demás canales, el stock local ya está correcto desde que se creó
 * el pedido.
 *
 * El canal de origen a excluir del push es el mismo criterio que ya usa el
 * resto de este archivo: el canal del propio pedido (no tiene sentido
 * reescribirle a Shopify o Mercado Libre el stock que ellos mismos
 * originaron), o ninguno (`null`) para una venta de mostrador — empuja a
 * todos los canales mapeados, igual que hace `registerPosSale`.
 */
export async function retryOrderSync(
  orderId: string,
  pushClients: PushChannelClients,
): Promise<RetryOrderSyncResult> {
  const order = await getOrderForCancellation(orderId);
  if (!order) throw new Error("El pedido ya no existe.");
  if (order.items.length === 0) throw new Error("Este pedido no tiene líneas para sincronizar.");

  const originChannelCode = order.channel?.code ?? null;
  const allResults: PushChannelResult[] = [];
  for (const item of order.items) {
    const results = await pushStockToOtherChannels(item.variantId, originChannelCode, pushClients);
    allResults.push(...results);
  }

  const lastSyncError = summarizePushErrors(allResults);
  const lastSyncErrorCode = summarizePushErrorCodes(allResults);
  const syncStatus: "sincronizado" | "error" = lastSyncError ? "error" : "sincronizado";
  await updateOrderSyncStatus(order.id, syncStatus, lastSyncError, lastSyncErrorCode);

  await recordAudit({
    action: "reintentar_sincronizacion_pedido",
    entityType: "order",
    entityId: order.id,
    after: { syncStatus, lastSyncError, lastSyncErrorCode },
  });

  return { syncStatus, lastSyncError, lastSyncErrorCode };
}
