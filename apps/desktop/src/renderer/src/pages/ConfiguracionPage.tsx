import { useEffect, useState } from "react";
import type { ChannelStatusRow } from "../../../shared-ipc-types";

export default function ConfiguracionPage() {
  const [channels, setChannels] = useState<ChannelStatusRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [shopDomain, setShopDomain] = useState("");
  const [apiVersion, setApiVersion] = useState("2026-01");
  const [shopifyClientId, setShopifyClientId] = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");

  const [meliClientId, setMeliClientId] = useState("");
  const [meliClientSecret, setMeliClientSecret] = useState("");
  const [meliRedirectUri, setMeliRedirectUri] = useState("https://www.mercadolibre.cl/");
  const [meliAwaitingCode, setMeliAwaitingCode] = useState(false);
  const [meliPastedCode, setMeliPastedCode] = useState("");

  const [defaultBrand, setDefaultBrand] = useState("");

  async function load() {
    try {
      const [status, publishDefaults] = await Promise.all([
        window.blacksand.channels.getStatus(),
        window.blacksand.channels.getMeliPublishDefaults(),
      ]);
      setChannels(status);
      setDefaultBrand(publishDefaults.defaultBrand ?? "");
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function saveShopify() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.blacksand.channels.saveShopifyConfig({
        shopDomain,
        apiVersion,
        clientId: shopifyClientId,
        clientSecret: shopifyClientSecret,
      });
      setMessage(`Shopify conectado: ${result.shopName}. Scopes: ${result.scopes.join(", ")}`);
      setShopifyClientSecret("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveMeli() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.blacksand.channels.saveMercadoLibreConfig({
        clientId: meliClientId,
        clientSecret: meliClientSecret,
        redirectUri: meliRedirectUri,
      });
      setMessage("Credenciales de Mercado Libre guardadas. Ahora haz clic en \"Conectar cuenta\".");
      setMeliClientSecret("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connectMeli() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.blacksand.channels.startMercadoLibreOAuth();
      setMeliAwaitingCode(true);
      setMessage(
        "Se abrió tu navegador para autorizar la app. Después de aceptar, copia la URL completa " +
          "de la página a la que te lleva (o solo el código) y pégala abajo.",
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function completeMeli() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.blacksand.channels.completeMercadoLibreOAuth(meliPastedCode);
      setMessage("Cuenta de Mercado Libre conectada correctamente.");
      setMeliAwaitingCode(false);
      setMeliPastedCode("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveDefaultBrand() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.blacksand.channels.saveMeliPublishDefaults({ defaultBrand });
      setMessage("Marca por defecto guardada.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Configuración de conexiones y credenciales</h1>
      <p className="page-subtitle">
        Módulo 16. Los tokens y client secrets se guardan en la bóveda de credenciales del sistema
        operativo — nunca en texto plano (sección D.5).
      </p>

      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}

      <div className="card">
        <h2>Estado de canales</h2>
        {channels === null ? (
          <div className="empty-state">Cargando…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Canal</th>
                <th>Configurado</th>
                <th>Activo</th>
                <th>Última verificación</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.code}>
                  <td>{c.name}</td>
                  <td>{c.configured ? "Sí" : "No"}</td>
                  <td>{c.isActive ? "Sí" : "No"}</td>
                  <td>{c.lastVerified ? new Date(c.lastVerified).toLocaleString("es-CL") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Shopify — Custom App</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: -6 }}>
          Scopes mínimos requeridos en Fase 1: read_products, read_inventory, read_orders (L.1).
        </p>
        <div className="form-row">
          <label>Dominio de la tienda</label>
          <input placeholder="mi-tienda.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Versión de API</label>
          <input placeholder="2026-01" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Client ID</label>
          <input
            placeholder="c8610a92656c46b09423f1f290072057"
            value={shopifyClientId}
            onChange={(e) => setShopifyClientId(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>Client Secret</label>
          <input
            type="password"
            placeholder="shpss_…"
            value={shopifyClientSecret}
            onChange={(e) => setShopifyClientSecret(e.target.value)}
          />
        </div>
        <button disabled={busy || !shopDomain || !shopifyClientId || !shopifyClientSecret} onClick={saveShopify}>
          Guardar y verificar
        </button>
      </div>

      <div className="card">
        <h2>Mercado Libre (sitio MLC) — OAuth2</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: -6 }}>
          Crea la aplicación en developers.mercadolibre.com/devcenter con este mismo redirect URI.
          Mercado Libre exige que el redirect_uri sea una dirección pública real (rechaza
          "localhost"), así que no hay servidor local que capture el código automáticamente: al
          autorizar, Mercado Libre te llevará a esta dirección con el código en la URL —
          cópiala completa y pégala abajo para terminar de conectar la cuenta.
        </p>
        <div className="form-row">
          <label>Client ID</label>
          <input value={meliClientId} onChange={(e) => setMeliClientId(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Client Secret</label>
          <input type="password" value={meliClientSecret} onChange={(e) => setMeliClientSecret(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Redirect URI</label>
          <input value={meliRedirectUri} onChange={(e) => setMeliRedirectUri(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button disabled={busy || !meliClientId || !meliClientSecret} onClick={saveMeli}>
            Guardar credenciales
          </button>
          <button className="secondary" disabled={busy} onClick={connectMeli}>
            Conectar cuenta (abre el navegador)
          </button>
        </div>
        {meliAwaitingCode && (
          <div className="form-row" style={{ marginTop: 14 }}>
            <label>URL (o código) tras autorizar</label>
            <input
              placeholder="https://www.mercadolibre.cl/?code=TG-..."
              value={meliPastedCode}
              onChange={(e) => setMeliPastedCode(e.target.value)}
            />
            <button disabled={busy || !meliPastedCode} onClick={completeMeli} style={{ marginTop: 8 }}>
              Confirmar conexión
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Publicar en Mercado Libre (Fase 2b)</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: -6 }}>
          Marca (`BRAND`) que se usa al publicar un producto de Shopify en Mercado Libre cuando ese
          producto no tiene marca/vendor propia. Es obligatoria en casi todas las categorías — sin
          esto, esos productos quedan marcados como error en "Publicar en ML".
        </p>
        <div className="form-row">
          <label>Marca por defecto</label>
          <input
            placeholder="ej. BLACK SAND, o una marca genérica"
            value={defaultBrand}
            onChange={(e) => setDefaultBrand(e.target.value)}
          />
        </div>
        <button disabled={busy || !defaultBrand.trim()} onClick={saveDefaultBrand}>
          Guardar
        </button>
      </div>

      <div className="card">
        <h2>Meta / Facebook</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          Deshabilitado a propósito en Fase 1: Facebook/Instagram Shopping no está disponible para
          cuentas de Chile. Este canal solo generará un feed de catálogo para publicidad en Fase 6
          (sección A.3).
        </p>
      </div>
    </div>
  );
}
