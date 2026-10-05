/**
 * Fase 3f: números correlativos que la propia app asigna — hoy solo a las
 * ventas de mostrador (venta presencial), que no vienen de ningún canal y
 * por lo tanto no tienen un "número de pedido" que traer de ninguna API
 * (a diferencia de Shopify/Mercado Libre, ver Fase 3d/3e en
 * `packages/sync-engine/src/orders.ts`). El usuario pidió el formato
 * "VP-#0001" (VP = Venta Presencial). El valor numérico lo entrega
 * `nextSequenceValue("venta_presencial")` en `@blacksand/db`
 * (`SequenceCounter`, incrementado de forma atómica) — esta función solo
 * da formato, para poder testearla sin tocar la base de datos.
 */
export function formatVentaPresencialNumber(sequenceValue: number): string {
  return `VP-#${String(sequenceValue).padStart(4, "0")}`;
}
