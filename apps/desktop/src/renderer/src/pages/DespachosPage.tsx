import { useCallback, useEffect, useState } from "react";
import type {
  ShippingDayDto,
  ShippingGmailStatus,
  ShippingMonthSummaryDto,
  ShippingSyncResult,
} from "../../../shared-ipc-types";

/**
 * "Despachos" — registro de los días calendario en que el usuario llevó
 * paquetes a un punto Blue Express o a un punto de Mercado Libre (la empresa
 * le paga bencina por cada día). Se arma leyendo los correos de comprobante
 * de Gmail (solo lectura); cualquier día se puede marcar/desmarcar a mano.
 */

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function clp(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-CL");
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

const CARRIER_NAME = { BLUE_EXPRESS: "Blue Express", MERCADO_LIBRE: "Mercado Libre" } as const;
const REF_LABEL = { BLUE_EXPRESS: "N° de orden de servicio", MERCADO_LIBRE: "N° de venta" } as const;

function fmtDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} de ${MONTH_NAMES[m - 1]} de ${y}`;
}

function carrierLabel(d: ShippingDayDto): string {
  const parts: string[] = [];
  if (d.carriers.includes("BLUE_EXPRESS")) parts.push("Blue Express");
  if (d.carriers.includes("MERCADO_LIBRE")) parts.push("Mercado Libre");
  return parts.join(" + ");
}

export default function DespachosPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [status, setStatus] = useState<ShippingGmailStatus | null>(null);
  const [summary, setSummary] = useState<ShippingMonthSummaryDto | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "sync" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [rateInput, setRateInput] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const loadMonth = useCallback(async (y: number, m: number) => {
    try {
      setSummary(await window.blacksand.shipping.getMonth(y, m));
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  const runSync = useCallback(
    async (silent: boolean) => {
      setBusy("sync");
      setError(null);
      if (!silent) setInfo(null);
      try {
        const r: ShippingSyncResult = await window.blacksand.shipping.sync();
        setStatus(await window.blacksand.shipping.getStatus());
        setInfo(
          r.newEvents > 0
            ? `Se registraron ${r.newEvents} comprobante(s) nuevo(s) de despacho.`
            : "Gmail revisado: no hay comprobantes nuevos.",
        );
        await loadMonth(year, month);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(null);
      }
    },
    [loadMonth, year, month],
  );

  // Carga inicial: estado de Gmail y, si ya está conectado, revisa correos nuevos.
  useEffect(() => {
    void (async () => {
      try {
        const st = await window.blacksand.shipping.getStatus();
        setStatus(st);
        setRateInput(String(st.dailyRate));
        if (st.connected) void runSync(true);
      } catch (err) {
        setError(errText(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMonth(year, month);
  }, [year, month, loadMonth]);

  function shiftMonth(delta: number) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  async function saveClient() {
    setBusy("save");
    setError(null);
    try {
      setStatus(await window.blacksand.shipping.saveGoogleClient({ clientId, clientSecret }));
      setClientSecret("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("connect");
    setError(null);
    setInfo("Se abrió tu navegador: elige arenanegraseguridad@gmail.com y acepta el permiso de solo lectura.");
    try {
      const st = await window.blacksand.shipping.connectGmail();
      setStatus(st);
      setInfo("Gmail conectado. Revisando correos…");
      await runSync(true);
    } catch (err) {
      setInfo(null);
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    try {
      setStatus(await window.blacksand.shipping.disconnectGmail());
    } catch (err) {
      setError(errText(err));
    }
  }

  async function toggleDay(d: ShippingDayDto) {
    try {
      // Si ya hay un ajuste manual, se quita (vuelve a depender de los correos); si no, se invierte el estado actual.
      await window.blacksand.shipping.setDayOverride(d.day, d.override !== null ? null : !d.dispatched);
      await loadMonth(year, month);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function saveRate() {
    const n = Number(rateInput.replace(/[^\d]/g, ""));
    if (!Number.isFinite(n)) return;
    try {
      await window.blacksand.shipping.setDailyRate(n);
      setStatus(await window.blacksand.shipping.getStatus());
      await loadMonth(year, month);
    } catch (err) {
      setError(errText(err));
    }
  }

  // Calendario: lunes primero.
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const selectedDetail = summary?.days.find((d) => d.day === selectedDay) ?? null;

  return (
    <div>
      <h1>Despachos</h1>
      <p className="page-subtitle">
        Días en que dejaste paquetes en un punto Blue Express o de Mercado Libre, según los correos de comprobante de{" "}
        {status?.email ?? "arenanegraseguridad@gmail.com"}. Cada día con despacho se paga a la tarifa diaria de bencina.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {info && !error && <div className="success-banner">{info}</div>}

      {status && !status.clientConfigured && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Paso 1 — Datos de la app de Google</h3>
          <p style={{ fontSize: 13 }}>
            Pega aquí el <strong>ID de cliente</strong> y el <strong>secreto de cliente</strong> que creaste en Google Cloud
            (tipo "Aplicación de escritorio"). El secreto se guarda cifrado en el equipo, no en archivos de texto.
          </p>
          <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
            <input
              placeholder="ID de cliente (termina en .apps.googleusercontent.com)"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <input
              type="password"
              placeholder="Secreto de cliente (empieza con GOCSPX-)"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <div>
              <button disabled={busy !== null || !clientId.trim() || !clientSecret.trim()} onClick={() => void saveClient()}>
                {busy === "save" ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {status && status.clientConfigured && !status.connected && (
        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260, fontSize: 13 }}>
            <strong>Paso 2 — Conectar Gmail.</strong> Se abrirá tu navegador para que autorices el acceso de{" "}
            <em>solo lectura</em> (la app no puede enviar, borrar ni modificar correos).
          </div>
          <button disabled={busy !== null} onClick={() => void connect()}>
            {busy === "connect" ? "Esperando autorización…" : "Conectar Gmail"}
          </button>
        </div>
      )}

      {status && status.connected && (
        <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240, fontSize: 13 }}>
            Gmail conectado{status.email ? ` (${status.email})` : ""}.{" "}
            {status.lastSyncAt
              ? `Última revisión: ${new Date(status.lastSyncAt).toLocaleString("es-CL")}.`
              : "Aún no se revisan los correos."}
          </div>
          <button disabled={busy !== null} onClick={() => void runSync(false)}>
            {busy === "sync" ? "Revisando Gmail…" : "Actualizar desde el correo"}
          </button>
          <button className="secondary small" disabled={busy !== null} onClick={() => void disconnect()}>
            Desconectar
          </button>
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <button className="secondary small" onClick={() => shiftMonth(-1)}>
            ←
          </button>
          <h2 style={{ margin: 0, minWidth: 190, textAlign: "center", textTransform: "capitalize" }}>
            {MONTH_NAMES[month - 1]} {year}
          </h2>
          <button className="secondary small" onClick={() => shiftMonth(1)}>
            →
          </button>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            Tarifa por día: $
            <input
              style={{ width: 90 }}
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              onBlur={() => void saveRate()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRate();
              }}
            />
          </label>
        </div>

        {summary && (
          <div
            style={{
              padding: "10px 14px",
              marginBottom: 14,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--panel-2)",
              fontSize: 15,
            }}
          >
            <strong style={{ textTransform: "capitalize" }}>{MONTH_NAMES[month - 1]}</strong>: se hicieron despachos{" "}
            <strong>
              {summary.dispatchedDays} de {summary.daysInMonth} días
            </strong>{" "}
            del mes → monto a pagar:{" "}
            <strong style={{ color: "var(--accent)", fontSize: 18 }}>{clp(summary.amount)}</strong>{" "}
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({clp(summary.dailyRate)} por día)</span>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {WEEKDAYS.map((w) => (
            <div key={w} style={{ textAlign: "center", fontSize: 12, color: "var(--text-dim)", paddingBottom: 2 }}>
              {w}
            </div>
          ))}
          {Array.from({ length: firstWeekday }).map((_, i) => (
            <div key={`blank-${i}`} />
          ))}
          {summary?.days.map((d) => {
            const dayNum = Number(d.day.slice(8));
            const manual = d.override !== null;
            return (
              <div
                key={d.day}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedDay(d.day === selectedDay ? null : d.day)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelectedDay(d.day === selectedDay ? null : d.day);
                }}
                title={
                  d.dispatched
                    ? `Despacho${carrierLabel(d) ? ` · ${carrierLabel(d)}` : ""}${manual ? " (marcado a mano)" : ""}. Clic para ver el detalle.`
                    : "Sin despacho. Clic para ver el detalle."
                }
                style={{
                  minHeight: 66,
                  padding: 6,
                  borderRadius: 8,
                  cursor: "pointer",
                  userSelect: "none",
                  background: d.dispatched ? "rgba(76,175,125,0.18)" : "var(--panel)",
                  border: `1px ${manual ? "dashed" : "solid"} ${
                    d.day === todayKey ? "var(--accent)" : d.dispatched ? "var(--ok)" : "var(--border)"
                  }`,
                  outline:
                    d.day === selectedDay ? "2px solid var(--accent)" : d.day === todayKey ? "1px solid var(--accent)" : undefined,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <strong>{dayNum}</strong>
                  {d.dispatched && <span style={{ color: "var(--ok)" }}>✓</span>}
                </div>
                {d.fromEmails && (
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.3 }}>
                    {d.carriers.includes("BLUE_EXPRESS") && <div>BX</div>}
                    {d.carriers.includes("MERCADO_LIBRE") && <div>ML</div>}
                    <div>{d.packages} paq.</div>
                    {d.events.some((ev) => ev.refs.length > 0) && <div>{d.events.reduce((s, ev) => s + ev.refs.length, 0)} N°</div>}
                  </div>
                )}
                {manual && !d.fromEmails && d.dispatched && (
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 4 }}>manual</div>
                )}
                {manual && d.fromEmails && !d.dispatched && (
                  <div style={{ fontSize: 10.5, color: "var(--err)", marginTop: 4 }}>quitado</div>
                )}
              </div>
            );
          })}
        </div>

        {selectedDetail && (
          <div
            style={{
              marginTop: 14,
              padding: "12px 14px",
              border: "1px solid var(--accent-dim)",
              borderRadius: 8,
              background: "var(--panel-2)",
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>{fmtDay(selectedDetail.day)}</strong>
              <span style={{ color: selectedDetail.dispatched ? "var(--ok)" : "var(--text-dim)" }}>
                {selectedDetail.dispatched ? "✓ Cuenta como día con despacho" : "Sin despacho"}
                {selectedDetail.override !== null ? " (ajuste manual)" : ""}
              </span>
              <div style={{ flex: 1 }} />
              <button className="secondary small" onClick={() => void toggleDay(selectedDetail)}>
                {selectedDetail.override !== null
                  ? "Quitar ajuste manual"
                  : selectedDetail.dispatched
                    ? "Desmarcar este día"
                    : "Marcar como día con despacho"}
              </button>
            </div>
            {selectedDetail.events.length === 0 && (
              <div style={{ color: "var(--text-dim)" }}>No hay comprobantes de despacho en el correo para este día.</div>
            )}
            {selectedDetail.events.map((ev, i) => (
              <div key={i} style={{ marginTop: 6 }}>
                <strong>{CARRIER_NAME[ev.carrier]}</strong> · {ev.packages} paquete(s)
                {ev.refs.length > 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {REF_LABEL[ev.carrier]}: <span style={{ color: "var(--text)", userSelect: "text" }}>{ev.refs.join(", ")}</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    Sin números de orden/venta registrados (se completan al revisar el correo, si aún existe).
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 0 }}>
          Verde = día con despacho (BX = Blue Express, ML = Mercado Libre). Haz clic en un día para ver sus números de
          orden / venta y, si quieres, marcarlo o desmarcarlo a mano (borde punteado). Un día cuenta una sola vez aunque
          tenga varios correos. Los despachos ya detectados quedan guardados en la app aunque después borres el correo.
        </p>
      </div>

      {summary && summary.days.some((d) => d.events.length > 0) && (
        <div className="card">
          <h3 style={{ marginTop: 0, textTransform: "capitalize" }}>
            Detalle de {MONTH_NAMES[month - 1]} {year}
          </h3>
          <table>
            <thead>
              <tr>
                <th>Día</th>
                <th>Transportista</th>
                <th>Paquetes</th>
                <th>N° de orden de servicio / de venta</th>
              </tr>
            </thead>
            <tbody>
              {summary.days.flatMap((d) =>
                d.events.map((ev, i) => (
                  <tr key={`${d.day}-${i}`}>
                    <td>{Number(d.day.slice(8))}</td>
                    <td>{CARRIER_NAME[ev.carrier]}</td>
                    <td>{ev.packages}</td>
                    <td style={{ fontSize: 12, userSelect: "text" }}>{ev.refs.length > 0 ? ev.refs.join(", ") : "—"}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
