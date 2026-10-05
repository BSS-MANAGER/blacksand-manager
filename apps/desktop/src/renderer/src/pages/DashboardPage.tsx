import { useEffect, useState } from "react";
import type { DashboardRow, PendingCancellationRow, RecentOrderRow } from "../../../shared-ipc-types";
import { StatusBadge, ErrorDetailBadge } from "../lib/badge";
import { syncErrorCodeLabel, isInformationalSyncErrorCode } from "@blacksand/shared";
import { usePagination, paginate, Pagination } from "../lib/pagination";
import { RowActionsMenu } from "../lib/actions-menu";
import CloudSyncStatusCard from "../lib/CloudSyncStatusCard";

export default function DashboardPage() {
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [orders, setOrders] = useState<RecentOrderRow[] | null>(null);
  const [pendingCancellations, setPendingCancellations] = useState<PendingCancellationRow[] | null>(null);
  const [resolvingCancellationId, setResolvingCancellationId] = useState<string | null>(null);
  const [retryingOrderId, setRetryingOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningImport, setRunningImport] = useState<string | null>(null);
  const [runningOrderPoll, setRunningOrderPoll] = useState(false);
  // Bug real reportado por el usuario: pedido #1151 (SKU em745mc) nunca
  // descontó stock en ML porque el sondeo miraba siempre una ventana fija de
  // 24h — si la app estuvo cerrada más tiempo que eso, el pedido se perdía
  // para siempre y sin ningún error visible. Ahora hay un checkpoint
  // automático (ver ipc.ts) que retoma desde la última corrida, y este
  // campo es el catch-up manual por si hace falta revisar más atrás todavía
  // (ej. un pedido más viejo que los 7 días que cubre el catch-up automático
  // la primera vez que se corre con este arreglo).
  const [catchUpDays, setCatchUpDays] = useState("");
  const [runningBackfillOrderNumbers, setRunningBackfillOrderNumbers] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      const [statusRows, orderRows, pendingRows] = await Promise.all([
        window.blacksand.dashboard.getSyncStatus(),
        window.blacksand.orders.listRecent(),
        window.blacksand.orders.listPendingCancellations(),
      ]);
      setRows(statusRows);
      setOrders(orderRows);
      setPendingCancellations(pendingRows);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  /**
   * Fase 3c (cancelaciones): resuelve a mano un pedido cancelado que quedó
   * pendiente de revisión — hoy, siempre los de Mercado Libre (no expone si
   * hay que reponer stock; los de Shopify se detectan y resuelven solos).
   */
  async function resolveCancellation(orderId: string, restocked: boolean) {
    setResolvingCancellationId(orderId);
    setMessage(null);
    setError(null);
    try {
      await window.blacksand.orders.resolveCancellation(orderId, restocked);
      setMessage(restocked ? "Stock repuesto y sincronizado con los demás canales." : "Pedido marcado como cancelado sin reposición de stock.");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setResolvingCancellationId(null);
    }
  }

  /**
   * Fase 3g: a pedido explícito del usuario — "quiero corregir los errores
   * y los estados pendientes de los pedidos del dashboard" — reintenta el
   * push de stock de un pedido puntual hacia los demás canales. No toca el
   * inventario local, solo la comunicación con los canales — seguro de
   * reintentar las veces que haga falta.
   */
  async function retrySync(orderId: string) {
    setRetryingOrderId(orderId);
    setMessage(null);
    setError(null);
    try {
      const result = await window.blacksand.orders.retrySync(orderId);
      setMessage(
        result.syncStatus === "sincronizado"
          ? "Pedido sincronizado correctamente con los demás canales."
          : `Todavía hay un error (${syncErrorCodeLabel(result.lastSyncErrorCode)}) — ver el detalle en la tabla de abajo.`,
      );
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRetryingOrderId(null);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function runImport(channel: "shopify" | "mercadolibre") {
    setRunningImport(channel);
    setMessage(null);
    setError(null);
    try {
      const result = await window.blacksand.sync.runImportNow(channel);
      setMessage(
        `Importación de ${channel} completa: ${result.totalItems} ítems · ${result.matched} emparejados · ` +
          `${result.createdNew} nuevos · ${result.ambiguous} en conciliación.` +
          (result.removedListings
            ? ` · ${result.removedListings} publicación(es) de Mercado Libre que ya no existen se marcaron como pendientes de publicar de nuevo.`
            : ""),
      );
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunningImport(null);
    }
  }

  async function runOrderPoll(customDays?: number) {
    setRunningOrderPoll(true);
    setMessage(null);
    setError(null);
    try {
      const customHours = customDays && customDays > 0 ? customDays * 24 : undefined;
      const summaries = await window.blacksand.sync.runOrderPollNow(customHours);
      if (summaries.length === 0) {
        setMessage("No hay canales conectados con pedidos para revisar.");
      } else {
        // Bug real SKU EM7405MC (ronda 4): un resumen con `connectionError`
        // significa que Mercado Libre está configurado pero no se pudo
        // conectar en esta corrida puntual (token vencido/rotado, error de
        // red) — se muestra aparte, como error real (no como parte del
        // mensaje normal de "revisados/nuevos"), porque significa que
        // NINGUNA venta se reflejó en Mercado Libre en esta corrida.
        const connectionErrors = summaries.filter((s) => s.connectionError);
        const ok = summaries.filter((s) => !s.connectionError);

        if (ok.length > 0) {
          setMessage(
            ok
              .map((s) => {
                const since = new Date(s.sinceIso).toLocaleString("es-CL", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  `${s.channel}: ${s.ordersNew} pedido(s) nuevo(s) de ${s.ordersSeen} revisados (desde ${since})` +
                  (s.ordersCancelled > 0 ? ` (${s.ordersCancelled} cancelado(s))` : "") +
                  (s.unmappedLines > 0 ? ` (${s.unmappedLines} línea(s) sin mapeo)` : "") +
                  (s.ordersRetried > 0 ? ` (${s.ordersRetried} reintentado(s) automáticamente)` : "") +
                  (s.ordersRetrySkipped > 0
                    ? ` (${s.ordersRetrySkipped} sin reintentar automáticamente — ver el detalle de cada uno en su badge)`
                    : "")
                );
              })
              .join(" · "),
          );
        }
        if (connectionErrors.length > 0) {
          setError(
            connectionErrors
              .map((s) => `${s.channel}: no se pudo conectar (${s.connectionError}) — revisá Configuración y reconectá la cuenta.`)
              .join(" · "),
          );
        }
      }
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunningOrderPoll(false);
    }
  }

  /**
   * Fase 3e (correlativo de pedidos): a pedido explícito del usuario —
   * "que los pedidos sean los correlativos de mi tienda, tambien quiero
   * actualizar los que ya estanban en la app" — rellena `orderNumber` para
   * pedidos que se ingresaron antes de que ese campo existiera (Fase 3d).
   * Fase 3f: el mismo botón ahora también asigna el correlativo "VP-#0001"
   * a las ventas de mostrador que se registraron antes de que existiera
   * ese número. Solo lee (Shopify) y escribe en la base local, no toca
   * stock — se puede correr las veces que haga falta.
   */
  async function runBackfillOrderNumbers() {
    setRunningBackfillOrderNumbers(true);
    setMessage(null);
    setError(null);
    try {
      const result = await window.blacksand.orders.backfillOrderNumbers();
      setMessage(
        `N° de pedido actualizado: ${result.shopifyUpdated} de Shopify, ${result.mercadolibreUpdated} de Mercado Libre, ${result.posUpdated} venta(s) de mostrador (VP-#)` +
          (result.shopifyErrors > 0
            ? ` (${result.shopifyErrors} pedido(s) de Shopify no se pudieron actualizar — puede que ya no existan en la tienda).`
            : "."),
      );
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunningBackfillOrderNumbers(false);
    }
  }

  const total = rows?.length ?? 0;
  const sincronizados = rows?.filter((r) => r.status === "sincronizado").length ?? 0;
  const pendientes = rows?.filter((r) => r.status === "pendiente").length ?? 0;
  // A pedido del usuario (bug `PAUSADO_SIN_STOCK`, pedido #1153): un
  // `status === "error"` cuyo código es informativo (Mercado Libre pausó
  // solo la publicación por quedarse sin stock, "sin publicar todavía",
  // etc. — ver `isInformationalSyncErrorCode`) no es un problema real que
  // el usuario necesite revisar, así que ya no infla el contador "Con
  // error". Esos casos se muestran aparte, en su propio contador.
  const errores = rows?.filter((r) => r.status === "error" && !isInformationalSyncErrorCode(r.lastErrorCode)).length ?? 0;
  const pausadosSinStock = rows?.filter((r) => r.lastErrorCode === "PAUSADO_SIN_STOCK").length ?? 0;
  const conflictos = rows?.filter((r) => r.status === "conflicto").length ?? 0;

  // A pedido del usuario: cada una de las tres tablas de abajo se pagina
  // de a 10 por separado, para que la sección no se haga interminable.
  const ordersPg = usePagination(orders?.length ?? 0);
  const pageOrders = orders ? paginate(orders, ordersPg.start, ordersPg.end) : null;
  const cancelPg = usePagination(pendingCancellations?.length ?? 0);
  const pageCancellations = pendingCancellations ? paginate(pendingCancellations, cancelPg.start, cancelPg.end) : null;
  const statusPg = usePagination(rows?.length ?? 0);
  const pageStatusRows = rows ? paginate(rows, statusPg.start, statusPg.end) : null;

  return (
    <div>
      <h1>Dashboard de sincronización</h1>
      <p className="page-subtitle">
        Columnas: sincronizado / pendiente / error / diferencia de stock / última sincronización /
        último error (sección L.1, entregable 7). Fase 3: los pedidos nuevos de Shopify/Mercado
        Libre se detectan solos y descuentan stock en ambos canales. Los pedidos cancelados también
        se detectan solos — si Shopify indica que repuso stock al cancelar, la app lo aplica sola;
        si no repuso, el stock queda descontado; Mercado Libre no da esa información, así que esos
        casos quedan pendientes de tu decisión más abajo.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}

      <CloudSyncStatusCard />

      <div className="kpi-row">
        <div className="kpi"><div className="kpi-value">{total}</div><div className="kpi-label">Productos con canal</div></div>
        <div className="kpi"><div className="kpi-value">{sincronizados}</div><div className="kpi-label">Sincronizados</div></div>
        <div className="kpi"><div className="kpi-value">{pendientes}</div><div className="kpi-label">Pendientes</div></div>
        <div className="kpi"><div className="kpi-value">{errores}</div><div className="kpi-label">Con error</div></div>
        <div className="kpi"><div className="kpi-value">{pausadosSinStock}</div><div className="kpi-label">Pausados en ML (sin stock)</div></div>
        <div className="kpi"><div className="kpi-value">{conflictos}</div><div className="kpi-label">En conflicto</div></div>
      </div>

      <div className="card">
        <h2>Importar / revalidar catálogo ahora</h2>
        <div style={{ display: "flex", gap: 10 }}>
          <button disabled={runningImport !== null} onClick={() => runImport("shopify")}>
            {runningImport === "shopify" ? "Importando Shopify…" : "Importar de Shopify"}
          </button>
          <button className="secondary" disabled={runningImport !== null} onClick={() => runImport("mercadolibre")}>
            {runningImport === "mercadolibre" ? "Importando Mercado Libre…" : "Importar de Mercado Libre"}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Pedidos (Fase 3)</h2>
        <p className="page-subtitle" style={{ marginBottom: 12 }}>
          Se revisan solos cada pocos minutos y descuentan stock automáticamente en la base local
          y en el otro canal. Este botón lo hace ahora mismo, sin esperar. La revisión ya no usa una
          ventana fija de 24 horas — recuerda hasta cuándo revisó la última vez, así que si el PC
          estuvo apagado un fin de semana o más, la próxima revisión igual cubre ese hueco completo
          en vez de perderse los pedidos de ese período en silencio.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button className="secondary" disabled={runningOrderPoll} onClick={() => runOrderPoll()}>
            {runningOrderPoll ? "Revisando pedidos…" : "Revisar pedidos ahora"}
          </button>
          <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
            ¿Sospechas que se escapó un pedido más viejo? Revisar puntualmente:
          </span>
          <input
            type="number"
            min={1}
            max={90}
            placeholder="días atrás"
            value={catchUpDays}
            onChange={(e) => setCatchUpDays(e.target.value)}
            style={{ width: 90 }}
          />
          <button
            className="secondary small"
            disabled={runningOrderPoll || !catchUpDays || Number(catchUpDays) <= 0}
            onClick={() => runOrderPoll(Number(catchUpDays))}
          >
            Revisar esos días atrás
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Pedidos recientes</h2>
        <p className="page-subtitle" style={{ marginBottom: 12 }}>
          "N° pedido" es el correlativo real de la tienda (ej. "#1023" en Shopify) o, para ventas de
          mostrador, el correlativo propio "VP-#0001". Los pedidos y ventas que se ingresaron antes de
          que existiera esta columna todavía muestran un identificador interno en vez del número real
          — este botón los actualiza.
        </p>
        <button className="secondary" disabled={runningBackfillOrderNumbers} onClick={runBackfillOrderNumbers} style={{ marginBottom: 12 }}>
          {runningBackfillOrderNumbers ? "Actualizando N° de pedido…" : "Actualizar N° de pedido de pedidos y ventas antiguas"}
        </button>
        {orders === null ? (
          <div className="empty-state">Cargando…</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Sin pedidos registrados todavía.</div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>N° pedido</th>
                <th>Canal</th>
                <th>SKU</th>
                <th>Cantidad</th>
                <th>Ítems</th>
                <th>Total</th>
                <th>Estado</th>
                <th>Último error</th>
                <th>Cancelación</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageOrders!.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.orderDate).toLocaleString("es-CL")}</td>
                  <td>{o.orderNumber ?? "—"}</td>
                  <td>{o.channelCode ?? "Mostrador"}</td>
                  <td>
                    {o.items.length === 0
                      ? "—"
                      : o.items.map((i, idx) => <div key={idx}>{i.sku}</div>)}
                  </td>
                  <td>
                    {o.items.length === 0
                      ? "—"
                      : o.items.map((i, idx) => <div key={idx}>{i.quantity}</div>)}
                  </td>
                  <td>{o.itemCount}</td>
                  <td>${o.total.toLocaleString("es-CL")}</td>
                  <td><StatusBadge status={o.syncStatus} code={o.lastSyncErrorCode} /></td>
                  <td><ErrorDetailBadge code={o.lastSyncErrorCode} detail={o.lastSyncError} /></td>
                  <td>
                    {o.status !== "cancelado" ? (
                      "—"
                    ) : o.restocked === true ? (
                      <span className="badge badge-sincronizado">Repuesto</span>
                    ) : o.restocked === false ? (
                      <span className="badge badge-error">No repuesto</span>
                    ) : (
                      <span className="badge badge-pendiente">Pendiente de revisión</span>
                    )}
                  </td>
                  <td>
                    <RowActionsMenu
                      actions={
                        o.syncStatus !== "sincronizado"
                          ? [
                              {
                                label: retryingOrderId === o.id ? "Reintentando…" : "Reintentar sincronización",
                                onClick: () => retrySync(o.id),
                                disabled: retryingOrderId === o.id,
                              },
                            ]
                          : []
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={ordersPg.page} totalPages={ordersPg.totalPages} totalItems={orders.length} pageSize={ordersPg.pageSize} onChange={ordersPg.setPage} />
          </>
        )}
      </div>

      <div className="card">
        <h2>Pedidos cancelados pendientes de revisión</h2>
        <p className="page-subtitle" style={{ marginBottom: 12 }}>
          Mercado Libre no indica si hay que reponer stock al cancelar un pedido (a diferencia de
          Shopify, que la app detecta y aplica sola) — estos pedidos esperan que elijas "Reponer
          stock" o "No reponer" antes de que la app toque el inventario.
        </p>
        {pendingCancellations === null ? (
          <div className="empty-state">Cargando…</div>
        ) : pendingCancellations.length === 0 ? (
          <div className="empty-state">No hay pedidos cancelados pendientes de revisión.</div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Fecha del pedido</th>
                <th>N° pedido</th>
                <th>Canal</th>
                <th>SKU</th>
                <th>Cantidad</th>
                <th>Cancelado</th>
                <th>Ítems</th>
                <th>Total</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {pageCancellations!.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.orderDate).toLocaleString("es-CL")}</td>
                  <td>{p.orderNumber ?? "—"}</td>
                  <td>{p.channelCode ?? "Mostrador"}</td>
                  <td>
                    {p.items.length === 0
                      ? "—"
                      : p.items.map((i, idx) => <div key={idx}>{i.sku}</div>)}
                  </td>
                  <td>
                    {p.items.length === 0
                      ? "—"
                      : p.items.map((i, idx) => <div key={idx}>{i.quantity}</div>)}
                  </td>
                  <td>{p.cancelledAt ? new Date(p.cancelledAt).toLocaleString("es-CL") : "—"}</td>
                  <td>{p.itemCount}</td>
                  <td>${p.total.toLocaleString("es-CL")}</td>
                  <td>
                    <RowActionsMenu
                      actions={[
                        {
                          label: resolvingCancellationId === p.id ? "Reponiendo…" : "Reponer stock",
                          onClick: () => resolveCancellation(p.id, true),
                          disabled: resolvingCancellationId === p.id,
                        },
                        {
                          label: "No reponer",
                          onClick: () => resolveCancellation(p.id, false),
                          disabled: resolvingCancellationId === p.id,
                          tone: "danger" as const,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={cancelPg.page} totalPages={cancelPg.totalPages} totalItems={pendingCancellations.length} pageSize={cancelPg.pageSize} onChange={cancelPg.setPage} />
          </>
        )}
      </div>

      <div className="card">
        <h2>Estado por producto/canal</h2>
        {rows === null ? (
          <div className="empty-state">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            Todavía no hay datos. Conecta Shopify y/o Mercado Libre en Configuración y corre una
            importación desde el botón de arriba.
          </div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Canal</th>
                <th>Estado</th>
                <th>Diferencia de stock</th>
                <th>Última sincronización</th>
                <th>Último error</th>
              </tr>
            </thead>
            <tbody>
              {pageStatusRows!.map((row) => (
                <tr key={row.id}>
                  <td>{row.productName}</td>
                  <td>{row.channelCode}</td>
                  <td><StatusBadge status={row.status} code={row.lastErrorCode} /></td>
                  <td>{row.stockDiff}</td>
                  <td>{row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString("es-CL") : "—"}</td>
                  <td><ErrorDetailBadge code={row.lastErrorCode} detail={row.lastError} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={statusPg.page} totalPages={statusPg.totalPages} totalItems={rows.length} pageSize={statusPg.pageSize} onChange={statusPg.setPage} />
          </>
        )}
      </div>
    </div>
  );
}
