import { useEffect, useState } from "react";
import type { CloudWorkerStatus } from "../../../shared-ipc-types";

/** El worker corre cada ~15 min: pasado este tiempo sin señales, algo dejó de funcionar. */
const STALE_AFTER_SECONDS = 45 * 60;

function formatAgo(seconds: number): string {
  if (seconds < 90) return "hace instantes";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h ${minutes % 60} min`;
  return `hace ${Math.floor(hours / 24)} días`;
}

/**
 * Indicador del worker de sincronización en la nube (el que sigue sincronizando
 * pedidos y stock aunque el PC esté apagado). Lee su "latido" de la base cada
 * minuto: verde = corrió hace poco y sin errores; ámbar = su última corrida
 * falló; rojo = lleva demasiado sin correr.
 */
export default function CloudSyncStatusCard() {
  const [status, setStatus] = useState<CloudWorkerStatus | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await window.blacksand.cloudWorker.getStatus();
        if (!cancelled) {
          setStatus(result);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(String(err));
      }
    }
    void load();
    const interval = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (status === undefined && !loadError) return null; // primera carga

  let tone: "ok" | "warn" | "err" | "off" = "off";
  let title = "Sincronización en la nube: todavía no se ha ejecutado";
  let detail = "Cuando el proceso en la nube corra por primera vez, aquí verás cuándo fue la última revisión de pedidos.";

  if (loadError) {
    tone = "warn";
    title = "Sincronización en la nube: no se pudo leer el estado";
    detail = loadError;
  } else if (status) {
    const ago = formatAgo(status.secondsSinceRun);
    if (status.secondsSinceRun > STALE_AFTER_SECONDS) {
      tone = "err";
      title = `Sincronización en la nube: sin señales desde ${ago}`;
      detail =
        "Debería correr cada ~15 minutos. Revisa la pestaña “Actions” del repositorio en GitHub (puede estar desactivada o fallando). Mientras tanto, la app de este PC sigue sincronizando cuando está abierta.";
    } else if (status.lastError) {
      tone = "warn";
      title = `Sincronización en la nube: la última revisión (${ago}) tuvo un error`;
      detail = status.lastError;
    } else {
      tone = "ok";
      title = `Sincronización en la nube activa: última revisión ${ago}`;
      detail = status.lastSummary ?? "Sin detalle.";
    }
  }

  const color = tone === "ok" ? "var(--ok, #2e9e5b)" : tone === "err" ? "var(--err, #d64545)" : tone === "warn" ? "var(--warn, #d69a2d)" : "var(--text-dim, #888)";

  return (
    <div className="card" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span
        aria-hidden
        style={{ width: 10, height: 10, borderRadius: "50%", background: color, marginTop: 6, flex: "none" }}
      />
      <div style={{ fontSize: 13 }}>
        <strong>{title}</strong>
        <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 4, wordBreak: "break-word" }}>{detail}</div>
      </div>
    </div>
  );
}
