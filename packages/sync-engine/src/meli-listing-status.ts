import { listProductsWithSyncStatus, setChannelListingStatus, getChannelByCode, recordAudit } from "@blacksand/db";
import type { MercadoLibreClient } from "@blacksand/connector-mercadolibre";

/**
 * "Estado en Mercado Libre" — nació de un problema real que reportó el
 * usuario: publicó varios productos en lote, Mercado Libre terminó
 * pausando/cerrando muchos de ellos por su cuenta (datos incompletos al
 * momento de publicar, antes de que existieran los fixes de talla/color de
 * esta misma fase), y esos productos quedaban invisibles para la app — ya
 * tenían una fila en `ChannelProductMap` (de cuando se publicaron), así que
 * nunca volvían a aparecer como candidatos en "Publicar en ML", y la
 * pantalla Productos los seguía mostrando como "sincronizado" (que es si
 * ESTA APP logró empujar su último cambio, no si la publicación real sigue
 * viva en Mercado Libre — son dos cosas distintas, ver el comentario en el
 * esquema).
 *
 * Esta pantalla junta, para cada producto con AL MENOS una fila de
 * `mercadolibre` en `ChannelProductMap`, el `listingStatus`/`listingSubStatus`
 * que guardó la ÚLTIMA corrida de `importMercadoLibreCatalog` (que ahora sí
 * lee y guarda `item.status`/`item.sub_status` — antes los descartaba). No
 * vuelve a pedirle nada a Mercado Libre por su cuenta: el usuario corre
 * "Actualizar estado" (mismo botón/acción que "Importar de Mercado Libre")
 * para refrescar, y esta pantalla lee lo que quedó guardado.
 *
 * SIN VERIFICAR EN VIVO todavía (no hay acceso a la API real desde este
 * entorno de desarrollo, mismo criterio que el resto del proyecto): que
 * Mercado Libre de verdad exponga un `sub_status` útil para explicar por
 * qué cerró/pausó una publicación. Si en la práctica viene casi siempre
 * vacío, la pantalla igual deja claro el ID de la publicación para que el
 * usuario revise el detalle completo en su panel de Mercado Libre.
 */

export interface MeliListingIssueRow {
  productId: string;
  productName: string;
  sku: string;
  channelProductId: string;
  /** `null` = nunca se revisó con esta versión de la app. */
  listingStatus: string | null;
  listingSubStatus: string[];
  listingStatusCheckedAt: string | null;
}

/** Deserializa `listingSubStatus` (JSON string en el esquema) de forma defensiva. */
function parseSubStatus(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Una fila por cada publicación de Mercado Libre que la app conoce (un
 * producto puede tener más de una si quedó una publicación vieja CERRADA
 * y después se creó una publicación nueva para el mismo producto — ver el
 * comentario de `hasMeli` en `loadCandidateProducts`, más arriba en este
 * paquete). Ordenado con lo más urgente primero: cerradas, después
 * pausadas/en revisión, después sin revisar, después activas.
 */
export async function listMeliListingIssues(): Promise<MeliListingIssueRow[]> {
  const products = await listProductsWithSyncStatus();
  const rows: MeliListingIssueRow[] = [];

  for (const p of products) {
    const meliMaps = p.channelMap.filter((m) => m.channel.code === "mercadolibre");
    for (const m of meliMaps) {
      rows.push({
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        channelProductId: m.channelProductId,
        listingStatus: m.listingStatus,
        listingSubStatus: parseSubStatus(m.listingSubStatus),
        listingStatusCheckedAt: m.listingStatusCheckedAt ? m.listingStatusCheckedAt.toISOString() : null,
      });
    }
  }

  const statusRank: Record<string, number> = {
    closed: 0,
    paused: 1,
    under_review: 1,
    payment_required: 1,
    inactive: 2,
  };
  const rankOf = (s: string | null) => (s === null ? 3 : (statusRank[s] ?? 4));
  rows.sort((a, b) => rankOf(a.listingStatus) - rankOf(b.listingStatus));

  return rows;
}

export type MeliListingReactivateResult = { ok: true } | { ok: false; reason: string };

/**
 * Intenta reactivar una publicación PAUSADA (`PUT /items/{id}` con
 * `status: "active"`). No se ofrece para publicaciones CERRADAS — Mercado
 * Libre no garantiza poder reactivar un cierre así de simple (depende del
 * motivo), y esas ya vuelven a aparecer como candidatas en "Publicar en
 * ML" para crear una publicación nueva en su lugar (ver el comentario de
 * `hasMeli` en `meli-publish.ts`).
 */
export async function reactivateMeliListing(
  meli: MercadoLibreClient,
  channelProductId: string,
): Promise<MeliListingReactivateResult> {
  const channel = await getChannelByCode("mercadolibre");
  try {
    await meli.updateItemStatus(channelProductId, "active");
    // Se relee el ítem en vez de asumir que el PUT sin error significa que
    // quedó "active" — mismo criterio que el resto de Fase 2b (ej. la
    // verificación de SKU después de publicar): Mercado Libre puede
    // aceptar el PUT y aun así dejar la publicación en un estado distinto
    // si hay alguna otra condición pendiente.
    const confirmed = await meli.getItem(channelProductId);
    await setChannelListingStatus(channel.id, channelProductId, confirmed.status, confirmed.subStatus);
    await recordAudit({
      action: "reactivar_publicacion_meli",
      entityType: "channel_product_map",
      entityId: channelProductId,
      after: { status: confirmed.status },
    });
    if (confirmed.status !== "active") {
      return {
        ok: false,
        reason: `Mercado Libre aceptó el pedido, pero la publicación quedó en estado "${confirmed.status}" en vez de "active" — revísala directo en Mercado Libre.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export type MeliListingCloseResult = { ok: true } | { ok: false; reason: string };

/**
 * "Eliminar publicación" — a pedido directo del usuario: "necesito que la
 * app también me permita borrar publicaciones de ML directamente desde la
 * app". Mercado Libre no expone un borrado permanente vía API para una
 * cuenta con historial (ver el comentario grande en
 * `MercadoLibreClient.updateItemStatus`) — lo que sí hace, siempre
 * documentado, es CERRAR la publicación (`PUT /items/{id}` con
 * `status: "closed"`), que deja de estar visible/comprable. Es el mismo
 * efecto que el botón "Finalizar publicación" del panel de Mercado Libre, y
 * se lo mostramos así al usuario en la confirmación de la UI en vez de
 * prometer un borrado que la API no puede cumplir.
 *
 * Después de cerrar, el producto vuelve a aparecer como candidato en
 * "Publicar en ML" (mismo criterio que una publicación cerrada por Mercado
 * Libre por su cuenta, ver el comentario de `hasMeli` en `meli-publish.ts`)
 * — si el usuario se equivocó, puede volver a publicarlo desde ahí.
 */
export async function closeMeliListing(
  meli: MercadoLibreClient,
  channelProductId: string,
): Promise<MeliListingCloseResult> {
  const channel = await getChannelByCode("mercadolibre");
  try {
    await meli.updateItemStatus(channelProductId, "closed");
    // Mismo criterio que `reactivateMeliListing`: se relee el ítem en vez de
    // asumir que el PUT sin error significa que quedó "closed".
    const confirmed = await meli.getItem(channelProductId);
    await setChannelListingStatus(channel.id, channelProductId, confirmed.status, confirmed.subStatus);
    await recordAudit({
      action: "eliminar_publicacion_meli",
      entityType: "channel_product_map",
      entityId: channelProductId,
      after: { status: confirmed.status },
    });
    if (confirmed.status !== "closed") {
      return {
        ok: false,
        reason: `Mercado Libre aceptó el pedido, pero la publicación quedó en estado "${confirmed.status}" en vez de "closed" — revísala directo en Mercado Libre.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
