import { useEffect, useState } from "react";
import type { ProductRow, PosSaleResult } from "../../../shared-ipc-types";

interface CatalogRow {
  variantId: string;
  productName: string;
  sku: string;
  price: number;
  quantityOnHand: number;
}

interface CartLine {
  variantId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

const PAYMENT_METHODS = ["efectivo", "tarjeta", "transferencia", "otro"];

function flattenCatalog(products: ProductRow[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const p of products) {
    for (const v of p.variants) {
      rows.push({
        variantId: v.id,
        productName: p.name,
        sku: v.skuVariant,
        price: v.price ?? 0,
        quantityOnHand: v.quantityOnHand,
      });
    }
  }
  return rows;
}

export default function VentasPage() {
  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState("efectivo");
  const [observations, setObservations] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PosSaleResult | null>(null);

  function loadCatalog() {
    window.blacksand.products
      .list()
      .then((data) => setCatalog(flattenCatalog(data)))
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    loadCatalog();
  }, []);

  const matches =
    search.trim().length === 0
      ? []
      : (catalog ?? []).filter(
          (r) =>
            r.sku.toLowerCase().includes(search.toLowerCase()) ||
            r.productName.toLowerCase().includes(search.toLowerCase()),
        ).slice(0, 15);

  function addToCart(row: CatalogRow) {
    setCart((prev) => {
      const existing = prev.find((l) => l.variantId === row.variantId);
      if (existing) {
        return prev.map((l) => (l.variantId === row.variantId ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { variantId: row.variantId, productName: row.productName, sku: row.sku, quantity: 1, unitPrice: row.price }];
    });
    setResult(null);
  }

  function updateLine(variantId: string, patch: Partial<CartLine>) {
    setCart((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)));
  }

  function removeLine(variantId: string) {
    setCart((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  const total = cart.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  async function submitSale() {
    if (cart.length === 0) {
      setError("Agrega al menos un producto antes de registrar la venta.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await window.blacksand.pos.registerSale({
        items: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice })),
        paymentMethod,
        observations: observations.trim() || undefined,
      });
      setResult(outcome);
      setCart([]);
      setObservations("");
      loadCatalog(); // refresca el stock mostrado en el buscador
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Venta presencial</h1>
      <p className="page-subtitle">
        Registra una venta de mostrador (módulo 3, F.4): descuenta stock en la base local y lo
        empuja a todos los canales donde cada producto está mapeado. Todavía no hay ficha de
        cliente ni login de vendedores — si quieres dejar constancia de quién vendió, anótalo en
        Observaciones.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {result && (
        <div className="success-banner">
          Venta registrada: <strong>{result.orderNumber}</strong>.
          {result.pushResults.length === 0 ? (
            " Ningún producto estaba mapeado a un canal — solo se descontó stock local."
          ) : (
            <div style={{ marginTop: 6 }}>
              {result.pushResults.map((pr) => (
                <div key={pr.variantId}>
                  {pr.results.length === 0
                    ? "Sin canales mapeados."
                    : pr.results.map((r) => `${r.ok ? "✅" : "❌"} ${r.channelCode}${r.error ? `: ${r.error}` : ""}`).join(" · ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Buscar producto</h2>
        <div className="form-row">
          <label>Nombre o SKU</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ej: casco, SKU-001…" />
        </div>
        {catalog === null ? (
          <div className="empty-state">Cargando catálogo…</div>
        ) : search.trim().length > 0 && matches.length === 0 ? (
          <div className="empty-state">Sin resultados para "{search}".</div>
        ) : matches.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th>Precio</th>
                <th>Stock</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {matches.map((row) => (
                <tr key={row.variantId}>
                  <td>{row.sku}</td>
                  <td>{row.productName}</td>
                  <td>${row.price.toLocaleString("es-CL")}</td>
                  <td>{row.quantityOnHand}</td>
                  <td>
                    <button className="small" onClick={() => addToCart(row)}>
                      Agregar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="card">
        <h2>Carrito</h2>
        {cart.length === 0 ? (
          <div className="empty-state">Sin productos agregados todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th>Cantidad</th>
                <th>Precio unitario</th>
                <th>Subtotal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cart.map((line) => (
                <tr key={line.variantId}>
                  <td>{line.sku}</td>
                  <td>{line.productName}</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) => updateLine(line.variantId, { quantity: Number(e.target.value) || 1 })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.variantId, { unitPrice: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td>${(line.quantity * line.unitPrice).toLocaleString("es-CL")}</td>
                  <td>
                    <button className="secondary small" onClick={() => removeLine(line.variantId)}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="form-row" style={{ marginTop: 16 }}>
          <label>Medio de pago</label>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Observaciones</label>
          <input value={observations} onChange={(e) => setObservations(e.target.value)} placeholder="Opcional" />
        </div>

        <p style={{ fontWeight: 700, fontSize: 16 }}>Total: ${total.toLocaleString("es-CL")}</p>

        <button disabled={submitting || cart.length === 0} onClick={submitSale}>
          {submitting ? "Registrando…" : "Registrar venta"}
        </button>
      </div>
    </div>
  );
}
