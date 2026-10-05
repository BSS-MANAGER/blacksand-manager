import type { ShopifyClient } from "./client.js";
import type { ShopifyNormalizedOrder } from "./types.js";

const ORDERS_PAGE_QUERY = `
  query RecentOrders($cursor: String, $query: String) {
    orders(first: 50, after: $cursor, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        cancelReason
        lineItems(first: 100) {
          nodes {
            quantity
            sku
            variant { id product { id } }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
        refunds {
          id
          refundLineItems(first: 50) {
            nodes {
              quantity
              restockType
            }
          }
        }
      }
    }
  }
`;

interface OrdersPageResponse {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      name: string;
      createdAt: string;
      cancelledAt: string | null;
      cancelReason: string | null;
      lineItems: {
        nodes: Array<{
          quantity: number;
          sku: string | null;
          variant: { id: string; product: { id: string } } | null;
          originalUnitPriceSet: { shopMoney: { amount: string } };
        }>;
      };
      refunds: Array<{
        id: string;
        refundLineItems: { nodes: Array<{ quantity: number; restockType: string | null }> };
      }>;
    }>;
  };
}

/**
 * Fase 3c (cancelaciones): decide si un pedido cancelado de Shopify repuso
 * stock o no, leyendo `restockType` de las líneas de reembolso que Shopify
 * crea junto con la cancelación (`CANCEL`/`RETURN`/`LEGACY_RESTOCK` =
 * repuesto; `NO_RESTOCK` = no repuesto — según la documentación general de
 * Shopify, SIN VERIFICAR todavía contra una cancelación real de esta
 * tienda). Si el pedido no tiene ningún reembolso asociado (nunca se generó
 * uno, p. ej. un pedido cancelado sin cargo) o los `restockType` vienen
 * mezclados/desconocidos, se devuelve `null` a propósito — mejor mandar el
 * pedido a revisión manual en la app que arriesgarse a adivinar mal un
 * ajuste de stock. Devuelve `null` directo si el pedido ni siquiera está
 * cancelado (no aplica).
 */
function detectShopifyRestock(
  cancelledAt: string | null,
  refunds: OrdersPageResponse["orders"]["nodes"][number]["refunds"],
): boolean | null {
  if (!cancelledAt) return null;

  const restockTypes = refunds.flatMap((r) => r.refundLineItems.nodes.map((li) => li.restockType));
  if (restockTypes.length === 0) return null;

  const anyRestocked = restockTypes.some((t) => t === "CANCEL" || t === "RETURN" || t === "LEGACY_RESTOCK");
  const anyNoRestock = restockTypes.some((t) => t === "NO_RESTOCK");

  if (anyRestocked && !anyNoRestock) return true;
  if (anyNoRestock && !anyRestocked) return false;
  return null; // mezcla, o algún restockType nuevo no reconocido — no se adivina.
}

/**
 * Fase 3a (F.3): trae los pedidos MODIFICADOS desde `sinceIso` (todas las
 * páginas) — no solo los creados. Fase 3c: este cambio (antes filtraba por
 * `created_at`) es lo que hace posible detectar la cancelación de un pedido
 * que se había creado ANTES de la ventana de sondeo: cualquier cambio
 * (incluida una cancelación tardía) actualiza `updated_at`, así que sigue
 * cayendo dentro de la ventana normal — no hace falta una ventana aparte
 * como sí necesita Mercado Libre (ver `MELI_CANCEL_RECHECK_HOURS` en
 * `@blacksand/sync-engine`). Los pedidos cancelados YA NO se descartan acá
 * — se marcan (`cancelled`, `restocked`, `cancelReason`) para que el
 * llamador (`orders.ts` en sync-engine) decida qué hacer con el stock.
 */
export async function fetchRecentShopifyOrders(
  client: ShopifyClient,
  sinceIso: string,
): Promise<ShopifyNormalizedOrder[]> {
  const results: ShopifyNormalizedOrder[] = [];
  let cursor: string | null = null;
  const query = `updated_at:>='${sinceIso}'`;

  do {
    const { data }: { data: OrdersPageResponse } = await client.graphql<OrdersPageResponse>(
      ORDERS_PAGE_QUERY,
      { cursor, query },
    );

    for (const node of data.orders.nodes) {
      results.push({
        channelOrderId: node.id,
        name: node.name,
        createdAt: node.createdAt,
        cancelled: node.cancelledAt !== null,
        restocked: detectShopifyRestock(node.cancelledAt, node.refunds),
        cancelReason: node.cancelReason ?? null,
        lines: node.lineItems.nodes.map((line) => ({
          channelProductId: line.variant?.product.id ?? null,
          channelVariantId: line.variant?.id ?? null,
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: Number(line.originalUnitPriceSet.shopMoney.amount),
        })),
      });
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  return results;
}

const ORDER_NAMES_BY_ID_QUERY = `
  query OrderNamesById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
      }
    }
  }
`;

/**
 * Fase 3e (correlativo de pedidos): trae el "name" (el correlativo real,
 * ej. "#1023") de pedidos YA CONOCIDOS por su `channelOrderId` (el GID que
 * ya se guardó en `Order.channelOrderId`) — usado solo para RELLENAR el
 * `orderNumber` de pedidos que se ingresaron antes de que ese campo
 * existiera (ver `backfillOrderNumbers` en `@blacksand/sync-engine`), no
 * para el sondeo normal (que ya trae `name` de una junto con cada pedido
 * en `fetchRecentShopifyOrders`). Se pide en lotes de 50 ids con `nodes`
 * (igual que la paginación del resto del conector) para no hacer una
 * consulta por pedido. Un id que ya no exista en Shopify (pedido borrado)
 * simplemente no aparece en la respuesta — el llamador lo deja como está.
 */
export async function fetchOrderNamesByIds(
  client: ShopifyClient,
  channelOrderIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const chunkSize = 50;

  for (let i = 0; i < channelOrderIds.length; i += chunkSize) {
    const chunk = channelOrderIds.slice(i, i + chunkSize);
    const { data } = await client.graphql<{ nodes: Array<{ id: string; name: string } | null> }>(
      ORDER_NAMES_BY_ID_QUERY,
      { ids: chunk },
    );
    for (const node of data.nodes) {
      if (node) result.set(node.id, node.name);
    }
  }

  return result;
}
