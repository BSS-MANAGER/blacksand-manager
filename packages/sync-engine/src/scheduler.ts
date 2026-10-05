/**
 * Sondeo (polling) programado — sección D.2. Un PC doméstico no puede recibir
 * webhooks de forma confiable, así que en Fase 1-3 el dashboard se mantiene
 * al día repitiendo la importación/reconciliación cada N minutos
 * (SYNC_POLLING_INTERVAL_MINUTES, objetivo inicial: 5 minutos — L.2).
 *
 * Evolución futura (Fase 4+, opcional): reemplazar o complementar esto con
 * un relay serverless que reciba los webhooks reales (D.2, punto 2) — el
 * contrato de este módulo (una función `tick` async) no cambia.
 */
export type PollingTick = () => Promise<void>;

export interface PollingHandle {
  stop: () => void;
}

export function startPollingScheduler(intervalMinutes: number, tick: PollingTick): PollingHandle {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // evita solapar corridas si una importación tarda más que el intervalo
    running = true;
    tick()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[sync-engine] Error en sondeo periódico:", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
