/**
 * Códigos cortos de error de sincronización (push a canales).
 *
 * Motivado por un pedido explícito del usuario: hasta ahora, cuando un push
 * a Mercado Libre o Shopify fallaba, el Dashboard y la pantalla Productos
 * mostraban el TEXTO COMPLETO del error humanizado (a veces varias
 * oraciones, con el ID de la publicación incluido — ver
 * `describeMeliError` en `@blacksand/connector-mercadolibre`) metido
 * directo en la celda de la tabla. El usuario pidió que la tabla muestre
 * solo un código corto (una especie de "etiqueta" del tipo de error) y que
 * el desglose completo viva en otro lugar de la interfaz (un detalle que
 * se abre a pedido, no texto siempre visible).
 *
 * Este catálogo es intencionalmente chico y se espera que crezca: hoy
 * `describeMeliError` solo clasifica un caso puntual de Mercado Libre
 * ("en revisión" / `under_review`) — cualquier otro error (de Mercado
 * Libre no identificado, o de Shopify, que todavía no tiene su propio
 * clasificador) cae en el código genérico `ERROR`. Agregar un caso nuevo
 * es: (1) sumar el código acá con su etiqueta, (2) hacer que el
 * clasificador correspondiente (`describeMeliError` u otro futuro) lo
 * devuelva en vez de `ERROR`.
 *
 * `SIN_PUBLICAR` (nuevo): bug real reportado por el usuario — "no se esta
 * realizando la actualizacion de stock conforme a las ventas que se estan
 * realizando por shopify... el pedido #1151 no se descontó en ML". Causa
 * raíz encontrada: cuando un producto vendido en Shopify NUNCA se publicó
 * en Mercado Libre (no existe ninguna fila `ChannelProductMap` para ese
 * canal — le pasa hoy a la mayoría del catálogo, ver "Productos —
 * visibilidad de plataformas"), el push de stock no tenía NADA que
 * recorrer para ese canal: no fallaba nada, así que el pedido quedaba
 * "sincronizado" igual, sin avisar en ningún lado que en Mercado Libre no
 * se actualizó nada. `SIN_PUBLICAR` (ver `pushStockToOtherChannels` en
 * `@blacksand/sync-engine/push.ts`) convierte ese silencio en un estado
 * visible y accionable.
 *
 * `BLOQUEADO_POLITICA` (nuevo, ronda 5 del bug SKU EM7405MC): Mercado
 * Libre puede rechazar una actualización puntual con 403
 * `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` ("blocked_by":"PolicyAgent") —
 * una capa interna de autorización de Mercado Libre, distinta de un 401
 * (token vencido) o un 400 de validación, y que la propia API no explica
 * en el mensaje. Ver `describeMeliError` en
 * `@blacksand/connector-mercadolibre`.
 *
 * `PAUSADO_SIN_STOCK` (nuevo): bug real reportado por el usuario — un
 * pedido de Shopify (#1153) dejó una variante en 0 stock, la app empujó
 * ese 0 a Mercado Libre, y Mercado Libre pausó la publicación sola por
 * quedar sin stock (comportamiento normal de Mercado Libre, `under_review`/
 * `paused` con motivo `out_of_stock`) — pero como el intento de escritura
 * SIGUIENTE a esa publicación (este mismo push, o el reintento automático
 * del sondeo de pedidos) chocaba contra la publicación ya pausada, se
 * guardaba como el código genérico `EN_REVISION`, y tanto el pedido como
 * el producto se veían con el badge rojo "Error" — pese a que no hay
 * ningún problema que arreglar: el stock local SÍ se descontó bien, y que
 * Mercado Libre pause una publicación sin stock es justamente lo que se
 * espera que pase. `pushStockToOtherChannels`/`applyPatchToChannelMaps`
 * (`@blacksand/sync-engine/push.ts`) ahora distinguen este caso puntual
 * (stock empujado en 0, o la publicación viene con motivo `out_of_stock`)
 * de un "en revisión" genérico y lo guardan con este código aparte, que la
 * UI trata como informativo (no como error real).
 */
export const SYNC_ERROR_CODES = ["EN_REVISION", "SIN_PUBLICAR", "BLOQUEADO_POLITICA", "PAUSADO_SIN_STOCK", "ERROR"] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export interface SyncErrorCodeMeta {
  /** Etiqueta corta en español para el badge (ej. "En revisión"). */
  label: string;
  /** Explicación de una línea — se usa como respaldo si no hay un mensaje de detalle guardado. */
  description: string;
}

export const SYNC_ERROR_CODE_META: Record<SyncErrorCode, SyncErrorCodeMeta> = {
  EN_REVISION: {
    label: "En revisión",
    description:
      "Mercado Libre tiene la publicación en revisión y rechaza el cambio por ahora — no es un error de la app.",
  },
  SIN_PUBLICAR: {
    label: "Sin publicar",
    description:
      "El producto no está publicado en este canal todavía — no hay ninguna publicación ahí para actualizar el stock. Publícalo primero (\"Publicar en ML\" o \"Crear producto\") y después reintentá este pedido.",
  },
  BLOQUEADO_POLITICA: {
    label: "Bloqueado por ML",
    description:
      "Mercado Libre bloqueó esta actualización por una política interna de la cuenta o de la publicación — no es un error de la app. Revisá el detalle para más información.",
  },
  PAUSADO_SIN_STOCK: {
    label: "Pausado (sin stock)",
    description:
      "Mercado Libre pausó esta publicación automáticamente porque el stock llegó a 0 — es su comportamiento normal, no un error de la app. Se reactiva sola (o se puede reactivar a mano desde \"Estado en Mercado Libre\") cuando vuelva a haber stock.",
  },
  ERROR: {
    label: "Error",
    description: "Ocurrió un error al sincronizar con el canal. Ver el detalle para más información.",
  },
};

/** Etiqueta corta para un código — si el código no está en el catálogo (no debería pasar), devuelve el código tal cual para no ocultar información. */
export function syncErrorCodeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return SYNC_ERROR_CODE_META[code as SyncErrorCode]?.label ?? code;
}

/**
 * A pedido del usuario (bug `PAUSADO_SIN_STOCK`): distingue un código de
 * error "informativo" — algo que la app quiere que el usuario VEA, pero
 * que no es un problema real que requiera acción ni deba contarse en los
 * contadores de "errores" del Dashboard/Productos (`EN_REVISION`,
 * `SIN_PUBLICAR`, `PAUSADO_SIN_STOCK`) — de un error real que sí necesita
 * revisión (`BLOQUEADO_POLITICA`, `ERROR` genérico). La UI usa esto para
 * no mostrar el badge rojo "Error" genérico encima de estos códigos (que
 * ya se explican solos con su propio badge) y para no inflar los
 * contadores de "con error" con casos esperados.
 */
export function isInformationalSyncErrorCode(code: string | null | undefined): boolean {
  return code === "EN_REVISION" || code === "SIN_PUBLICAR" || code === "PAUSADO_SIN_STOCK";
}
