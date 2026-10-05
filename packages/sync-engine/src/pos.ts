import {
  createPosSale,
  updateOrderSyncStatus,
  applyInventoryMovement,
  getOrCreateDefaultLocation,
  recordAudit,
  nextSequenceValue,
} from "@blacksand/db";
import { formatVentaPresencialNumber } from "@blacksand/core-domain";
import {
  pushStockToOtherChannels,
  summarizePushErrors,
  summarizePushErrorCodes,
  type PushChannelClients,
  type PushChannelResult,
} from "./push.js";

export interface PosSaleItemInput {
  variantId: string;
  quantity: number;
  unitPrice: number;
  unitCost?: number | null;
}

export interface PosSaleInput {
  items: PosSaleItemInput[];
  paymentMethod?: string | null;
  observations?: string | null;
  userId?: string | null;
}

export interface PosSalePushResult {
  variantId: string;
  results: PushChannelResult[];
}

export interface PosSaleOutcome {
  orderId: string;
  /** Fase 3f: correlativo "VP-#0001" recién asignado a esta venta. */
  orderNumber: string;
  pushResults: PosSalePushResult[];
}

/**
 * Fase 3b (F.4): registra una venta de mostrador — crea el pedido local,
 * descuenta stock por cada línea y empuja el nuevo stock a TODOS los
 * canales donde cada variante está mapeada (a diferencia de un pedido que
 * llega desde un canal, aquí no hay canal de origen que excluir). No hay
 * login/roles todavía, así que `userId` queda `null` salvo que el llamador
 * lo pase explícito.
 *
 * Fase 3f: el usuario pidió que las ventas de mostrador también tengan un
 * número correlativo propio (no vienen de ningún canal, así que no hay
 * "número de pedido" que traer de ninguna API) con el formato "VP-#0001".
 * Se calcula ACÁ, antes de crear el pedido, con
 * `nextSequenceValue("venta_presencial")` (contador atómico en
 * `SequenceCounter`) + `formatVentaPresencialNumber`.
 */
export async function registerPosSale(
  input: PosSaleInput,
  pushClients: PushChannelClients,
): Promise<PosSaleOutcome> {
  if (input.items.length === 0) {
    throw new Error("La venta no tiene productos agregados.");
  }

  const sequenceValue = await nextSequenceValue("venta_presencial");
  const orderNumber = formatVentaPresencialNumber(sequenceValue);

  const order = await createPosSale({
    items: input.items,
    paymentMethod: input.paymentMethod,
    observations: input.observations,
    userId: input.userId,
    orderNumber,
  });

  const location = await getOrCreateDefaultLocation();
  const pushResults: PosSalePushResult[] = [];
  const allResults: PushChannelResult[] = [];

  for (const item of input.items) {
    await applyInventoryMovement(item.variantId, location.id, -item.quantity, {
      type: "venta_presencial",
      referenceType: "order",
      referenceId: order.id,
      userId: input.userId ?? null,
    });
    const results = await pushStockToOtherChannels(item.variantId, null, pushClients);
    allResults.push(...results);
    pushResults.push({ variantId: item.variantId, results });
  }

  // Bug real encontrado en la prueba del usuario: sin esto, el pedido se
  // quedaba en "pendiente" para siempre aunque el push hubiera funcionado
  // — `createPosSale` lo crea en "pendiente" y nada lo actualizaba después.
  // Fase 3g: ahora también guarda el detalle del error (si lo hay) para
  // que el Dashboard lo muestre y el usuario pueda reintentar.
  const lastSyncError = summarizePushErrors(allResults);
  const lastSyncErrorCode = summarizePushErrorCodes(allResults);
  await updateOrderSyncStatus(order.id, lastSyncError ? "error" : "sincronizado", lastSyncError, lastSyncErrorCode);

  await recordAudit({
    userId: input.userId ?? null,
    action: "venta_presencial",
    entityType: "order",
    entityId: order.id,
    after: { items: input.items, paymentMethod: input.paymentMethod, total: order.total, orderNumber },
  });

  return { orderId: order.id, orderNumber, pushResults };
}
