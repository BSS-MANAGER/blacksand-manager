import { useEffect, useMemo, useRef, useState } from "react";
import { planVariantChange, validatePriceChange } from "@blacksand/shared";
import type {
  DiscountApplyInput,
  DiscountApplyResult,
  DiscountBatchRow,
  DiscountOnSaleMode,
  DiscountPreviewProduct,
  DiscountRevertResult,
  DiscountRoundingMode,
  PriceChangeModeIpc,
} from "../../../shared-ipc-types";
import { usePagination, paginate, Pagination } from "../lib/pagination";

/**
 * "Descuentos" — cambios de precio masivos en Shopify. Tres acciones:
 * - Descontar: el precio actual pasa a "precio de comparación" (tachado en la
 *   tienda) y el "precio" baja el porcentaje elegido.
 * - Aumentar: sube el precio, calculado sobre el PRECIO NORMAL guardado (así
 *   aplicarlo dos veces no lo sube dos veces). Ej.: normal 100, +10% → 110;
 *   después un descuento del 10% sobre ese 110 deja precio 99 con 110
 *   tachado.
 * - Restaurar: vuelve al precio normal guardado (100) y quita el tachado.
 *   También sirve para "devolver a su precio original" a los productos que ya
 *   estaban en oferta: su precio normal es su precio de comparación.
 *
 * El "precio normal" de cada variante se guarda solo en la base de datos al
 * abrir esta pantalla y antes de cada cambio (ver `bulk-discount.ts`,
 * @blacksand/sync-engine), y se puede descargar como respaldo en un archivo.
 *
 * La vista previa se calcula acá con la MISMA función (`planVariantChange`,
 * `@blacksand/shared`) que usa el motor al aplicar, y al aplicar el motor
 * vuelve a leer Shopify y recalcula todo: los números de acá son
 * informativos, nunca son los que se escriben.
 */

const MODE_LABELS: Record<PriceChangeModeIpc, string> = {
  discount: "Descontar (el precio baja; el precio actual pasa a ser el tachado)",
  increase: "Aumentar precio (sube sobre el precio normal guardado)",
  restore: "Restaurar precio normal (vuelve al precio normal y quita el tachado)",
};

const ROUNDING_LABELS_DISCOUNT: Record<DiscountRoundingMode, string> = {
  none: "Sin redondeo (peso entero)",
  tens: "Bajar al múltiplo de $10 (ej. 15.992 → 15.990)",
  ending90: "Bajar a un precio que termine en 90 (ej. 15.992 → 15.990, 17.431 → 17.390)",
};

const ROUNDING_LABELS_INCREASE: Record<DiscountRoundingMode, string> = {
  none: "Sin redondeo (peso entero)",
  tens: "Subir al múltiplo de $10 (ej. 21.989 → 21.990)",
  ending90: "Subir a un precio que termine en 90 (ej. 21.989 → 21.990, 17.431 → 17.490)",
};

const ON_SALE_LABELS: Record<DiscountOnSaleMode, string> = {
  skip: "No tocarlos (recomendado)",
  from_price: "Descontar sobre su precio actual (el precio actual pasa a ser el tachado)",
  from_compare: "Descontar sobre su precio de comparación original (mantiene el tachado)",
};

const ROUNDING_SHORT: Record<DiscountRoundingMode, string> = { none: "sin redondeo", tens: "múltiplo de $10", ending90: "termina en 90" };

const money = (n: number | null): string => (n === null ? "—" : `$${Math.round(n).toLocaleString("es-CL")}`);

function range(values: number[]): string {
  if (values.length === 0) return "—";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

function batchLabel(b: DiscountBatchRow): string {
  if (b.kind === "restore") return "Restaurar precio normal";
  if (b.kind === "increase") return `Aumento de ${b.percent}%`;
  return `Descuento de ${b.percent}%`;
}

type StatusFilter = "todos" | "ACTIVE" | "inactivos";

const isActive = (status: string) => status === "ACTIVE";

export default function DescuentosPage() {
  const [products, setProducts] = useState<DiscountPreviewProduct[] | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<PriceChangeModeIpc>("discount");
  const [percentText, setPercentText] = useState("20");
  const [rounding, setRounding] = useState<DiscountRoundingMode>("ending90");
  const [onSaleMode, setOnSaleMode] = useState<DiscountOnSaleMode>("skip");

  const [search, setSearch] = useState("");
  /**
   * Por defecto se muestran TODOS los productos, incluso borrador/archivados:
   * antes el filtro arrancaba en "Solo activos" y ESCONDÍA en silencio los
   * productos que no están activos en Shopify — pero "Devolver ofertas a su
   * precio original" (y "Aplicar") sí los incluían, así que el usuario
   * restauraba productos que después no aparecían en la tabla. Ahora nada se
   * oculta sin avisar (ver el aviso de "ocultos por el filtro" más abajo).
   */
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [runBusy, setRunBusy] = useState(false);
  /**
   * Mismo problema que ya causó ~20 publicaciones duplicadas en Mercado Libre
   * (ver `publishGuardRef`, PublicarMeliPage): `runBusy` es estado de React y
   * recién deshabilita el botón en el PRÓXIMO render — un doble clic rápido
   * alcanza a disparar dos veces el handler antes de eso. Un `useRef` se
   * lee y se escribe de forma síncrona, así que el segundo clic ve el
   * bloqueo de inmediato. (Además, el motor rechaza una segunda operación si
   * ya hay una en curso — esto es la primera barrera, esa es la segunda.)
   */
  const runGuardRef = useRef(false);
  const [applyResult, setApplyResult] = useState<DiscountApplyResult | null>(null);
  const [applyTitle, setApplyTitle] = useState("");
  const [revertResult, setRevertResult] = useState<DiscountRevertResult | null>(null);
  const [batches, setBatches] = useState<DiscountBatchRow[]>([]);

  function loadProducts(): Promise<void> {
    setLoadBusy(true);
    setError(null);
    return window.blacksand.discount
      .preview()
      .then((result) => setProducts(result))
      .catch((err) => setError(String(err)))
      .finally(() => setLoadBusy(false));
  }

  function loadBatches(): Promise<void> {
    return window.blacksand.discount
      .listBatches()
      .then((rows) => setBatches(rows))
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    void loadProducts();
    void loadBatches();
  }, []);

  const percent = Number(percentText.replace(",", "."));
  const percentError = validatePriceChange(mode, percent);

  const filtered = useMemo(() => {
    if (!products) return null;
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (statusFilter === "ACTIVE" && !isActive(p.status)) return false;
      if (statusFilter === "inactivos" && isActive(p.status)) return false;
      if (!q) return true;
      return p.title.toLowerCase().includes(q) || p.variants.some((v) => (v.sku ?? "").toLowerCase().includes(q));
    });
  }, [products, search, statusFilter]);

  /** Vista previa por producto — se recalcula al cambiar acción/porcentaje/redondeo/regla. */
  const rowInfo = useMemo(() => {
    const map = new Map<
      string,
      {
        applies: number;
        onSale: boolean;
        newPrices: number[];
        newCompares: number[];
        curPrices: number[];
        curCompares: number[];
        baselines: number[];
        notes: string[];
      }
    >();
    for (const p of products ?? []) {
      const info = {
        applies: 0,
        onSale: false,
        newPrices: [] as number[],
        newCompares: [] as number[],
        curPrices: [] as number[],
        curCompares: [] as number[],
        baselines: [] as number[],
        notes: [] as string[],
      };
      for (const v of p.variants) {
        if (v.price !== null) info.curPrices.push(v.price);
        if (v.compareAtPrice !== null) info.curCompares.push(v.compareAtPrice);
        if (v.baselinePrice !== null) info.baselines.push(v.baselinePrice);
        if (v.compareAtPrice !== null && v.price !== null && v.compareAtPrice > v.price) info.onSale = true;
        if (percentError) continue;
        const plan = planVariantChange(v, { mode, percent, rounding, onSaleMode });
        if (plan.action === "apply") {
          info.applies += 1;
          info.newPrices.push(plan.newPrice);
          if (plan.newCompareAtPrice !== null) info.newCompares.push(plan.newCompareAtPrice);
        } else {
          info.notes.push(plan.reason);
        }
      }
      map.set(p.productGid, info);
    }
    return map;
  }, [products, mode, percent, percentError, rounding, onSaleMode]);

  const pg = usePagination(filtered?.length ?? 0, `${search}|${statusFilter}`);
  const pageRows = filtered ? paginate(filtered, pg.start, pg.end) : null;

  const allFilteredSelected = !!filtered && filtered.length > 0 && filtered.every((p) => selected.has(p.productGid));
  const selectedProducts = (products ?? []).filter((p) => selected.has(p.productGid));
  const effectiveSelected = selectedProducts.filter((p) => (rowInfo.get(p.productGid)?.applies ?? 0) > 0);
  const effectiveVariants = effectiveSelected.reduce((n, p) => n + (rowInfo.get(p.productGid)?.applies ?? 0), 0);
  const omittedSelected = selectedProducts.length - effectiveSelected.length;

  const hiddenByStatus = (products ?? []).filter((p) => {
    if (statusFilter === "ACTIVE") return !isActive(p.status);
    if (statusFilter === "inactivos") return isActive(p.status);
    return false;
  }).length;
  const inactiveCount = (products ?? []).filter((p) => !isActive(p.status)).length;
  const selectedInactive = selectedProducts.filter((p) => !isActive(p.status)).length;

  const baselineCount = (products ?? []).reduce((n, p) => n + p.variants.filter((v) => v.baselinePrice !== null).length, 0);
  const onSaleProducts = (products ?? []).filter((p) => rowInfo.get(p.productGid)?.onSale);
  const onSaleInactive = onSaleProducts.filter((p) => !isActive(p.status)).length;

  function toggleAllFiltered() {
    if (!filtered) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((p) => next.delete(p.productGid));
      else filtered.forEach((p) => next.add(p.productGid));
      return next;
    });
  }

  function toggleOne(gid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  /** Corre una operación de precios (con su propio texto de confirmación) — compartida por "Aplicar" y "Devolver ofertas a su precio original". */
  async function runChange(input: DiscountApplyInput, title: string, confirmText: string) {
    if (runGuardRef.current) return;
    if (!window.confirm(confirmText)) return;

    runGuardRef.current = true;
    setRunBusy(true);
    setError(null);
    setApplyResult(null);
    setRevertResult(null);
    try {
      const result = await window.blacksand.discount.apply(input);
      setApplyTitle(title);
      setApplyResult(result);
      setSelected(new Set());
      await Promise.all([loadProducts(), loadBatches()]);
    } catch (err) {
      setError(String(err));
      // Puede haberse aplicado una parte antes del error — se recarga para mostrar el estado real.
      await Promise.all([loadProducts(), loadBatches()]);
    } finally {
      runGuardRef.current = false;
      setRunBusy(false);
    }
  }

  function applySelected() {
    if (percentError || effectiveSelected.length === 0) return;
    const inactiveNote =
      selectedInactive > 0 ? `, incluye ${selectedInactive} en borrador/archivados` : "";
    const common = `${effectiveSelected.length} producto(s) (${effectiveVariants} variante(s)${inactiveNote})`;
    const tail =
      `\n\nEsto se escribe AHORA en tu tienda real de Shopify. El precio normal de cada variante ya está guardado ` +
      `en la app, y el precio en Mercado Libre NO cambia. Después puedes deshacerlo desde "Historial".`;
    const text =
      mode === "discount"
        ? `¿Aplicar ${percent}% de descuento a ${common}?\n\n• El precio actual pasa a "precio de comparación" (se ve tachado).\n• El "precio" queda con el descuento (${ROUNDING_SHORT[rounding]}).` +
          tail
        : mode === "increase"
          ? `¿Aumentar ${percent}% el precio de ${common}?\n\n• Se calcula sobre el PRECIO NORMAL guardado (${ROUNDING_SHORT[rounding]}).\n• Se quita el precio de comparación (tachado) si lo tenían.` +
            tail
          : `¿Restaurar el precio normal de ${common}?\n\n• El precio vuelve al precio normal guardado.\n• Se quita el precio de comparación (tachado).` +
            tail;
    const title = mode === "discount" ? `Descuento de ${percent}%` : mode === "increase" ? `Aumento de ${percent}%` : "Restaurar precio normal";
    void runChange(
      { productGids: effectiveSelected.map((p) => p.productGid), mode, percent, rounding, onSaleMode },
      title,
      text,
    );
  }

  function restoreExistingSales() {
    if (onSaleProducts.length === 0) return;
    void runChange(
      { productGids: onSaleProducts.map((p) => p.productGid), mode: "restore", percent: 0, rounding: "none", onSaleMode: "skip" },
      "Devolver ofertas existentes a su precio original",
      `¿Devolver a su precio original ${onSaleProducts.length} producto(s) que hoy están en oferta?\n\n` +
        `• Su precio vuelve a ser el "precio de comparación" (el precio de antes de la oferta).\n` +
        `• Se quita el tachado.\n\n` +
        `Esto se escribe AHORA en tu tienda real de Shopify. Después puedes deshacerlo desde "Historial".`,
    );
  }

  async function revertBatch(batch: DiscountBatchRow) {
    if (runGuardRef.current) return;
    const confirmed = window.confirm(
      `¿Deshacer este cambio ("${batchLabel(batch)}", ${new Date(batch.appliedAt).toLocaleString("es-CL")})?\n\n` +
        `Cada variante vuelve a su precio y precio de comparación de justo antes de ese cambio. ` +
        `Las variantes cuyo precio cambió a mano después NO se tocan.\n\n` +
        `(Para volver al precio NORMAL sin importar cuántos cambios hubo, usa la acción "Restaurar precio normal".)`,
    );
    if (!confirmed) return;

    runGuardRef.current = true;
    setRunBusy(true);
    setError(null);
    setApplyResult(null);
    setRevertResult(null);
    try {
      const result = await window.blacksand.discount.revert(batch.batchId);
      setRevertResult(result);
      await Promise.all([loadProducts(), loadBatches()]);
    } catch (err) {
      setError(String(err));
      await Promise.all([loadProducts(), loadBatches()]);
    } finally {
      runGuardRef.current = false;
      setRunBusy(false);
    }
  }

  /** Respaldo en un archivo (CSV) de los precios normales guardados — por si algún día hiciera falta tenerlos fuera de la base de datos. */
  async function downloadBaselinesCsv() {
    try {
      const rows = await window.blacksand.discount.listBaselines();
      const esc = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [
        ["Producto", "SKU", "ID de variante (Shopify)", "Precio normal"].map(esc).join(";"),
        ...rows.map((r) => [r.productTitle, r.sku, r.variantGid, r.baselinePrice].map(esc).join(";")),
      ];
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `precios-normales-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(String(err));
    }
  }

  const problems = applyResult?.outcomes.filter((o) => o.status !== "aplicado") ?? [];
  const revertProblems = revertResult?.outcomes.filter((o) => o.status !== "revertido") ?? [];
  const roundingLabels = mode === "increase" ? ROUNDING_LABELS_INCREASE : ROUNDING_LABELS_DISCOUNT;
  const verb = mode === "discount" ? "Descontar" : mode === "increase" ? "Aumentar" : "Restaurar precio normal de";

  return (
    <div>
      <h1>Descuentos</h1>
      <p className="page-subtitle">
        Cambia los precios de Shopify en lote: descontar (el precio actual pasa a "precio de comparación", que la tienda
        muestra tachado), aumentar el precio, o volver al precio normal. La app guarda siempre el precio normal de cada
        producto, así que se puede volver a él pase lo que pase. Los precios se leen en vivo desde Shopify. No cambia
        los precios de Mercado Libre.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {applyResult && (
        <div className={applyResult.failed > 0 ? "error-banner" : "success-banner"}>
          <strong>
            {applyTitle}: {applyResult.applied} producto(s) cambiado(s)
            {applyResult.skipped > 0 ? ` · ${applyResult.skipped} omitido(s)` : ""}
            {applyResult.failed > 0 ? ` · ${applyResult.failed} con error` : ""}.
          </strong>
          {problems.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {problems.map((o) => (
                <li key={o.productGid}>
                  {o.status === "error" ? "❌" : "↷"} {o.title}: {o.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {revertResult && (
        <div className={revertResult.failed > 0 ? "error-banner" : "success-banner"}>
          <strong>
            Deshacer: {revertResult.reverted} producto(s) restaurado(s)
            {revertResult.skipped > 0 ? ` · ${revertResult.skipped} omitido(s)` : ""}
            {revertResult.failed > 0 ? ` · ${revertResult.failed} con error` : ""}.
          </strong>
          {revertProblems.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {revertProblems.map((o) => (
                <li key={o.productGid}>
                  {o.status === "error" ? "❌" : "↷"} {o.title}: {o.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260, fontSize: 13 }}>
          <strong>Precios normales guardados: {baselineCount} variante(s).</strong>
          <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 4 }}>
            Se guardan solos al abrir esta pantalla y antes de cada cambio. Si un producto ya estaba en oferta, su precio
            normal es su precio de comparación. Si cambias un precio directo en Shopify, el precio normal se actualiza solo.
          </div>
        </div>
        <button className="secondary" onClick={() => void downloadBaselinesCsv()} disabled={loadBusy}>
          Descargar respaldo (CSV)
        </button>
      </div>

      {onSaleProducts.length > 0 && (
        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260, fontSize: 13 }}>
            <strong>{onSaleProducts.length} producto(s) ya están en oferta ahora mismo</strong> (tienen precio de comparación
            mayor que su precio)
            {onSaleInactive > 0 ? `; ${onSaleInactive} de ellos están en borrador/archivados (no visibles en la tienda)` : ""}.
            <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 4 }}>
              Puedes devolverlos a su precio original (el precio de comparación pasa a ser el precio y se quita el tachado).
            </div>
          </div>
          <button disabled={runBusy || loadBusy} onClick={restoreExistingSales}>
            Devolver ofertas a su precio original
          </button>
        </div>
      )}

      <div className="card">
        <h2>1. Elige la acción</h2>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 2, minWidth: 300 }}>
            <label>Acción</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as PriceChangeModeIpc)} disabled={runBusy}>
              {(Object.keys(MODE_LABELS) as PriceChangeModeIpc[]).map((k) => (
                <option key={k} value={k}>
                  {MODE_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {mode !== "restore" && (
            <>
              <div style={{ width: 150 }}>
                <label>{mode === "increase" ? "Aumento (%)" : "Descuento (%)"}</label>
                <input
                  type="number"
                  min={1}
                  max={mode === "increase" ? 200 : 95}
                  step={0.5}
                  value={percentText}
                  onChange={(e) => setPercentText(e.target.value)}
                  disabled={runBusy}
                />
              </div>
              <div style={{ flex: 2, minWidth: 260 }}>
                <label>Redondeo del precio nuevo</label>
                <select value={rounding} onChange={(e) => setRounding(e.target.value as DiscountRoundingMode)} disabled={runBusy}>
                  {(Object.keys(roundingLabels) as DiscountRoundingMode[]).map((k) => (
                    <option key={k} value={k}>
                      {roundingLabels[k]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          {mode === "discount" && (
            <div style={{ flex: 2, minWidth: 260 }}>
              <label>Productos que YA están en oferta (ya tienen precio de comparación)</label>
              <select value={onSaleMode} onChange={(e) => setOnSaleMode(e.target.value as DiscountOnSaleMode)} disabled={runBusy}>
                {(Object.keys(ON_SALE_LABELS) as DiscountOnSaleMode[]).map((k) => (
                  <option key={k} value={k}>
                    {ON_SALE_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {mode === "increase" && (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 10 }}>
            El aumento se calcula sobre el precio normal guardado (no sobre el precio de ahora) y quita el tachado: aplicarlo
            dos veces deja el mismo precio. Ej.: normal $100, +10% → $110. Si después descuentas 10% a ese $110, el $110 queda
            tachado y el precio es $99; "Restaurar" vuelve a $100.
          </div>
        )}
        {percentError && <div style={{ color: "var(--err)", fontSize: 12.5, marginTop: 8 }}>{percentError}</div>}
      </div>

      <div className="card">
        <h2>2. Elige los productos</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Buscar por nombre o SKU</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ej. chaleco, EM7362…" />
          </div>
          <div style={{ width: 220 }}>
            <label>Estado en Shopify</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
              <option value="todos">Todos (activos, borrador y archivados)</option>
              <option value="ACTIVE">Solo activos (visibles en la tienda)</option>
              <option value="inactivos">Solo borrador/archivados</option>
            </select>
          </div>
          <button className="secondary" disabled={loadBusy || runBusy} onClick={() => void loadProducts()}>
            {loadBusy ? "Leyendo Shopify…" : "Releer precios de Shopify"}
          </button>
        </div>

        {hiddenByStatus > 0 && (
          <div style={{ fontSize: 12.5, color: "var(--warn, var(--text-dim))", marginBottom: 10 }}>
            {hiddenByStatus} producto(s) están ocultos por el filtro de estado.{" "}
            <button className="secondary" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setStatusFilter("todos")}>
              Mostrar todos
            </button>
          </div>
        )}

        {products === null ? (
          <div className="empty-state">{loadBusy ? "Leyendo el catálogo de Shopify…" : "Sin datos todavía."}</div>
        ) : filtered && filtered.length > 0 ? (
          <>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      title="Seleccionar/quitar todos los productos del filtro actual (todas las páginas)"
                    />
                  </th>
                  <th>Producto</th>
                  <th>Var.</th>
                  <th>Precio normal</th>
                  <th>Precio actual</th>
                  <th>Comparación actual</th>
                  <th>Precio nuevo</th>
                  <th>Comparación nueva</th>
                </tr>
              </thead>
              <tbody>
                {pageRows!.map((p) => {
                  const info = rowInfo.get(p.productGid)!;
                  const willApply = info.applies > 0;
                  return (
                    <tr key={p.productGid} style={selected.has(p.productGid) && !willApply ? { opacity: 0.6 } : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: "auto" }}
                          checked={selected.has(p.productGid)}
                          onChange={() => toggleOne(p.productGid)}
                        />
                      </td>
                      <td>
                        {p.title}
                        {p.status !== "ACTIVE" && (
                          <span className="badge badge-code-muted" style={{ marginLeft: 6 }}>
                            {p.status === "DRAFT" ? "borrador" : p.status === "ARCHIVED" ? "archivado" : p.status}
                          </span>
                        )}
                        {info.onSale && (
                          <span className="badge badge-pendiente" style={{ marginLeft: 6 }}>
                            en oferta
                          </span>
                        )}
                      </td>
                      <td>{p.variants.length}</td>
                      <td>{range(info.baselines)}</td>
                      <td>{range(info.curPrices)}</td>
                      <td>{range(info.curCompares)}</td>
                      <td>
                        {percentError ? (
                          "—"
                        ) : willApply ? (
                          <strong style={{ color: "var(--ok)" }}>{range(info.newPrices)}</strong>
                        ) : (
                          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                            se omite ({Array.from(new Set(info.notes)).join(", ") || "sin variantes"})
                          </span>
                        )}
                      </td>
                      <td>{willApply ? (info.newCompares.length > 0 ? range(info.newCompares) : "sin tachado") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={pg.page} totalPages={pg.totalPages} totalItems={filtered.length} pageSize={pg.pageSize} onChange={pg.setPage} />
          </>
        ) : (
          <div className="empty-state">Ningún producto coincide con el filtro.</div>
        )}
      </div>

      <div className="card">
        <h2>3. Aplica</h2>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
          {selected.size === 0
            ? "Marca los productos de la tabla (o el casillero del encabezado para elegir todos)."
            : `${selectedProducts.length} producto(s) elegido(s) — el cambio se aplicaría a ${effectiveSelected.length} (${effectiveVariants} variante(s))` +
              (omittedSelected > 0 ? `; ${omittedSelected} se omitiría(n) por la regla de arriba, porque ya están así o por no tener precio.` : ".")}
        </p>
        <button disabled={runBusy || !!percentError || effectiveSelected.length === 0} onClick={applySelected}>
          {runBusy ? "Trabajando… no cierres la app" : `${verb} ${mode === "restore" ? "" : percentError ? "" : `${percent}% a `}${effectiveSelected.length} producto(s)`}
        </button>
        {runBusy && (
          <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "10px 0 0" }}>
            Se escribe producto por producto en Shopify; con muchos productos puede tardar algunos minutos. Lo que ya se
            alcanzó a aplicar queda guardado en el historial aunque algo se interrumpa.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Historial</h2>
        {batches.length === 0 ? (
          <div className="empty-state">Todavía no se ha hecho ningún cambio de precios desde esta pantalla.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Cambio</th>
                <th>Productos</th>
                <th>Variantes</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const fullyReverted = b.productsReverted >= b.productsApplied;
                return (
                  <tr key={b.batchId}>
                    <td>{new Date(b.appliedAt).toLocaleString("es-CL")}</td>
                    <td>
                      {batchLabel(b)}
                      {b.kind !== "restore" && (
                        <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}> ({ROUNDING_SHORT[b.rounding]})</span>
                      )}
                    </td>
                    <td>{b.productsApplied}</td>
                    <td>{b.variantsApplied}</td>
                    <td>
                      {fullyReverted ? (
                        <span className="badge badge-code-muted">deshecho</span>
                      ) : b.productsReverted > 0 ? (
                        <span className="badge badge-pendiente">
                          deshecho en parte ({b.productsReverted}/{b.productsApplied})
                        </span>
                      ) : (
                        <span className="badge badge-sincronizado">aplicado</span>
                      )}
                    </td>
                    <td>
                      <button className="secondary small" disabled={runBusy || fullyReverted} onClick={() => void revertBatch(b)}>
                        Deshacer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
