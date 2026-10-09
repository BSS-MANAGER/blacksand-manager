import { useEffect, useState } from "react";
import type { ProductRow, ProductVariantRow } from "../../../shared-ipc-types";
import { StatusBadge, ErrorDetailBadge } from "../lib/badge";
import { usePagination, paginate, Pagination } from "../lib/pagination";

/**
 * A pedido del usuario (bug `PAUSADO_SIN_STOCK`, pedido #1153): antes,
 * cualquier `listingStatus !== "active"` (pausada, en revisión, cerrada,
 * lo que sea) se mostraba con el mismo badge rojo "badge-error" — mismo
 * tono para "Mercado Libre cerró la publicación para siempre" que para
 * "Mercado Libre la pausó sola porque el stock llegó a 0", que es
 * comportamiento esperado y se soluciona solo reponiendo stock. Esto
 * distingue ambos casos: "cerrada"/"pago requerido"/"inactiva" siguen en
 * rojo (sí ameritan revisión), "pausada"/"en revisión" usan el tono
 * amarillo de "pendiente" — y cuando el motivo trae `out_of_stock`, la
 * etiqueta lo dice explícitamente en vez de solo "Pausada".
 */
function listingStatusInfo(
  listingStatus: string | null,
  listingSubStatus?: string[],
): { label: string; cls: string } | null {
  if (!listingStatus || listingStatus === "active") return null;
  const sinStock = (listingSubStatus ?? []).some((s) => /out_of_stock/i.test(s));
  if (listingStatus === "closed") return { label: "Cerrada", cls: "badge-error" };
  if (listingStatus === "paused") return { label: sinStock ? "Pausada (sin stock)" : "Pausada", cls: "badge-pendiente" };
  if (listingStatus === "under_review") return { label: sinStock ? "En revisión (sin stock)" : "En revisión", cls: "badge-pendiente" };
  return { label: listingStatus, cls: "badge-error" };
}

/**
 * Nombres legibles por código de canal. Se usan tanto en el resumen de
 * plataformas por producto como en el detalle por variante, para que se
 * pueda distinguir Shopify de Mercado Libre sin tener que pasar el mouse
 * por encima de cada badge (antes el código de canal solo aparecía en el
 * `title` del badge, no como texto visible).
 */
const CHANNEL_LABELS: Record<string, string> = {
  shopify: "Shopify",
  mercadolibre: "Mercado Libre",
  meta: "Meta",
};

function channelLabel(code: string): string {
  return CHANNEL_LABELS[code] ?? code;
}

type ChannelFilter = "todos" | "sin-meli" | "sin-shopify" | "ambos" | "ninguno";

interface VariantEditState {
  sku: string;
  price: string;
  quantity: string;
  saving: boolean;
  error: string | null;
  results: { channelCode: string; ok: boolean; error?: string; errorCode?: string; note?: string }[] | null;
}

function initialEditState(v: ProductVariantRow): VariantEditState {
  return {
    sku: v.skuVariant,
    price: v.price != null ? String(v.price) : "",
    quantity: String(v.quantityOnHand),
    saving: false,
    error: null,
    results: null,
  };
}

export default function ProductosPage() {
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("todos");
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, VariantEditState>>({});
  const [syncingMeli, setSyncingMeli] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function load() {
    window.blacksand.products
      .list()
      .then((data) => {
        setRows(data);
        // Conserva ediciones en curso; solo agrega estado inicial para
        // variantes que todavía no tienen uno (primera carga, o nuevas tras
        // una importación).
        setEdits((prev) => {
          const next = { ...prev };
          for (const p of data) {
            for (const v of p.variants) {
              if (!next[v.id]) next[v.id] = initialEditState(v);
            }
          }
          return next;
        });
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    load();
  }, []);

  /**
   * "Sincronización directa de la publicación" (a pedido del usuario):
   * vuelve a traer el catálogo completo de Mercado Libre (los 6 estados que
   * cubre `fetchAllItems`, ver `importMercadoLibreCatalog`) y, en la misma
   * pasada, detecta las publicaciones que la app tenía mapeadas y que ya no
   * existen del todo en Mercado Libre (el caso real reportado: producto
   * desactivado por la app y borrado a mano en Mercado Libre para volver a
   * subirlo) — esas quedan marcadas como pendientes de publicar de nuevo.
   * Mismo botón/acción que "Importar de Mercado Libre" en el Dashboard,
   * puesto acá también porque es exactamente lo que hace falta revisar
   * antes de confiar en el resumen de abajo.
   */
  async function syncMeliStatus() {
    setSyncingMeli(true);
    setSyncMessage(null);
    setError(null);
    try {
      const result = await window.blacksand.sync.runImportNow("mercadolibre");
      setSyncMessage(
        `Estado de Mercado Libre actualizado: ${result.totalItems} publicación(es) revisada(s) · ` +
          `${result.matched} emparejadas con Shopify · ${result.createdNew} nuevas en el catálogo` +
          (result.removedListings
            ? ` · ${result.removedListings} ya no existen en Mercado Libre y volvieron a "pendiente de publicar".`
            : " · ninguna publicación desapareció desde la última revisión."),
      );
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncingMeli(false);
    }
  }

  /**
   * Una fila de canal "cerrada" (`listingStatus === "closed"`, hoy solo
   * Mercado Libre lo trackea) NO cuenta como "está en ese canal" — mismo
   * criterio que `loadCandidateProducts` en @blacksand/sync-engine: una
   * publicación cerrada por Mercado Libre ya no está viva, así que el
   * producto vuelve a verse como "Sin Mercado Libre" acá y vuelve a
   * aparecer como candidato en "Publicar en ML". Ver "Estado en ML" para
   * el detalle completo de cada publicación (activa/pausada/cerrada).
   */
  function hasChannel(p: ProductRow, code: string): boolean {
    return p.channels.some((c) => c.code === code && c.listingStatus !== "closed");
  }

  const textFiltered = rows?.filter(
    (p) =>
      p.name.toLowerCase().includes(filter.toLowerCase()) ||
      p.sku.toLowerCase().includes(filter.toLowerCase()),
  );

  const filtered = textFiltered?.filter((p) => {
    const enMeli = hasChannel(p, "mercadolibre");
    const enShopify = hasChannel(p, "shopify");
    if (channelFilter === "sin-meli") return !enMeli;
    if (channelFilter === "sin-shopify") return !enShopify;
    if (channelFilter === "ambos") return enMeli && enShopify;
    // A pedido del usuario (bug SKU EM9724MC): cuando la app no encuentra
    // el SKU real de una publicación de Mercado Libre (antes, publicaciones
    // que guardan el SKU como atributo "SELLER_SKU" en vez del campo
    // clásico — ver `extractSellerSkuAttribute` en
    // `@blacksand/connector-mercadolibre`), crea un producto "fantasma"
    // nuevo con un SKU inventado en vez de reconocer el producto que ya
    // existía desde Shopify. Corregido el origen del bug, estos fantasmas
    // YA CREADOS no desaparecen solos: la próxima importación de Mercado
    // Libre repara el emparejamiento (mueve la publicación al producto
    // correcto), pero el producto fantasma queda huérfano — sin Shopify Y
    // sin Mercado Libre — listo para revisar y borrar con "Eliminar
    // producto". Este filtro es la forma de encontrarlos todos juntos en
    // vez de tener que buscarlos uno por uno.
    if (channelFilter === "ninguno") return !enMeli && !enShopify;
    return true;
  });

  // Conteos sobre el resultado del filtro de texto (no del de canal), para
  // que el desplegable de canal siempre muestre cuántos productos caen en
  // cada categoría, aunque en ese momento se esté viendo otra.
  const countSinMeli = textFiltered?.filter((p) => !hasChannel(p, "mercadolibre")).length ?? 0;
  const countSinShopify = textFiltered?.filter((p) => !hasChannel(p, "shopify")).length ?? 0;
  const countAmbos = textFiltered?.filter((p) => hasChannel(p, "mercadolibre") && hasChannel(p, "shopify")).length ?? 0;
  const countNinguno = textFiltered?.filter((p) => !hasChannel(p, "mercadolibre") && !hasChannel(p, "shopify")).length ?? 0;

  /**
   * A pedido del usuario: `variantHasChannel` es la MISMA regla que
   * `hasChannel` de arriba (mismo criterio "cerrada" = "no cuenta"), pero a
   * nivel de VARIANTE en vez de a nivel de producto. Hace falta aparte
   * porque el resumen de reconciliación de más abajo necesita calzar
   * EXACTO con "Publicar en ML" (`loadCandidateProducts` en
   * `@blacksand/sync-engine/meli-publish.ts`), que arma su lista variante
   * por variante — cada variante de Shopify es su propia publicación en
   * Mercado Libre, así que "pendiente por publicar" también tiene que
   * contarse variante por variante. Para la gran mayoría del catálogo (1
   * SKU de Shopify = 1 producto = 1 variante, ver el comentario de Fase 1
   * en el importador) esto da exactamente lo mismo que contar productos;
   * solo puede diferir en un producto con más de una variante.
   */
  function variantHasChannel(v: ProductVariantRow, code: string): boolean {
    return v.channels.some((c) => c.code === code && c.listingStatus !== "closed");
  }

  /**
   * Resumen de reconciliación (a pedido del usuario) — a diferencia de los
   * conteos de arriba (que siguen la búsqueda de texto, para el
   * desplegable de canal), estos SIEMPRE se calculan sobre el catálogo
   * completo sin filtrar: son "la foto real" del catálogo, no de lo que se
   * está mirando en este momento. Shopify es la plataforma matriz (a pedido
   * del usuario), así que el total de referencia es "variantes con Shopify
   * mapeado" — publicadas en ML + pendientes de publicar SIEMPRE suman ese
   * total exacto, por diseño (son las dos mitades del mismo conjunto). A
   * pedido del usuario ("¿'Publicar en ML' es Shopify menos Mercado
   * Libre?"): sí, y `pendientePublicar` acá abajo es el MISMO número que la
   * suma de `productCount` de todos los grupos en "Publicar en ML" —
   * mismos datos, misma regla, misma granularidad (por variante).
   */
  const allVariants = rows?.flatMap((p) => p.variants) ?? [];
  const totalShopify = allVariants.filter((v) => variantHasChannel(v, "shopify")).length;
  const yaEnMeli = allVariants.filter((v) => variantHasChannel(v, "shopify") && variantHasChannel(v, "mercadolibre")).length;
  const pendientePublicar = totalShopify - yaEnMeli;
  const soloEnMeli = allVariants.filter((v) => variantHasChannel(v, "mercadolibre") && !variantHasChannel(v, "shopify")).length;

  // A pedido del usuario: con 300+ productos la pantalla se hacía
  // interminable — se pagina de a 10, y cambiar la búsqueda o el filtro de
  // canal vuelve a la página 1 (si no, se podría quedar mirando una página
  // vacía después de filtrar).
  const pg = usePagination(filtered?.length ?? 0, `${filter}|${channelFilter}`);
  const pageProducts = filtered ? paginate(filtered, pg.start, pg.end) : null;

  function updateEdit(variantId: string, patch: Partial<VariantEditState>) {
    setEdits((prev) => ({ ...prev, [variantId]: { ...prev[variantId], ...patch } }));
  }

  /**
   * "Eliminar producto" (a pedido del usuario, ej. EM 6628MC — un producto
   * que quedó en el catálogo local sin existir de verdad ni en Shopify ni
   * en Mercado Libre). Flujo en dos pasos:
   *
   * 1. Confirmación genérica + `products.delete(id)` SIN forzar. Si el
   *    producto no tiene pedidos en su historial, se borra ahí mismo.
   * 2. Si el backend devuelve `{ deleted: false, reason: "has_history",
   *    channels, orderCount }` (a pedido del usuario, ronda 2 de este
   *    feature: antes esto directamente bloqueaba el borrado), se muestra
   *    una SEGUNDA advertencia nombrando en qué plataforma(s) hay ventas y
   *    cuántos pedidos — recién si el usuario confirma esa, se llama nuevo
   *    a `products.delete(id, true)` para forzar el borrado.
   *
   * En ningún caso esto toca Shopify ni Mercado Libre — si el producto
   * sigue publicado en algún canal, esa publicación queda intacta ahí (y
   * volvería a traerse sola en la próxima importación).
   */
  async function handleDeleteProduct(p: ProductRow) {
    const confirmed = window.confirm(
      `¿Eliminar "${p.name}" (SKU ${p.sku}) del catálogo de la app?\n\n` +
        `Esto NO borra nada en Shopify ni en Mercado Libre — solo quita el registro local. ` +
        `Si el producto todavía existe publicado en algún canal, va a volver a aparecer solo ` +
        `en la próxima importación.`,
    );
    if (!confirmed) return;

    setDeletingId(p.id);
    setError(null);
    try {
      const result = await window.blacksand.products.delete(p.id);
      if (!result.deleted) {
        const channelNames = result.channels
          .map((c) => (c === "venta_presencial" ? "Venta presencial" : channelLabel(c)))
          .join(", ");
        const forceConfirmed = window.confirm(
          `"${p.name}" (SKU ${p.sku}) tiene ${result.orderCount} pedido(s) en su historial de: ` +
            `${channelNames}.\n\n` +
            `Si lo eliminás igual, esas líneas de pedido van a quedar sin el producto vinculado ` +
            `(se guarda una copia del SKU/nombre tal cual estaban ahora, así el historial sigue ` +
            `siendo legible, pero ya no vas a poder editarlo ni volver a publicarlo desde ahí).\n\n` +
            `¿Eliminar de todas formas?`,
        );
        if (!forceConfirmed) return;

        await window.blacksand.products.delete(p.id, true);
      }
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function saveVariant(variant: ProductVariantRow) {
    const edit = edits[variant.id];
    if (!edit) return;
    updateEdit(variant.id, { saving: true, error: null, results: null });

    const patch: { variantId: string; sku?: string; price?: number; quantity?: number } = {
      variantId: variant.id,
    };
    const trimmedSku = edit.sku.trim();
    if (trimmedSku !== variant.skuVariant) patch.sku = trimmedSku;

    const parsedPrice = edit.price.trim() === "" ? null : Number(edit.price);
    if (parsedPrice !== null && !Number.isNaN(parsedPrice) && parsedPrice !== variant.price) {
      patch.price = parsedPrice;
    }

    const parsedQuantity = edit.quantity.trim() === "" ? null : Number(edit.quantity);
    if (parsedQuantity !== null && !Number.isNaN(parsedQuantity) && parsedQuantity !== variant.quantityOnHand) {
      patch.quantity = parsedQuantity;
    }

    if (patch.sku === undefined && patch.price === undefined && patch.quantity === undefined) {
      updateEdit(variant.id, { saving: false, error: "No hay cambios para guardar." });
      return;
    }

    try {
      const result = await window.blacksand.products.update(patch);
      updateEdit(variant.id, { saving: false, results: result.results });
      load(); // refresca stock/estado local ya actualizado tras el push
    } catch (err) {
      updateEdit(variant.id, { saving: false, error: String(err) });
    }
  }

  return (
    <div>
      <h1>Productos</h1>
      <p className="page-subtitle">
        Catálogo central (E.2: SKU, código de barras, nombre, marca, categoría, costo, precio,
        variantes). Edita el SKU, precio y stock de una variante ya existente y el cambio se
        empuja de inmediato a los canales donde ya está mapeada. Para publicar en Mercado Libre
        productos que todavía no tienen una publicación (ver el resumen abajo), usa "Publicar en
        ML" en el menú.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {rows !== null && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Resumen Shopify ↔ Mercado Libre</h2>
          <p className="page-subtitle" style={{ marginBottom: 12 }}>
            Shopify es la plataforma matriz: el total de referencia es el catálogo de Shopify, y
            "ya en Mercado Libre" + "pendientes de publicar" siempre suman ese total exacto.
          </p>
          <div className="kpi-row">
            <div className="kpi">
              <div className="kpi-value">{totalShopify}</div>
              <div className="kpi-label">Total en Shopify (matriz)</div>
            </div>
            <div className="kpi">
              <div className="kpi-value">{yaEnMeli}</div>
              <div className="kpi-label">Ya publicados en Mercado Libre</div>
            </div>
            <div
              className="kpi"
              style={{ cursor: "pointer" }}
              onClick={() => setChannelFilter("sin-meli")}
              title="Ver la lista filtrada abajo"
            >
              <div className="kpi-value">{pendientePublicar}</div>
              <div className="kpi-label">Pendientes de publicar en ML</div>
            </div>
            <div
              className="kpi"
              style={{ cursor: "pointer", borderColor: soloEnMeli > 0 ? "var(--err)" : undefined }}
              onClick={() => setChannelFilter("sin-shopify")}
              title="Ver la lista filtrada abajo"
            >
              <div className="kpi-value">{soloEnMeli}</div>
              <div className="kpi-label">En Mercado Libre pero NO en Shopify — revisar</div>
            </div>
          </div>
          {soloEnMeli > 0 && (
            <p className="page-subtitle" style={{ marginBottom: 12 }}>
              Hay {soloEnMeli} publicación(es) en Mercado Libre sin ningún producto emparejado en
              Shopify — puede ser una publicación manual con un SKU distinto, o algo que ya no
              debería seguir ahí. Hacé clic arriba (o elegí "Sin Shopify" en el filtro de abajo)
              para revisarlas una por una.
            </p>
          )}
          <button disabled={syncingMeli} onClick={syncMeliStatus}>
            {syncingMeli ? "Sincronizando con Mercado Libre…" : "Sincronizar estado de Mercado Libre"}
          </button>
          <p className="page-subtitle" style={{ marginTop: 6, marginBottom: 0 }}>
            Vuelve a revisar el estado REAL de cada publicación contra Mercado Libre (activa,
            pausada, cerrada, o eliminada del todo) — si borraste una publicación a mano para
            volver a subirla, este botón es lo que hace que ese producto vuelva a "pendiente de
            publicar" en vez de seguir viéndose como ya publicado.
          </p>
          {syncMessage && (
            <div className="success-banner" style={{ marginTop: 10, marginBottom: 0 }}>
              {syncMessage}
            </div>
          )}
        </div>
      )}

      <div className="form-row">
        <label>Buscar por nombre o SKU</label>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Ej: casco, SKU-001…" />
      </div>

      <div className="form-row">
        <label>Filtrar por presencia en canales</label>
        <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as ChannelFilter)}>
          <option value="todos">Todos</option>
          <option value="sin-meli">Sin Mercado Libre ({countSinMeli})</option>
          <option value="sin-shopify">Sin Shopify ({countSinShopify})</option>
          <option value="ambos">En ambos canales ({countAmbos})</option>
          <option value="ninguno">Huérfanos — sin ningún canal ({countNinguno})</option>
        </select>
      </div>

      {rows !== null && (
        <p className="page-subtitle" style={{ marginTop: -4, marginBottom: 12 }}>
          {textFiltered?.length ?? 0} producto(s) · {countSinMeli} sin Mercado Libre · {countSinShopify} sin
          Shopify · {countAmbos} en ambos canales · {countNinguno} huérfanos (sin ningún canal — candidatos a
          "Eliminar producto"). Antes de "Publicar todo automáticamente" en Mercado Libre,
          revisa "Sin Mercado Libre" — si alguno de esos ya existe publicado manualmente en ML con un SKU
          distinto al de Shopify, no va a aparecer emparejado aquí y publicarlo de nuevo crearía un duplicado
          en Mercado Libre. Lo más seguro es correr primero "Importar de Mercado Libre" en el Dashboard para
          traer cualquier publicación manual reciente, y revisar caso a caso los que sigan apareciendo "sin
          Mercado Libre" antes de publicarlos.
        </p>
      )}

      {rows === null ? (
        <div className="card">
          <div className="empty-state">Cargando…</div>
        </div>
      ) : filtered && filtered.length > 0 ? (
        <>
        {pageProducts!.map((p) => (
          <div className="card" key={p.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <button
                className="small secondary"
                disabled={deletingId === p.id}
                onClick={() => handleDeleteProduct(p)}
                title="Elimina este producto solo de la app — no toca Shopify ni Mercado Libre."
              >
                {deletingId === p.id ? "Eliminando…" : "Eliminar producto"}
              </button>
            </div>
            <p className="page-subtitle" style={{ marginBottom: 6 }}>
              {p.brand ?? "—"} · {p.category ?? "—"} · SKU producto: {p.sku}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Plataformas:</span>
              {(["shopify", "mercadolibre", "meta"] as const).map((code) => {
                const matches = p.channels.filter((c) => c.code === code);
                if (matches.length === 0) return null;
                // Si hay más de una fila para el mismo canal (ej. una
                // publicación vieja CERRADA de Mercado Libre y una nueva
                // creada después), se prioriza mostrar la que sigue viva —
                // ver "Estado en ML" para el detalle de todas.
                const match = matches.find((c) => c.listingStatus !== "closed") ?? matches[0]!;
                const listingInfo = listingStatusInfo(match.listingStatus, match.listingSubStatus);
                return (
                  <span key={code} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <strong style={{ fontSize: 12 }}>{channelLabel(code)}</strong>
                    <StatusBadge status={match.status} code={match.lastErrorCode} />
                    {listingInfo && (
                      <span
                        className={`badge ${listingInfo.cls}`}
                        title="Estado real de la publicación en el canal (distinto de si esta app logró empujar el último cambio) — ver 'Estado en ML' para el detalle."
                      >
                        {listingInfo.label}
                      </span>
                    )}
                  </span>
                );
              })}
              {!hasChannel(p, "mercadolibre") && (
                <span className="badge badge-pendiente" title="Este producto no está emparejado con ninguna publicación de Mercado Libre. Si ya existe publicado allí con otro SKU, publicarlo lo duplicaría.">
                  Sin Mercado Libre
                </span>
              )}
              {!hasChannel(p, "shopify") && (
                <span className="badge badge-pendiente">Sin Shopify</span>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th>SKU variante</th>
                  <th>Precio</th>
                  <th>Stock</th>
                  <th>Canales</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {p.variants.map((v) => {
                  const edit = edits[v.id] ?? initialEditState(v);
                  return (
                    <tr key={v.id}>
                      <td>
                        <input value={edit.sku} onChange={(e) => updateEdit(v.id, { sku: e.target.value })} />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          value={edit.price}
                          onChange={(e) => updateEdit(v.id, { price: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={edit.quantity}
                          onChange={(e) => updateEdit(v.id, { quantity: e.target.value })}
                        />
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {v.channels.map((c) => (
                            <span
                              key={c.code}
                              style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
                            >
                              <span style={{ fontSize: 11 }}>{channelLabel(c.code)}</span>
                              <StatusBadge status={c.status} code={c.lastErrorCode} />
                              {c.status === "error" && (
                                <ErrorDetailBadge code={c.lastErrorCode} detail={c.lastError} />
                              )}
                            </span>
                          ))}
                          {v.channels.length === 0 && <span style={{ color: "var(--text-dim)" }}>Sin canal</span>}
                        </div>
                        {edit.results && (
                          <div style={{ marginTop: 6, fontSize: 12 }}>
                            {edit.results.length === 0 && (
                              <span style={{ color: "var(--text-dim)" }}>
                                Guardado en local (sin canales mapeados para esta variante).
                              </span>
                            )}
                            {edit.results.map((r) => (
                              <div
                                key={r.channelCode}
                                style={{ display: "flex", alignItems: "center", gap: 6, color: r.ok ? "var(--ok)" : "var(--err)" }}
                              >
                                {r.ok ? "✅" : "❌"} {r.channelCode}
                                {!r.ok && <ErrorDetailBadge code={r.errorCode} detail={r.error} />}
                                {r.ok && r.note && <span style={{ color: "var(--warn)" }}>— {r.note}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {edit.error && (
                          <div className="error-banner" style={{ marginTop: 6 }}>
                            {edit.error}
                          </div>
                        )}
                      </td>
                      <td>
                        <button className="small" disabled={edit.saving} onClick={() => saveVariant(v)}>
                          {edit.saving ? "Guardando…" : "Guardar y sincronizar"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        <Pagination page={pg.page} totalPages={pg.totalPages} totalItems={filtered.length} pageSize={pg.pageSize} onChange={pg.setPage} />
        </>
      ) : (
        <div className="card">
          <div className="empty-state">
            Sin productos todavía. Importa el catálogo desde el Dashboard después de conectar un
            canal en Configuración.
          </div>
        </div>
      )}
    </div>
  );
}
