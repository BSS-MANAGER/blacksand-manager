import { useEffect, useState } from "react";
import type {
  MeliListingIssueRow,
  MeliDuplicateGroup,
  MeliBrandFixPreviewRow,
  MeliBrandFixItemResult,
  MeliSkuFixPreviewRow,
  MeliSkuFixItemResult,
  MeliSkuPrefixBrandOverrideRow,
} from "../../../shared-ipc-types";
// MeliListingCloseResult no hace falta importarlo aparte: `close()` devuelve
// el mismo shape que `reactivate()` y su resultado solo se usa localmente
// para armar el mensaje ✅/❌ (ver `closeListing` más abajo).
import { usePagination, paginate, Pagination } from "../lib/pagination";

/**
 * "Estado en Mercado Libre" — nació de un problema real: el usuario publicó
 * varios productos en lote y Mercado Libre terminó pausando/cerrando
 * muchos de ellos por su cuenta (datos incompletos al momento de publicar,
 * antes de los fixes de talla/color de esta misma fase). Esos productos
 * quedaban invisibles en la app — ya tenían una fila de Mercado Libre desde
 * que se publicaron, así que nunca volvían a aparecer en "Publicar en ML",
 * y Productos los seguía mostrando como si estuvieran bien (ver el
 * comentario grande en `ChannelProductMap.listingStatus`, esquema).
 *
 * Esta pantalla lee lo que quedó guardado en la ÚLTIMA corrida de
 * "Importar de Mercado Libre" (el botón de acá abajo dispara lo mismo) — no
 * le pregunta nada a Mercado Libre por su cuenta al abrir.
 */

const STATUS_LABELS: Record<string, string> = {
  active: "Activa",
  paused: "Pausada",
  closed: "Cerrada",
  under_review: "En revisión",
  inactive: "Inactiva",
  payment_required: "Pago pendiente",
};

/**
 * Traducción best-effort de los códigos de `sub_status` más comunes que
 * documenta Mercado Libre — SIN VERIFICAR contra un caso real todavía (ver
 * la nota grande en `meli-listing-status.ts`, @blacksand/sync-engine). Un
 * código no listado se muestra tal cual (crudo) en vez de ocultarse.
 */
const SUB_STATUS_LABELS: Record<string, string> = {
  out_of_stock: "Sin stock declarado",
  deleted: "Eliminada",
  suspended: "Suspendida por Mercado Libre",
  cbt_disabled: "Deshabilitada (envío internacional)",
  payment_required: "Pago pendiente de la publicación",
};

function statusLabel(status: string | null): string {
  if (status === null) return "Sin revisar";
  return STATUS_LABELS[status] ?? status;
}

function subStatusLabel(code: string): string {
  return SUB_STATUS_LABELS[code] ?? code;
}

type StatusFilter = "todos" | "cerradas" | "pausadas" | "sin_revisar" | "activas";

export default function EstadoMeliPage() {
  const [rows, setRows] = useState<MeliListingIssueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("cerradas");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [reactivateBusy, setReactivateBusy] = useState<Record<string, boolean>>({});
  const [reactivateResults, setReactivateResults] = useState<Record<string, string>>({});

  // --- Eliminar publicación --------------------------------------------
  // A pedido del usuario: "necesito que la app tambien me permita borrar
  // publicaciones de ML directamente desde la app". Mercado Libre no
  // expone un borrado permanente vía API para una cuenta con historial —
  // esto CIERRA la publicación (ver el comentario grande en
  // `closeMeliListing`, @blacksand/sync-engine), que es el equivalente
  // funcional: deja de estar visible/comprable, y se le avisa así al
  // usuario en el diálogo de confirmación en vez de prometer un borrado
  // que la API no puede cumplir.
  const [closeBusy, setCloseBusy] = useState<Record<string, boolean>>({});
  const [closeResults, setCloseResults] = useState<Record<string, string>>({});

  // --- Cerrar publicaciones duplicadas -------------------------------------
  // Caso real encontrado (septiembre 2026): ~20 productos quedaron
  // publicados DOS VECES en Mercado Libre — un doble clic en "Publicar
  // lote"/"Publicar todo automáticamente" alcanzó a disparar dos
  // publicaciones casi simultáneas para el mismo producto antes de que la
  // primera terminara de guardarse (ya corregido, ver `publishGuardRef` en
  // `PublicarMeliPage.tsx`). Esto deja revisar y cerrar los que quedaron
  // duplicados ANTES del fix, eligiendo a mano cuál publicación conservar
  // de cada grupo.
  const [dupGroups, setDupGroups] = useState<MeliDuplicateGroup[] | null>(null);
  const [dupPreviewBusy, setDupPreviewBusy] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  /** variantId -> channelProductId elegido para CONSERVAR en ese grupo. */
  const [dupKeepChoice, setDupKeepChoice] = useState<Record<string, string>>({});
  const [dupRunBusy, setDupRunBusy] = useState(false);
  const [dupResults, setDupResults] = useState<Record<string, string>>({});

  // --- Corregir marca por prefijo de SKU -----------------------------------
  // Caso real: productos con SKU que empieza con "EM" (EmersonGear)
  // quedaron publicados con la marca "BLACK SAND SECURITY" (marca por
  // defecto de Configuración) en vez de su marca real.
  const [brandFixSkuPrefix, setBrandFixSkuPrefix] = useState("EM");
  const [brandFixNewBrand, setBrandFixNewBrand] = useState("EmersonGear");
  const [brandFixUpdateLocal, setBrandFixUpdateLocal] = useState(true);
  const [brandFixPreview, setBrandFixPreview] = useState<MeliBrandFixPreviewRow[] | null>(null);
  const [brandFixPreviewBusy, setBrandFixPreviewBusy] = useState(false);
  const [brandFixError, setBrandFixError] = useState<string | null>(null);
  const [brandFixRunBusy, setBrandFixRunBusy] = useState(false);
  const [brandFixResults, setBrandFixResults] = useState<Record<string, MeliBrandFixItemResult>>({});

  // --- Corregir SKU incorrecto en Mercado Libre ----------------------------
  // A pedido directo del usuario: "revisa los productos publicados en ML y
  // corrige los sku que estan con error" — a diferencia de la tarjeta de
  // marca de arriba, acá no hace falta que el usuario escriba nada: el
  // valor correcto ya está guardado localmente (viene de Shopify).
  const [skuFixPreview, setSkuFixPreview] = useState<MeliSkuFixPreviewRow[] | null>(null);
  const [skuFixPreviewBusy, setSkuFixPreviewBusy] = useState(false);
  const [skuFixError, setSkuFixError] = useState<string | null>(null);
  const [skuFixRunBusy, setSkuFixRunBusy] = useState(false);
  const [skuFixResults, setSkuFixResults] = useState<Record<string, MeliSkuFixItemResult>>({});

  // --- Marca automática por prefijo de SKU (publicaciones NUEVAS) ---------
  // Distinto de la tarjeta de arriba (que corrige lo YA publicado): esto es
  // la regla permanente para que toda publicación nueva con ese prefijo de
  // SKU salga con la marca correcta desde el principio, sin depender de que
  // el producto tenga "Proveedor" cargado en Shopify.
  const [skuPrefixRules, setSkuPrefixRules] = useState<MeliSkuPrefixBrandOverrideRow[] | null>(null);
  const [newRulePrefix, setNewRulePrefix] = useState("");
  const [newRuleBrand, setNewRuleBrand] = useState("");
  const [ruleSaveBusy, setRuleSaveBusy] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleDeleteBusy, setRuleDeleteBusy] = useState<Record<string, boolean>>({});

  function load() {
    window.blacksand.meliListing
      .listIssues()
      .then(setRows)
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    load();
    loadSkuPrefixRules();
  }, []);

  function loadSkuPrefixRules() {
    window.blacksand.meliSkuPrefixBrand
      .list()
      .then(setSkuPrefixRules)
      .catch((err) => setRuleError(String(err)));
  }

  async function saveSkuPrefixRule() {
    setRuleSaveBusy(true);
    setRuleError(null);
    try {
      await window.blacksand.meliSkuPrefixBrand.save({
        skuPrefix: newRulePrefix.trim(),
        brand: newRuleBrand.trim(),
      });
      setNewRulePrefix("");
      setNewRuleBrand("");
      loadSkuPrefixRules();
    } catch (err) {
      setRuleError(String(err));
    } finally {
      setRuleSaveBusy(false);
    }
  }

  async function deleteSkuPrefixRule(rule: MeliSkuPrefixBrandOverrideRow) {
    setRuleDeleteBusy((prev) => ({ ...prev, [rule.id]: true }));
    try {
      await window.blacksand.meliSkuPrefixBrand.delete(rule.id);
      loadSkuPrefixRules();
    } catch (err) {
      setRuleError(String(err));
    } finally {
      setRuleDeleteBusy((prev) => ({ ...prev, [rule.id]: false }));
    }
  }

  async function refreshFromMeli() {
    setRefreshBusy(true);
    setError(null);
    setRefreshMessage(null);
    try {
      // Mismo botón/acción que "Importar de Mercado Libre" del Dashboard —
      // ahora esa importación también guarda el estado real de cada
      // publicación (antes lo descartaba), así que no hace falta un flujo
      // aparte para refrescar esta pantalla.
      const result = await window.blacksand.sync.runImportNow("mercadolibre");
      setRefreshMessage(
        `Revisadas ${result.totalItems} publicación(es) de Mercado Libre — ${result.matched} emparejadas, ${result.createdNew} nuevas, ${result.ambiguous} ambiguas.`,
      );
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshBusy(false);
    }
  }

  async function reactivate(row: MeliListingIssueRow) {
    setReactivateBusy((prev) => ({ ...prev, [row.channelProductId]: true }));
    setReactivateResults((prev) => {
      const next = { ...prev };
      delete next[row.channelProductId];
      return next;
    });
    try {
      const result = await window.blacksand.meliListing.reactivate(row.channelProductId);
      setReactivateResults((prev) => ({
        ...prev,
        [row.channelProductId]: result.ok ? "✅ Reactivada." : `❌ ${result.reason}`,
      }));
      load();
    } catch (err) {
      setReactivateResults((prev) => ({ ...prev, [row.channelProductId]: `❌ ${String(err)}` }));
    } finally {
      setReactivateBusy((prev) => ({ ...prev, [row.channelProductId]: false }));
    }
  }

  async function closeListing(row: MeliListingIssueRow) {
    const confirmed = window.confirm(
      `¿Eliminar la publicación de "${row.productName}" (SKU ${row.sku}) en Mercado Libre?\n\n` +
        `Mercado Libre no permite un borrado permanente vía API — esto la CIERRA (mismo efecto que ` +
        `"Finalizar publicación" en tu panel de Mercado Libre): deja de estar visible y ya no se puede ` +
        `comprar. Si te equivocaste, vas a poder volver a publicarla desde "Publicar en ML".\n\n` +
        `ID de la publicación: ${row.channelProductId}`,
    );
    if (!confirmed) return;

    setCloseBusy((prev) => ({ ...prev, [row.channelProductId]: true }));
    setCloseResults((prev) => {
      const next = { ...prev };
      delete next[row.channelProductId];
      return next;
    });
    try {
      const result = await window.blacksand.meliListing.close(row.channelProductId);
      setCloseResults((prev) => ({
        ...prev,
        [row.channelProductId]: result.ok ? "✅ Publicación cerrada." : `❌ ${result.reason}`,
      }));
      load();
    } catch (err) {
      setCloseResults((prev) => ({ ...prev, [row.channelProductId]: `❌ ${String(err)}` }));
    } finally {
      setCloseBusy((prev) => ({ ...prev, [row.channelProductId]: false }));
    }
  }

  async function previewDuplicates() {
    setDupPreviewBusy(true);
    setDupError(null);
    setDupResults({});
    try {
      const groups = await window.blacksand.meliDuplicateFix.preview();
      setDupGroups(groups);
      // Precarga la recomendación (la más antigua) cuando hay una confiable
      // — el usuario puede cambiarla a mano antes de cerrar nada.
      const initialChoices: Record<string, string> = {};
      for (const g of groups) {
        if (g.recommendedKeep) initialChoices[g.variantId] = g.recommendedKeep;
      }
      setDupKeepChoice(initialChoices);
    } catch (err) {
      setDupError(String(err));
    } finally {
      setDupPreviewBusy(false);
    }
  }

  async function runDuplicateClose() {
    if (!dupGroups) return;
    const toClose: string[] = [];
    const skippedGroups: string[] = [];
    for (const g of dupGroups) {
      const keep = dupKeepChoice[g.variantId];
      if (!keep) {
        skippedGroups.push(g.productName);
        continue;
      }
      for (const item of g.items) {
        if (item.channelProductId !== keep) toClose.push(item.channelProductId);
      }
    }
    if (toClose.length === 0) return;

    const confirmed = window.confirm(
      `¿Cerrar ${toClose.length} publicación(es) duplicada(s) en Mercado Libre?\n\n` +
        `Se conserva la publicación elegida en cada grupo y se CIERRA el resto (mismo efecto que ` +
        `"Finalizar publicación" — no hay borrado permanente vía API).` +
        (skippedGroups.length > 0
          ? `\n\n${skippedGroups.length} grupo(s) sin elegir cuál conservar quedan SIN TOCAR: ${skippedGroups.join(", ")}.`
          : ""),
    );
    if (!confirmed) return;

    setDupRunBusy(true);
    try {
      const outcomes = await window.blacksand.meliDuplicateFix.close(toClose);
      const byId: Record<string, string> = {};
      for (const o of outcomes) byId[o.channelProductId] = o.result.ok ? "✅ Cerrada." : `❌ ${o.result.reason}`;
      setDupResults(byId);
      // Se vuelve a buscar para que la lista refleje lo que sigue vivo.
      await previewDuplicates();
      load();
    } catch (err) {
      setDupError(String(err));
    } finally {
      setDupRunBusy(false);
    }
  }

  async function previewBrandFix() {
    setBrandFixPreviewBusy(true);
    setBrandFixError(null);
    setBrandFixPreview(null);
    setBrandFixResults({});
    try {
      const preview = await window.blacksand.meliBrandFix.preview(brandFixSkuPrefix.trim());
      setBrandFixPreview(preview);
    } catch (err) {
      setBrandFixError(String(err));
    } finally {
      setBrandFixPreviewBusy(false);
    }
  }

  async function runBrandFix() {
    setBrandFixRunBusy(true);
    setBrandFixError(null);
    try {
      const result = await window.blacksand.meliBrandFix.run(
        brandFixSkuPrefix.trim(),
        brandFixNewBrand.trim(),
        brandFixUpdateLocal,
      );
      const byId: Record<string, MeliBrandFixItemResult> = {};
      for (const r of result.results) byId[r.channelProductId] = r;
      setBrandFixResults(byId);
      // Se vuelve a previsualizar para que la tabla muestre la marca real
      // que quedó en Mercado Libre después del cambio, no la de antes.
      await previewBrandFix();
      load();
    } catch (err) {
      setBrandFixError(String(err));
    } finally {
      setBrandFixRunBusy(false);
    }
  }

  function skuFixRowKey(row: { channelProductId: string; channelVariantId: string | null }): string {
    return `${row.channelProductId}:${row.channelVariantId ?? ""}`;
  }

  async function previewSkuFix() {
    setSkuFixPreviewBusy(true);
    setSkuFixError(null);
    setSkuFixPreview(null);
    setSkuFixResults({});
    try {
      const preview = await window.blacksand.meliSkuFix.preview();
      setSkuFixPreview(preview);
    } catch (err) {
      setSkuFixError(String(err));
    } finally {
      setSkuFixPreviewBusy(false);
    }
  }

  async function runSkuFix() {
    if (!skuFixPreview) return;
    const mismatched = skuFixPreview.filter((r) => r.mismatched && !r.readError);
    if (mismatched.length === 0) return;
    setSkuFixRunBusy(true);
    setSkuFixError(null);
    try {
      const result = await window.blacksand.meliSkuFix.run(
        mismatched.map((r) => ({
          channelProductId: r.channelProductId,
          channelVariantId: r.channelVariantId,
          expectedSku: r.expectedSku,
          productName: r.productName,
          hasSellerSkuAttribute: r.hasSellerSkuAttribute,
        })),
      );
      const byKey: Record<string, MeliSkuFixItemResult> = {};
      for (const r of result.results) byKey[skuFixRowKey(r)] = r;
      // Se vuelve a leer el estado real desde Mercado Libre para que la
      // tabla muestre el SKU que quedó después del cambio, no el de antes —
      // sin pasar por `previewSkuFix()` (que limpia `skuFixResults` al
      // iniciar una búsqueda desde cero, y borraría el resultado recién
      // calculado antes de que el usuario llegue a verlo).
      const refreshed = await window.blacksand.meliSkuFix.preview();
      setSkuFixPreview(refreshed);
      setSkuFixResults(byKey);
      load();
    } catch (err) {
      setSkuFixError(String(err));
    } finally {
      setSkuFixRunBusy(false);
    }
  }

  const counts = {
    cerradas: rows?.filter((r) => r.listingStatus === "closed").length ?? 0,
    pausadas: rows?.filter((r) => r.listingStatus === "paused" || r.listingStatus === "under_review").length ?? 0,
    sin_revisar: rows?.filter((r) => r.listingStatus === null).length ?? 0,
    activas: rows?.filter((r) => r.listingStatus === "active").length ?? 0,
  };

  const filtered = rows?.filter((r) => {
    if (filter === "todos") return true;
    if (filter === "cerradas") return r.listingStatus === "closed";
    if (filter === "pausadas") return r.listingStatus === "paused" || r.listingStatus === "under_review";
    if (filter === "sin_revisar") return r.listingStatus === null;
    if (filter === "activas") return r.listingStatus === "active";
    return true;
  });

  // A pedido del usuario: se pagina de a 10; cambiar el filtro vuelve a la
  // página 1 para no quedar mirando una página vacía.
  const pg = usePagination(filtered?.length ?? 0, filter);
  const pageFiltered = filtered ? paginate(filtered, pg.start, pg.end) : null;
  const brandFixPg = usePagination(brandFixPreview?.length ?? 0);
  const pageBrandFixPreview = brandFixPreview ? paginate(brandFixPreview, brandFixPg.start, brandFixPg.end) : null;
  const skuFixMismatchedCount = skuFixPreview?.filter((r) => r.mismatched && !r.readError).length ?? 0;
  const skuFixPg = usePagination(skuFixPreview?.length ?? 0);
  const pageSkuFixPreview = skuFixPreview ? paginate(skuFixPreview, skuFixPg.start, skuFixPg.end) : null;

  return (
    <div>
      <h1>Estado en Mercado Libre</h1>
      <p className="page-subtitle">
        Qué está activo, pausado o cerrado en Mercado Libre — a diferencia de "Publicar en ML"
        (que es sobre productos que TODAVÍA no tienen ninguna publicación), esta pantalla es sobre
        publicaciones que YA existieron y pueden haber cambiado de estado por su cuenta. Las
        publicaciones <strong>cerradas</strong> por Mercado Libre ya vuelven a aparecer solas como
        candidatas en "Publicar en ML" (Mercado Libre no garantiza poder reactivar un cierre, así
        que la app ofrece crear una publicación nueva en su lugar). Las <strong>pausadas</strong>{" "}
        sí se pueden intentar reactivar directo desde acá.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>Actualizar estado desde Mercado Libre</strong>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Vuelve a revisar TODAS las publicaciones (activas, pausadas y cerradas) — puede
              tardar si hay muchas. El estado que se ve abajo es el de la última vez que se corrió
              esto.
            </div>
          </div>
          <button disabled={refreshBusy} onClick={refreshFromMeli}>
            {refreshBusy ? "Actualizando…" : "Actualizar estado"}
          </button>
        </div>
        {refreshMessage && <p style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>{refreshMessage}</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Cerrar publicaciones duplicadas</strong>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6 }}>
          Caso real encontrado: ~20 productos quedaron publicados DOS VECES en Mercado Libre — un
          doble clic en "Publicar lote"/"Publicar todo automáticamente" alcanzó a disparar dos
          publicaciones casi simultáneas para el mismo producto antes de que la primera terminara de
          guardarse (ya corregido, no debería volver a pasar). Esto busca esos casos y deja elegir
          cuál publicación conservar de cada grupo antes de cerrar el resto.
        </p>

        <button disabled={dupPreviewBusy} onClick={previewDuplicates}>
          {dupPreviewBusy ? "Buscando…" : "Buscar publicaciones duplicadas"}
        </button>

        {dupError && <div className="error-banner" style={{ marginTop: 10 }}>{dupError}</div>}

        {dupGroups && (
          <div style={{ marginTop: 12 }}>
            {dupGroups.length === 0 ? (
              <div className="empty-state">
                No se encontró ninguna variante con más de una publicación activa en Mercado Libre. 🎉
              </div>
            ) : (
              <>
                {dupGroups.map((g) => (
                  <div
                    key={g.variantId}
                    style={{ marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--border, #333)" }}
                  >
                    <div style={{ marginBottom: 6 }}>
                      <strong>{g.productName}</strong>{" "}
                      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>(SKU {g.sku})</span>
                      {!g.recommendedKeep && (
                        <span className="badge badge-pendiente" style={{ marginLeft: 8 }}>
                          Sin recomendación automática — revisa a mano cuál conservar
                        </span>
                      )}
                    </div>
                    {g.items.map((item) => (
                      <label
                        key={item.channelProductId}
                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 4 }}
                      >
                        <input
                          type="radio"
                          name={`dup-${g.variantId}`}
                          checked={dupKeepChoice[g.variantId] === item.channelProductId}
                          onChange={() =>
                            setDupKeepChoice((prev) => ({ ...prev, [g.variantId]: item.channelProductId }))
                          }
                        />
                        Conservar <span style={{ fontFamily: "monospace" }}>{item.channelProductId}</span> —{" "}
                        {statusLabel(item.listingStatus)}
                        {g.recommendedKeep === item.channelProductId && (
                          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>(recomendada — la más antigua)</span>
                        )}
                        {dupResults[item.channelProductId] && (
                          <span style={{ fontSize: 11 }}>{dupResults[item.channelProductId]}</span>
                        )}
                      </label>
                    ))}
                  </div>
                ))}
                <button disabled={dupRunBusy} onClick={runDuplicateClose}>
                  {dupRunBusy ? "Cerrando…" : "Cerrar las duplicadas seleccionadas"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Corregir marca por prefijo de SKU</strong>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6 }}>
          Para publicaciones que YA están en Mercado Libre. Caso real que motivó esto: los
          productos con SKU que empieza con "EM" (EmersonGear) se publicaron con la marca "BLACK
          SAND SECURITY" (la marca por defecto de Configuración) en vez de su marca real, porque
          no tenían "Proveedor" cargado en Shopify al momento de publicar. Primero "Buscar
          publicaciones" para revisar qué se va a cambiar — todavía no toca nada en Mercado Libre.
        </p>
        <div className="form-row">
          <label>Prefijo de SKU</label>
          <input
            type="text"
            value={brandFixSkuPrefix}
            onChange={(e) => setBrandFixSkuPrefix(e.target.value)}
            placeholder="EM"
          />
        </div>
        <div className="form-row">
          <label>Marca correcta</label>
          <input
            type="text"
            value={brandFixNewBrand}
            onChange={(e) => setBrandFixNewBrand(e.target.value)}
            placeholder="EmersonGear"
          />
        </div>
        <div className="form-row">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={brandFixUpdateLocal}
              onChange={(e) => setBrandFixUpdateLocal(e.target.checked)}
            />
            También actualizar la marca en la base local (para que, si alguna de estas
            publicaciones se cierra más adelante y se vuelve a publicar, ya salga con la marca
            correcta sin depender de la "Marca por defecto")
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button disabled={brandFixPreviewBusy || !brandFixSkuPrefix.trim()} onClick={previewBrandFix}>
            {brandFixPreviewBusy ? "Buscando…" : "Buscar publicaciones"}
          </button>
          {brandFixPreview && brandFixPreview.length > 0 && (
            <button
              disabled={brandFixRunBusy || !brandFixNewBrand.trim()}
              onClick={runBrandFix}
              title='Recomendado: revisar 1-2 resultados en el panel de Mercado Libre antes de correr esto con toda la lista.'
            >
              {brandFixRunBusy ? "Corrigiendo…" : `Corregir marca en Mercado Libre (${brandFixPreview.length})`}
            </button>
          )}
        </div>

        {brandFixError && <div className="error-banner" style={{ marginTop: 10 }}>{brandFixError}</div>}

        {brandFixPreview && (
          <div style={{ marginTop: 12 }}>
            {brandFixPreview.length === 0 ? (
              <div className="empty-state">
                Ninguna publicación de Mercado Libre tiene un SKU que empiece con "
                {brandFixSkuPrefix.trim()}".
              </div>
            ) : (
              <>
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>SKU</th>
                    <th>Estado</th>
                    <th>Marca actual en ML</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {pageBrandFixPreview!.map((row) => {
                    const result = brandFixResults[row.channelProductId];
                    return (
                      <tr key={row.channelProductId}>
                        <td>{row.productName}</td>
                        <td>{row.sku}</td>
                        <td>{statusLabel(row.listingStatus)}</td>
                        <td>
                          {row.readError ? (
                            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                              No se pudo leer: {row.readError}
                            </span>
                          ) : (
                            row.currentMeliBrand ?? "(sin marca)"
                          )}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {result ? (result.ok ? `✅ Corregida a "${brandFixNewBrand.trim()}"` : `❌ ${result.reason}`) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination page={brandFixPg.page} totalPages={brandFixPg.totalPages} totalItems={brandFixPreview.length} pageSize={brandFixPg.pageSize} onChange={brandFixPg.setPage} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Corregir SKU incorrecto</strong>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6 }}>
          Revisa TODAS las publicaciones de Mercado Libre ya emparejadas a un producto de Shopify y
          compara, en vivo, el SKU real que tienen hoy en Mercado Libre contra el SKU correcto (el
          de Shopify) — a diferencia de "Corregir marca", acá no hace falta escribir ningún dato: el
          valor correcto ya está en la base local. Solo se ofrece corregir las publicaciones que de
          verdad no coinciden.
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button disabled={skuFixPreviewBusy} onClick={previewSkuFix}>
            {skuFixPreviewBusy ? "Revisando…" : "Revisar SKU en Mercado Libre"}
          </button>
          {skuFixMismatchedCount > 0 && (
            <button
              disabled={skuFixRunBusy}
              onClick={runSkuFix}
              title='Recomendado: revisar 1-2 resultados en el panel de Mercado Libre antes de correr esto con toda la lista.'
            >
              {skuFixRunBusy ? "Corrigiendo…" : `Corregir SKU en Mercado Libre (${skuFixMismatchedCount})`}
            </button>
          )}
        </div>

        {skuFixError && <div className="error-banner" style={{ marginTop: 10 }}>{skuFixError}</div>}

        {skuFixPreview && (
          <div style={{ marginTop: 12 }}>
            {skuFixPreview.length === 0 ? (
              <div className="empty-state">
                No hay ninguna publicación de Mercado Libre emparejada todavía a un producto de
                Shopify — corré "Importar de Mercado Libre" primero.
              </div>
            ) : (
              <>
              <p style={{ fontSize: 13, marginBottom: 8 }}>
                {skuFixMismatchedCount > 0
                  ? `${skuFixMismatchedCount} de ${skuFixPreview.length} publicación(es) tienen un SKU distinto al de Shopify.`
                  : `Revisadas ${skuFixPreview.length} publicación(es) — todas tienen el SKU correcto en Mercado Libre.`}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>SKU en Shopify (correcto)</th>
                    <th>SKU actual en ML</th>
                    <th>Estado</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {pageSkuFixPreview!.map((row) => {
                    const key = skuFixRowKey(row);
                    const result = skuFixResults[key];
                    return (
                      <tr key={key}>
                        <td>{row.productName}</td>
                        <td style={{ fontFamily: "monospace" }}>{row.expectedSku}</td>
                        <td style={{ fontFamily: "monospace" }}>
                          {row.readError ? (
                            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                              No se pudo leer: {row.readError}
                            </span>
                          ) : (
                            row.currentMeliSku ?? "(vacío)"
                          )}
                        </td>
                        <td>
                          {row.readError ? (
                            "—"
                          ) : row.mismatched ? (
                            <span className="badge badge-error">No coincide</span>
                          ) : (
                            <span className="badge badge-sincronizado">Coincide</span>
                          )}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {result ? (result.ok ? `✅ Corregido a "${row.expectedSku}"` : `❌ ${result.reason}`) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination page={skuFixPg.page} totalPages={skuFixPg.totalPages} totalItems={skuFixPreview.length} pageSize={skuFixPg.pageSize} onChange={skuFixPg.setPage} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Marca automática por prefijo de SKU (para publicaciones nuevas)</strong>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6 }}>
          Esto es distinto de la tarjeta de arriba: esa corrige publicaciones que YA EXISTEN, esta
          es la regla permanente para que TODA publicación nueva con ese prefijo de SKU salga con
          la marca correcta desde el principio, tenga o no "Proveedor" cargado en Shopify. Por
          ejemplo, "EM" → "EmersonGear" hace que cualquier producto con SKU que empiece con "EM"
          se publique siempre con esa marca, pisando incluso el vendor de Shopify si tuviera otro
          valor cargado.
        </p>

        {ruleError && <div className="error-banner">{ruleError}</div>}

        {skuPrefixRules === null ? (
          <div className="empty-state">Cargando…</div>
        ) : skuPrefixRules.length > 0 ? (
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Prefijo de SKU</th>
                <th>Marca</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {skuPrefixRules.map((rule) => (
                <tr key={rule.id}>
                  <td style={{ fontFamily: "monospace" }}>{rule.skuPrefix}</td>
                  <td>{rule.brand}</td>
                  <td>
                    <button
                      className="small"
                      disabled={ruleDeleteBusy[rule.id]}
                      onClick={() => deleteSkuPrefixRule(rule)}
                    >
                      {ruleDeleteBusy[rule.id] ? "Borrando…" : "Borrar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state" style={{ marginBottom: 12 }}>
            Todavía no hay reglas guardadas.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="form-row" style={{ margin: 0 }}>
            <label>Prefijo de SKU</label>
            <input
              type="text"
              value={newRulePrefix}
              onChange={(e) => setNewRulePrefix(e.target.value)}
              placeholder="EM"
            />
          </div>
          <div className="form-row" style={{ margin: 0 }}>
            <label>Marca</label>
            <input
              type="text"
              value={newRuleBrand}
              onChange={(e) => setNewRuleBrand(e.target.value)}
              placeholder="EmersonGear"
            />
          </div>
          <button
            disabled={ruleSaveBusy || !newRulePrefix.trim() || !newRuleBrand.trim()}
            onClick={saveSkuPrefixRule}
          >
            {ruleSaveBusy ? "Guardando…" : "Guardar regla"}
          </button>
        </div>
      </div>

      <div className="form-row">
        <label>Filtrar</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
          <option value="cerradas">Cerradas ({counts.cerradas})</option>
          <option value="pausadas">Pausadas / en revisión ({counts.pausadas})</option>
          <option value="sin_revisar">Sin revisar todavía ({counts.sin_revisar})</option>
          <option value="activas">Activas ({counts.activas})</option>
          <option value="todos">Todas ({rows?.length ?? 0})</option>
        </select>
      </div>

      <div className="card">
        {rows === null ? (
          <div className="empty-state">Cargando…</div>
        ) : filtered && filtered.length > 0 ? (
          <>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>SKU</th>
                <th>Estado</th>
                <th>Motivo</th>
                <th>Última revisión</th>
                <th>ID publicación</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageFiltered!.map((row) => (
                <tr key={row.channelProductId}>
                  <td>{row.productName}</td>
                  <td>{row.sku}</td>
                  <td>
                    <span className={`badge badge-${row.listingStatus === "active" ? "sincronizado" : row.listingStatus === "closed" ? "error" : "pendiente"}`}>
                      {statusLabel(row.listingStatus)}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {row.listingSubStatus.length > 0 ? (
                      row.listingSubStatus.map(subStatusLabel).join(", ")
                    ) : row.listingStatus === "closed" || row.listingStatus === "paused" ? (
                      <span style={{ color: "var(--text-dim)" }}>
                        Mercado Libre no dio más detalle por API — revisa el ID de la publicación
                        directo en tu panel de Mercado Libre.
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {row.listingStatusCheckedAt
                      ? new Date(row.listingStatusCheckedAt).toLocaleString("es-CL")
                      : "Nunca"}
                  </td>
                  <td style={{ fontSize: 12, fontFamily: "monospace" }}>{row.channelProductId}</td>
                  <td>
                    {row.listingStatus !== "closed" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                        {row.listingStatus === "paused" && (
                          <button
                            className="small"
                            disabled={reactivateBusy[row.channelProductId]}
                            onClick={() => reactivate(row)}
                          >
                            {reactivateBusy[row.channelProductId] ? "Reactivando…" : "Reactivar"}
                          </button>
                        )}
                        {reactivateResults[row.channelProductId] && (
                          <div style={{ fontSize: 11 }}>{reactivateResults[row.channelProductId]}</div>
                        )}
                        <button
                          className="small"
                          disabled={closeBusy[row.channelProductId]}
                          onClick={() => closeListing(row)}
                          title={`Cierra la publicación en Mercado Libre (no hay borrado permanente vía API) — deja de estar visible/comprable. Se puede volver a publicar después desde "Publicar en ML".`}
                        >
                          {closeBusy[row.channelProductId] ? "Eliminando…" : "Eliminar publicación"}
                        </button>
                        {closeResults[row.channelProductId] && (
                          <div style={{ fontSize: 11 }}>{closeResults[row.channelProductId]}</div>
                        )}
                      </div>
                    )}
                    {row.listingStatus === "closed" && (
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        Ya disponible en "Publicar en ML"
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={pg.page} totalPages={pg.totalPages} totalItems={filtered.length} pageSize={pg.pageSize} onChange={pg.setPage} />
          </>
        ) : (
          <div className="empty-state">
            {rows.length === 0
              ? 'Sin publicaciones de Mercado Libre conocidas todavía — corré "Actualizar estado" arriba.'
              : "Nada en este filtro."}
          </div>
        )}
      </div>
    </div>
  );
}
