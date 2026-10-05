import { app, BrowserWindow, dialog, shell } from "electron";
import { join } from "node:path";

// Rutas resueltas con app.getAppPath() en vez de import.meta.url/__dirname:
// funciona igual empaquetado (dentro del asar) y en desarrollo, sin
// depender de si el bundle de salida es CJS o ESM.
function outPath(...segments: string[]): string {
  return join(app.getAppPath(), "out", ...segments);
}

// bootstrapDatabase() debe correr ANTES de cualquier import de @blacksand/db
// (fija process.env.DATABASE_URL). Por eso se importa dinámicamente después.
async function main() {
  const { bootstrapDatabase } = await import("./db-bootstrap.js");
  await bootstrapDatabase();

  const { seedChannels } = await import("@blacksand/db");
  await seedChannels();

  const { registerIpcHandlers, buildChannelClients, computeOrderPollLookbackHours, recordOrderPollCheckpoint } =
    await import("./ipc.js");
  registerIpcHandlers();

  createMainWindow();

  const { startPollingScheduler, pollAllChannelOrders, syncMeliDescriptions, withOrderPollLease } = await import(
    "@blacksand/sync-engine"
  );
  const intervalMinutes = Number(process.env.SYNC_POLLING_INTERVAL_MINUTES ?? 5);
  startPollingScheduler(intervalMinutes, async () => {
    // Fase 3a (F.3): el sondeo periódico revisa pedidos nuevos en los
    // canales conectados y descuenta stock automáticamente — el botón
    // "Revisar pedidos ahora" del Dashboard hace exactamente esto mismo
    // bajo demanda, usando el mismo `buildChannelClients`.
    //
    // Bug real reportado por el usuario (pedido #1151, SKU em745mc, nunca
    // descontó stock en ML): antes esto usaba SIEMPRE una ventana fija
    // "ahora - 24h" — un pedido llegado mientras la app estuvo cerrada más
    // de 24h se perdía para siempre, sin ningún error visible. Ahora
    // `computeOrderPollLookbackHours` usa un checkpoint persistente
    // (`orderPolling.lastPollAt` en config.json) para que cada corrida
    // retome desde donde quedó la anterior, sin importar cuánto haya
    // estado cerrada la app — ver el comentario grande en `ipc.ts`.
    //
    // Sincronización 24/7: el worker en la nube también sondea pedidos. Para
    // que los dos NUNCA procesen los mismos pedidos a la vez (un descuento de
    // stock o una cancelación aplicada dos veces sería un desajuste real),
    // cada pasada se hace solo con el "turno" compartido de la base de datos:
    // si el otro proceso ya lo tiene, esta pasada se salta (la hace él).
    const leased = await withOrderPollLease("app", async () => {
      const clients = await buildChannelClients();
      const lookbackHours = computeOrderPollLookbackHours();
      const summaries = await pollAllChannelOrders(clients, lookbackHours);
      recordOrderPollCheckpoint();
      return summaries;
    });
    if (!leased.ran) {
      // eslint-disable-next-line no-console
      console.log("[polling] tick omitido: otro proceso (worker en la nube) está revisando pedidos ahora", new Date().toISOString());
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[polling] tick", new Date().toISOString(), leased.value);
  });

  // Fase 2b: mantiene la descripción de Mercado Libre igual a la de Shopify
  // sin que el usuario tenga que hacer nada — a diferencia de precio/stock
  // (que se empujan solos en cada edición/venta), la descripción no tiene
  // un evento local que la dispare, así que se revisa sola cada cierto
  // tiempo. Intervalo propio (más largo que el de pedidos) porque recorre
  // TODO el catálogo ya publicado en Mercado Libre, no solo lo nuevo — el
  // botón "Sincronizar descripciones ahora" de "Publicar en ML" hace
  // exactamente esto mismo bajo demanda.
  const descriptionSyncIntervalMinutes = Number(process.env.MELI_DESCRIPTION_SYNC_INTERVAL_MINUTES ?? 30);
  const runDescriptionSync = async () => {
    try {
      const clients = await buildChannelClients();
      if (!clients.shopify || !clients.mercadolibre) return; // canal sin conectar todavía — se omite en silencio, no es un error
      const result = await syncMeliDescriptions(clients);
      // eslint-disable-next-line no-console
      console.log("[meli-description-sync] tick", new Date().toISOString(), result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[meli-description-sync] Error:", err);
    }
  };
  startPollingScheduler(descriptionSyncIntervalMinutes, runDescriptionSync);
  // Corre una vez de inmediato al arrancar, en vez de esperar el primer
  // intervalo completo (hasta 30 min) para el primer resultado visible.
  void runDescriptionSync();
}

let mainWindow: BrowserWindow | null = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: "BLACK SAND Manager",
    autoHideMenuBar: true,
    webPreferences: {
      preload: outPath("preload", "index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(outPath("renderer", "index.html"));
  }
}

app.whenReady().then(() => {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Error inicializando BLACK SAND Manager:", err);
    // Sin esto, un error de arranque (p. ej. una migración de base de datos
    // fallida) dejaba la app sin ninguna ventana y sin ningún aviso visible.
    dialog.showErrorBox(
      "BLACK SAND Manager no pudo iniciar",
      `Ocurrió un error preparando la base de datos o la app:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  void shutdown();
});

/**
 * Bug real reportado por el usuario: tenía que reconectar Mercado Libre 2-3
 * veces al día. Antes, esta función no existía — cerrar la ventana llamaba
 * a `app.quit()` de inmediato. Si eso pasaba justo mientras había un
 * refresco de token de Mercado Libre en curso, Electron mataba el proceso
 * a mitad de un `vault.set(...)` (ver el comentario grande en
 * `getPendingMeliClientBuild`, `ipc.ts`) — Mercado Libre ya había rotado el
 * token de su lado, pero la bóveda local se quedaba con el viejo, ya
 * invalidado, y la próxima vez la reconexión era forzosa.
 *
 * Ahora, antes de cerrar de verdad, se espera a que termine ese guardado —
 * con un techo de 10s por seguridad: si algo quedara colgado (ej. sin
 * internet en ese instante), la app igual cierra en vez de quedar
 * invisible para siempre en la bandeja de tareas.
 */
async function shutdown(): Promise<void> {
  try {
    const { getPendingMeliClientBuild } = await import("./ipc.js");
    const pending = getPendingMeliClientBuild();
    if (pending) {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  } catch {
    // Si la app ni siquiera llegó a cargar ipc.ts (falla muy temprana al
    // arrancar), no hay ningún refresco en curso que esperar.
  } finally {
    app.quit();
  }
}
