import { getDb } from "../client.js";

/** Fase 3a (F.3): idempotencia — si ya existe, el pedido se ignora (no se duplica). Fase 3c: incluye `items` porque `orders.ts` (sync-engine) los necesita para decidir qué hacer si el pedido ahora aparece cancelado. */
export async function findOrderByChannelOrderId(channelId: string, channelOrderId: string) {
  const db = getDb();
  return db.order.findUnique({
    where: { channelId_channelOrderId: { channelId, channelOrderId } },
    include: { items: true },
  });
}

/**
 * Fase 3a: crea el pedido + sus líneas para un pedido ingresado desde un
 * canal. Solo se pasan las líneas que sí resolvieron a una variante central
 * (`findChannelProductMap`) — las que no, el llamador las deja fuera y las
 * reporta aparte (auditoría), porque `OrderItem.variantId` es obligatorio.
 *
 * Fase 3c (cancelaciones): un pedido puede llegar YA cancelado la primera
 * vez que el sondeo lo ve (si se canceló muy rápido, o el sondeo se saltó
 * una vuelta). `cancellation` es opcional — si viene, el pedido se crea
 * directo con `status: "cancelado"` y el resto de los campos de
 * cancelación. `stockDeducted` lo decide el llamador (`orders.ts` en
 * sync-engine): indica si ESTE alta ya representa un descuento de stock
 * real aplicado (pedido cancelado sin reposición, se trata igual que una
 * venta) o no (pedido repuesto, o pendiente de revisión — no se toca stock
 * todavía).
 */
export async function createChannelOrder(input: {
  channelId: string;
  channelOrderId: string;
  /** Fase 3d: número de pedido "humano" del canal (ej. "#1023" en Shopify) — opcional, ver comentario en schema.prisma. */
  orderNumber?: string | null;
  orderDate: Date;
  status: string;
  items: { variantId: string; quantity: number; unitPrice: number }[];
  cancellation?: {
    cancelledAt: Date;
    restocked: boolean | null;
    cancelReason: string | null;
  } | null;
  stockDeducted?: boolean;
}) {
  const db = getDb();
  const subtotal = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  try {
    return await db.order.create({
    data: {
      channelId: input.channelId,
      channelOrderId: input.channelOrderId,
      orderNumber: input.orderNumber ?? null,
      orderDate: input.orderDate,
      status: input.status,
      subtotal,
      total: subtotal,
      syncStatus: "pendiente",
      cancelledAt: input.cancellation?.cancelledAt ?? null,
      restocked: input.cancellation?.restocked ?? null,
      cancelReason: input.cancellation?.cancelReason ?? null,
      stockDeducted: input.stockDeducted ?? true,
      items: {
        create: input.items.map((i) => ({
          variantId: i.variantId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      },
    },
    include: { items: true },
    });
  } catch (err) {
    // Red de seguridad (el "turno" de sondeo ya evita casi siempre que dos
    // procesos ingresen el mismo pedido): si de todas formas otro proceso —
    // la app o el worker en la nube — lo creó un instante antes, la
    // restricción única (canal + pedido) rechaza este alta. Eso NO es un
    // error: el pedido ya existe y quien lo creó se ocupa de su stock. Se
    // devuelve `null` y el llamador sigue con el siguiente pedido, sin
    // descontar stock una segunda vez.
    if ((err as { code?: string } | null)?.code === "P2002") return null;
    throw err;
  }
}

/**
 * Fase 3a: marca el resultado del push de stock hacia los demás canales tras
 * ingresar el pedido. Fase 3g: `lastSyncError` opcional — el detalle
 * legible del intento (ver `summarizePushErrors` en `@blacksand/sync-engine`);
 * se pasa `null` explícito para limpiarlo cuando un reintento sale bien, y
 * se omite (queda tal cual estaba) en los pocos lugares que todavía no
 * calculan un detalle de error. A pedido del usuario: `lastSyncErrorCode`
 * (opcional, mismo criterio que `lastSyncError`) guarda el código corto
 * (ver `summarizePushErrorCodes` en `@blacksand/sync-engine`) que el
 * Dashboard muestra como badge — el texto completo queda como detalle
 * aparte en `lastSyncError`.
 */
export async function updateOrderSyncStatus(
  orderId: string,
  syncStatus: "sincronizado" | "pendiente" | "error",
  lastSyncError?: string | null,
  lastSyncErrorCode?: string | null,
) {
  const db = getDb();
  return db.order.update({
    where: { id: orderId },
    data:
      lastSyncError === undefined
        ? { syncStatus }
        : { syncStatus, lastSyncError, lastSyncErrorCode: lastSyncErrorCode ?? null },
  });
}

/**
 * Fase 3c (cancelaciones): guarda el resultado de procesar una cancelación
 * en un pedido — tanto cuando se detecta automático (Shopify, restocked
 * true/false/null) como cuando el usuario la resuelve a mano en la pantalla
 * nueva (Mercado Libre, o cualquier caso de Shopify que haya quedado
 * pendiente). `stockDeducted` es el nuevo valor DESPUÉS de aplicar el
 * movimiento de inventario que correspondía — lo calcula el llamador en
 * sync-engine, que es quien sabe si tuvo que mover stock o no; queda
 * guardado para que la próxima vez que se toque este pedido (si la hay) sea
 * idempotente en vez de tener que inferirlo de otro lado.
 */
export async function updateOrderCancellationState(
  orderId: string,
  input: { cancelledAt: Date; restocked: boolean | null; cancelReason?: string | null; stockDeducted: boolean },
) {
  const db = getDb();
  return db.order.update({
    where: { id: orderId },
    data: {
      status: "cancelado",
      cancelledAt: input.cancelledAt,
      restocked: input.restocked,
      cancelReason: input.cancelReason ?? undefined,
      stockDeducted: input.stockDeducted,
    },
  });
}

/**
 * Fase 3c: pedidos cancelados donde todavía no se sabe si hay que reponer
 * stock (`restocked: null`) — hoy esto pasa siempre para Mercado Libre (no
 * expone esa información por API, a diferencia de Shopify) y, más raro,
 * para un pedido de Shopify cuya cancelación no trajo información de
 * reposición clara (sin reembolso asociado, o con líneas mezcladas
 * reposición/no-reposición). Alimenta la tarjeta nueva del Dashboard donde
 * el usuario elige "Reponer"/"No reponer" a mano.
 */
export async function listPendingCancellations() {
  const db = getDb();
  return db.order.findMany({
    where: { status: "cancelado", restocked: null },
    // Fase 3d: incluye la variante de cada línea para poder mostrar el SKU en el Dashboard.
    include: { channel: true, items: { include: { variant: true } } },
    orderBy: { cancelledAt: "desc" },
  });
}

/** Fase 3c: pedido + líneas + canal, para resolver una cancelación (agregar/quitar stock y empujar a los demás canales). */
export async function getOrderForCancellation(orderId: string) {
  const db = getDb();
  return db.order.findUnique({
    where: { id: orderId },
    include: { channel: true, items: true },
  });
}

/**
 * Fase 3b (F.4): crea el pedido + líneas + `PosSale` anidado en una sola
 * escritura para una venta de mostrador (channelId null — no viene de
 * ningún canal). No requiere `userId` (todavía no hay login/roles reales;
 * el nombre de quien vende, si se anota, va en `observations`).
 *
 * Fase 3f: `orderNumber` es el correlativo "VP-#0001" que el llamador
 * (`registerPosSale` en `@blacksand/sync-engine`) ya calculó con
 * `nextSequenceValue("venta_presencial")` + `formatVentaPresencialNumber` —
 * este repositorio solo lo guarda, igual que ya hace `createChannelOrder`
 * con el `orderNumber` de Shopify/Mercado Libre.
 */
export async function createPosSale(input: {
  items: { variantId: string; quantity: number; unitPrice: number; unitCost?: number | null }[];
  paymentMethod?: string | null;
  observations?: string | null;
  userId?: string | null;
  orderNumber: string;
}) {
  const db = getDb();
  const subtotal = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  return db.order.create({
    data: {
      channelId: null,
      channelOrderId: null,
      orderNumber: input.orderNumber,
      status: "completada",
      subtotal,
      total: subtotal,
      paymentMethod: input.paymentMethod ?? null,
      syncStatus: "pendiente",
      items: {
        create: input.items.map((i) => ({
          variantId: i.variantId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          unitCost: i.unitCost ?? null,
        })),
      },
      posSale: {
        create: {
          observations: input.observations ?? null,
          paymentMethod: input.paymentMethod ?? null,
          userId: input.userId ?? null,
        },
      },
    },
    include: { items: true, posSale: true },
  });
}

/** Alimenta la sección "Pedidos recientes" del Dashboard (pedidos de canal + ventas de mostrador). */
export async function listRecentOrders(limit = 20) {
  const db = getDb();
  return db.order.findMany({
    orderBy: { orderDate: "desc" },
    take: limit,
    // Fase 3d: incluye la variante de cada línea para poder mostrar el SKU en el Dashboard.
    include: { channel: true, items: { include: { variant: true } } },
  });
}

/**
 * Fase 3e (correlativo de pedidos, pedidos ya ingresados antes de este
 * campo): pedidos de un canal que todavía no tienen `orderNumber` guardado
 * — alimenta el botón "Actualizar N° de pedido" del Dashboard
 * (`backfillOrderNumbers` en `@blacksand/sync-engine`). Sin límite: se
 * espera correr esto una sola vez por catálogo existente (después,
 * `orderNumber` se guarda solo al ingresar cada pedido nuevo), y es
 * idempotente — un pedido que ya tiene `orderNumber` no vuelve a aparecer.
 */
export async function listOrdersMissingOrderNumber(channelCode: "shopify" | "mercadolibre") {
  const db = getDb();
  return db.order.findMany({
    where: { channel: { code: channelCode }, orderNumber: null, channelOrderId: { not: null } },
    select: { id: true, channelOrderId: true },
  });
}

/** Fase 3e: guarda el `orderNumber` recuperado para un pedido que no lo tenía — ver `listOrdersMissingOrderNumber`. También la usa el backfill de ventas de mostrador (Fase 3f). */
export async function updateOrderNumber(orderId: string, orderNumber: string) {
  const db = getDb();
  return db.order.update({ where: { id: orderId }, data: { orderNumber } });
}

/**
 * Fase 3f (correlativo "VP-#0001" de ventas de mostrador): ventas
 * registradas ANTES de que existiera este correlativo, que por lo tanto
 * quedaron con `orderNumber: null`. Ordenadas por fecha ascendente para que
 * el backfill (`backfillOrderNumbers` en `@blacksand/sync-engine`) les
 * asigne los números en el mismo orden en que ocurrieron las ventas —
 * igual que `listOrdersMissingOrderNumber`, es idempotente: una vez
 * asignado el número, la venta no vuelve a aparecer acá.
 */
export async function listPosSalesMissingOrderNumber() {
  const db = getDb();
  return db.order.findMany({
    where: { channelId: null, orderNumber: null },
    orderBy: { orderDate: "asc" },
    select: { id: true },
  });
}
