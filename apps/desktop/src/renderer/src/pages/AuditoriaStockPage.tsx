import { useEffect, useState } from "react";
import type { StockAuditRow } from "../../../shared-ipc-types";
import { usePagination, paginate, Pagination } from "../lib/pagination";

/**
 * "Auditoría de Stock" — nació de un caso real reportado por el usuario:
 * "el inventario de casco wendy en shopify es 9 y en ML es 10, algo pasó,
 * revisalo y corrige". La app ya empuja cada edición manual a ambos
 * canales y ya reintenta el stock que cambia por una venta — pero eso no
 * cubre un ajuste hecho DIRECTO en Shopify o en Mercado Libre, por fuera de
 * la app (venta de mostrador anotada mal, conteo físico corregido a mano en
 * el panel de una sola plataforma, etc.).
 *
 * Principio permanente confirmado por el usuario: "el inventario matriz es
 * siempre shopify, ML debe estar alineado a este" — a diferencia de la
 * primera versión de esta pantalla (que dejaba elegir entre el valor de
 * Shopify o el de Mercado Libre), ahora la dirección de la corrección NO se
 * pregunta: siempre es Shopify → Mercado Libre. Se siguen mostrando los
 * tres valores (local/Shopify/Mercado Libre en vivo) para que el usuario
 * vea qué está pasando, pero la única corrección "de un clic" es alinear
 * Mercado Libre al valor de Shopify. El campo manual que queda es solo para
 * el caso borde de que ni Shopify esté bien (un conteo físico real
 * distinto a los dos) — ese valor se guarda como correcto y se empuja igual
 * a AMBOS canales, Shopify incluido.
 */

type StateFilter = "solo_diferencias" | "todos";

export default function AuditoriaStockPage() {
  const [rows, setRows] = useState<StockAuditRow[] | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StateFilter>("solo_diferencias");
  const [applyBusy, setApplyBusy] = useState<Record<string, boolean>>({});
  const [applyResults, setApplyResults] = useState<Record<string, string>>({});
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [alignAllBusy, setAlignAllBusy] = useState(false);

  /**
   * A propósito, esto NO toca `applyResults` — solo recarga la tabla. Si lo
   * hiciera (como una primera versión de esta pantalla), cada vez que este
   * reload terminara después de aplicar una corrección borraría el mensaje
   * ✅/❌ recién puesto antes de que el usuario llegara a leerlo — mismo bug
   * ya visto una vez en "Corregir marca por prefijo de SKU"
   * (`runBrandFix`/`previewBrandFix`, EstadoMeliPage) y evitado a propósito
   * en "Corregir SKU incorrecto". Solo `refreshFresh` (el botón "Revisar
   * stock") limpia los resultados — tiene sentido ahí porque es un barrido
   * nuevo desde cero.
   */
  function load(): Promise<void> {
    setLoadBusy(true);
    setError(null);
    return window.blacksand.stockAudit
      .preview()
      .then((result) => setRows(result))
      .catch((err) => setError(String(err)))
      .finally(() => setLoadBusy(false));
  }

  function refreshFresh() {
    setApplyResults({});
    load();
  }

  useEffect(() => {
    refreshFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Aplica `quantity` para UNA fila, sin diálogo de confirmación propio (lo pide el llamador) ni recarga la tabla (el llamador decide cuándo). Devuelve `true` si quedó bien en los dos canales. */
  async function applyQuiet(row: StockAuditRow, quantity: number): Promise<boolean> {
    setApplyBusy((prev) => ({ ...prev, [row.variantId]: true }));
    setApplyResults((prev) => {
      const next = { ...prev };
      delete next[row.variantId];
      return next;
    });
    try {
      const result = await window.blacksand.stockAudit.apply(row.variantId, quantity);
      if (!result.ok) {
        setApplyResults((prev) => ({ ...prev, [row.variantId]: `❌ ${result.reason ?? "Error desconocido."}` }));
        return false;
      }
      const failed = (result.results ?? []).filter((r) => !r.ok);
      setApplyResults((prev) => ({
        ...prev,
        [row.variantId]:
          failed.length === 0
            ? "✅ Alineado en Shopify y Mercado Libre."
            : `⚠️ Guardado en local, pero falló en: ${failed.map((f) => `${f.channelCode} (${f.error ?? f.errorCode})`).join(", ")}`,
      }));
      return failed.length === 0;
    } catch (err) {
      setApplyResults((prev) => ({ ...prev, [row.variantId]: `❌ ${String(err)}` }));
      return false;
    } finally {
      setApplyBusy((prev) => ({ ...prev, [row.variantId]: false }));
    }
  }

  /** Botón de UNA fila (alinear a Shopify, o corrección manual) — pide confirmación y recarga al final. */
  async function apply(row: StockAuditRow, quantity: number, label: string) {
    if (!Number.isInteger(quantity) || quantity < 0) {
      setApplyResults((prev) => ({ ...prev, [row.variantId]: "❌ El valor tiene que ser un número entero, 0 o mayor." }));
      return;
    }
    const confirmed = window.confirm(
      `¿Corregir el stock de "${row.productName}" (SKU ${row.sku}) a ${quantity} (${label})?\n\n` +
        `Esto va a guardar ${quantity} como el stock correcto en la app y va a empujarlo de inmediato a Shopify y a Mercado Libre.`,
    );
    if (!confirmed) return;

    await applyQuiet(row, quantity);
    load();
  }

  /**
   * Principio permanente confirmado por el usuario ("el inventario matriz
   * es siempre shopify, ML debe estar alineado a este"): corrige TODAS las
   * filas con diferencia (del filtro actual) al valor de Shopify de una
   * sola vez, una sola confirmación — no hace falta ir fila por fila.
   */
  async function alignAllToShopify() {
    const targets = (filtered ?? []).filter((r) => r.mismatched && r.shopifyQuantity !== null);
    if (targets.length === 0) return;
    const confirmed = window.confirm(
      `¿Alinear ${targets.length} producto(s) en Mercado Libre al valor de Shopify?\n\n` +
        `Cada uno va a quedar con el stock que Shopify tiene hoy en vivo.`,
    );
    if (!confirmed) return;

    setAlignAllBusy(true);
    for (const row of targets) {
      await applyQuiet(row, row.shopifyQuantity!);
    }
    setAlignAllBusy(false);
    load();
  }

  const filtered = rows === null ? null : filter === "todos" ? rows : rows.filter((r) => r.mismatched || r.readError);
  const pg = usePagination(filtered?.length ?? 0, filter);
  const pageRows = filtered ? paginate(filtered, pg.start, pg.end) : null;
  const mismatchCount = rows?.filter((r) => r.mismatched).length ?? 0;

  return (
    <div>
      <h1>Auditoría de Stock</h1>
      <p className="page-subtitle">
        Shopify es la plataforma matriz: el inventario de Mercado Libre siempre se alinea al de
        Shopify, nunca al revés. Esta pantalla compara, EN VIVO, el stock real de los dos canales
        para cada producto publicado en ambos — para encontrar casos como "en Shopify hay 9 y en
        Mercado Libre hay 10" — y deja alinear Mercado Libre al valor de Shopify con un clic, una
        fila a la vez o todas juntas. El campo manual queda como excepción, para cuando ni el
        valor de Shopify coincide con un conteo físico real: ese valor se guarda como correcto y
        se empuja a los dos canales, Shopify incluido.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="form-row">
        <button disabled={loadBusy} onClick={refreshFresh}>
          {loadBusy ? "Revisando…" : "Revisar stock (Shopify vs Mercado Libre)"}
        </button>
        <label style={{ marginLeft: 16 }}>Filtrar</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as StateFilter)}>
          <option value="solo_diferencias">Solo con diferencias ({mismatchCount})</option>
          <option value="todos">Todos ({rows?.length ?? 0})</option>
        </select>
        {mismatchCount > 0 && (
          <button disabled={alignAllBusy || loadBusy} onClick={alignAllToShopify} style={{ marginLeft: 16 }}>
            {alignAllBusy ? "Alineando…" : `Alinear todo a Shopify (${mismatchCount})`}
          </button>
        )}
      </div>

      <div className="card">
        {rows === null ? (
          <div className="empty-state">{loadBusy ? "Cargando…" : "Sin datos todavía."}</div>
        ) : filtered && filtered.length > 0 ? (
          <>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>SKU</th>
                <th>Local (app)</th>
                <th>Shopify (en vivo)</th>
                <th>Mercado Libre (en vivo)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows!.map((row) => (
                <tr key={row.variantId}>
                  <td>{row.productName}</td>
                  <td>{row.sku}</td>
                  <td>{row.localQuantity}</td>
                  <td>
                    {row.shopifyQuantity === null ? (
                      <span style={{ color: "var(--text-dim)" }}>Sin leer</span>
                    ) : (
                      row.shopifyQuantity
                    )}
                  </td>
                  <td>
                    <span className={row.mismatched ? "badge badge-error" : undefined}>
                      {row.meliQuantity === null ? (
                        <span style={{ color: "var(--text-dim)" }}>Sin leer</span>
                      ) : (
                        row.meliQuantity
                      )}
                    </span>
                  </td>
                  <td>
                    {row.readError && (
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{row.readError}</div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      {row.shopifyQuantity !== null && (
                        <button
                          className="small"
                          disabled={applyBusy[row.variantId]}
                          onClick={() => apply(row, row.shopifyQuantity!, "valor de Shopify")}
                        >
                          Alinear a Shopify ({row.shopifyQuantity})
                        </button>
                      )}
                      <div style={{ display: "flex", gap: 4 }}>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          style={{ width: 70 }}
                          placeholder="Conteo físico"
                          value={manualValues[row.variantId] ?? ""}
                          onChange={(e) => setManualValues((prev) => ({ ...prev, [row.variantId]: e.target.value }))}
                        />
                        <button
                          className="small"
                          disabled={applyBusy[row.variantId] || manualValues[row.variantId]?.trim() === ""}
                          onClick={() => apply(row, Number(manualValues[row.variantId]), "conteo manual")}
                        >
                          {applyBusy[row.variantId] ? "Aplicando…" : "Aplicar"}
                        </button>
                      </div>
                      {applyResults[row.variantId] && (
                        <div style={{ fontSize: 11 }}>{applyResults[row.variantId]}</div>
                      )}
                    </div>
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
              ? 'Ningún producto está publicado en Shopify Y Mercado Libre a la vez todavía — no hay nada que comparar (ver "Publicar en ML").'
              : "Sin diferencias — todo coincide entre Shopify y Mercado Libre."}
          </div>
        )}
      </div>
    </div>
  );
}
