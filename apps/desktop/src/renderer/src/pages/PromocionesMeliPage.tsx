import { useState } from "react";
import type { MeliPromotionsProbeResult } from "../../../shared-ipc-types";

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("es-CL");
}

/**
 * Promociones de Mercado Libre — paso 1: SOLO una prueba de acceso (lectura).
 * No crea ni modifica nada en Mercado Libre. Sirve para confirmar que la
 * cuenta/app tiene permiso para usar el área de Promociones y ver qué tipos
 * de promoción aparecen, antes de construir la creación masiva de campañas.
 */
export default function PromocionesMeliPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MeliPromotionsProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runProbe() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await window.blacksand.meliPromotions.probe());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Promociones de Mercado Libre</h1>
      <p className="page-subtitle">
        Paso 1: comprobar que la app puede acceder al área de Promociones de tu cuenta. Esta prueba solo LEE — no crea ni
        cambia ninguna promoción ni precio.
      </p>

      <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260, fontSize: 13 }}>
          Consulta las promociones y campañas que tu cuenta de Mercado Libre tiene o a las que puede unirse.
        </div>
        <button disabled={busy} onClick={() => void runProbe()}>
          {busy ? "Consultando Mercado Libre…" : "Probar acceso a promociones"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && result.ok && (
        <div className="success-banner">
          <strong>Hay acceso al área de Promociones (HTTP {result.status}).</strong>{" "}
          {result.promotions.length === 0
            ? "Tu cuenta no tiene promociones listadas por ahora."
            : `Mercado Libre listó ${result.promotions.length} promoción(es).`}
        </div>
      )}

      {result && !result.ok && (
        <div className="error-banner">
          <strong>Mercado Libre rechazó la consulta (HTTP {result.status}).</strong>
          {result.status === 401 || result.status === 403
            ? " Eso suele indicar que a la aplicación le falta el permiso de promociones o que hay que reconectar la cuenta en Configuración."
            : ""}
          {result.errorBody && (
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11.5, margin: "8px 0 0" }}>{result.errorBody}</pre>
          )}
        </div>
      )}

      {result && result.ok && result.promotions.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Inicio</th>
                <th>Término</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {result.promotions.map((p, i) => (
                <tr key={`${p.id}-${i}`}>
                  <td>{p.name ?? "—"}</td>
                  <td>{p.type ?? "—"}</td>
                  <td>{p.status ?? "—"}</td>
                  <td>{fmtDate(p.startDate)}</td>
                  <td>{fmtDate(p.finishDate)}</td>
                  <td style={{ fontSize: 11 }}>{p.id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
