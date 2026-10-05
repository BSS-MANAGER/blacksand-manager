import { disconnectDb, recordWorkerHeartbeat } from "@blacksand/db";
import { pollAllChannelOrders, withOrderPollLease, type OrderIngestSummary } from "@blacksand/sync-engine";
import { buildWorkerClients } from "./channel-clients.js";
import { loadWorkerConfig } from "./config.js";

/**
 * Worker en la nube — UNA pasada y termina. El "siempre corriendo" lo da el
 * cron externo (GitHub Actions, ver `.github/workflows/sync-orders.yml`): cada
 * disparo prende un contenedor, corre esto, y lo apaga.
 *
 * Qué hace en cada pasada: revisa pedidos nuevos/cancelados de Shopify y
 * Mercado Libre, descuenta stock y lo empuja al otro canal, y reintenta los
 * pedidos que quedaron con error recuperable — exactamente lo mismo que el
 * sondeo de la app de escritorio (`pollAllChannelOrders`), con la misma base de
 * datos. Antes de empezar toma el "turno" compartido de la base: si la app de
 * escritorio está justo en medio de su propia pasada, esta se salta (no pasa
 * nada, la hace la app).
 *
 * Código de salida: 0 = todo bien (o pasada omitida por turno ocupado);
 * 1 = algo falló. Un 1 hace que el workflow de GitHub falle y GitHub avise por
 * correo — esa es la alarma de "la sincronización en la nube se rompió".
 */
const HEARTBEAT_KEY = "order-poll";

function describeSummaries(summaries: OrderIngestSummary[]): string {
  return summaries
    .map((s) =>
      s.connectionError
        ? `${s.channel}: sin conexión`
        : `${s.channel}: ${s.ordersSeen} vistos, ${s.ordersNew} nuevos, ${s.ordersCancelled} cancelados, ${s.ordersRetried} reintentados`,
    )
    .join(" · ");
}

async function main(): Promise<number> {
  const config = loadWorkerConfig();
  const startedAt = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[cloud-worker] inicio ${startedAt} (mira ${config.lookbackHours} h hacia atrás)`);

  const clients = await buildWorkerClients(config);
  const leased = await withOrderPollLease("cloud-worker", () => pollAllChannelOrders(clients, config.lookbackHours));

  if (!leased.ran) {
    // eslint-disable-next-line no-console
    console.log("[cloud-worker] otro proceso (la app de escritorio) está revisando pedidos ahora — se omite esta pasada.");
    return 0;
  }

  const summaries = leased.value;
  const summaryText = describeSummaries(summaries);
  // eslint-disable-next-line no-console
  console.log("[cloud-worker] resultado:", JSON.stringify(summaries));

  const connectionErrors = summaries.filter((s) => s.connectionError).map((s) => `${s.channel}: ${s.connectionError}`);
  if (connectionErrors.length > 0) {
    const message = connectionErrors.join(" | ");
    await recordWorkerHeartbeat(HEARTBEAT_KEY, summaryText, message);
    // eslint-disable-next-line no-console
    console.error(`[cloud-worker] ERROR de conexión — ${message}`);
    return 1;
  }

  await recordWorkerHeartbeat(HEARTBEAT_KEY, summaryText, null);
  return 0;
}

main()
  .then(async (code) => {
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (err) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // eslint-disable-next-line no-console
    console.error(`[cloud-worker] ERROR: ${message}`);
    // Si la base responde, se deja constancia del fallo para que la app lo muestre; si no responde, no se puede (y no se tapa el error original).
    try {
      await recordWorkerHeartbeat(HEARTBEAT_KEY, null, message);
    } catch {
      // sin base no hay dónde anotar
    }
    await disconnectDb().catch(() => undefined);
    process.exit(1);
  });
