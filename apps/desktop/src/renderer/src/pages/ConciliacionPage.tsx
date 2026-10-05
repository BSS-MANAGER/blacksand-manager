import { useEffect, useState } from "react";
import type { ReconciliationRow } from "../../../shared-ipc-types";
import { usePagination, paginate, Pagination } from "../lib/pagination";
import { RowActionsMenu } from "../lib/actions-menu";

export default function ConciliacionPage() {
  const [rows, setRows] = useState<ReconciliationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await window.blacksand.reconciliation.listPending());
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  // A pedido del usuario: se pagina de a 10 para que la sección no se haga
  // interminable si hay muchos casos pendientes.
  const pg = usePagination(rows?.length ?? 0);
  const pageRows = rows ? paginate(rows, pg.start, pg.end) : null;

  async function confirm(mapId: string, centralVariantId: string) {
    setBusyId(mapId);
    try {
      await window.blacksand.reconciliation.confirmMatch(mapId, centralVariantId);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function ignore(mapId: string) {
    setBusyId(mapId);
    try {
      await window.blacksand.reconciliation.ignore(mapId);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Conciliación manual</h1>
      <p className="page-subtitle">
        Casos ambiguos del importador (mismo nombre, SKU distinto o ausente) — sección G.1.
        BLACK SAND nunca fusiona automáticamente: cada match se confirma aquí antes de quedar
        activo.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {rows === null ? (
          <div className="empty-state">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">No hay casos pendientes de conciliación. 🎉</div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Canal</th>
                <th>ID en canal</th>
                <th>SKU del canal</th>
                <th>Candidatos centrales sugeridos</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows!.map((row) => (
                <tr key={row.id}>
                  <td>{row.channelCode}</td>
                  <td>
                    {row.channelProductId}
                    {row.channelVariantId ? ` / ${row.channelVariantId}` : ""}
                  </td>
                  <td>{row.channelSku ?? "—"}</td>
                  <td>
                    {row.candidates.length === 0 ? (
                      <span style={{ color: "var(--text-dim)" }}>Sin candidatos claros</span>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5 }}>
                        {row.candidates.map((c) => (
                          <span key={c.variantId}>
                            {c.sku} — {c.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <RowActionsMenu
                      actions={[
                        ...row.candidates.map((c) => ({
                          label: `Confirmar match: ${c.sku} — ${c.name}`,
                          onClick: () => confirm(row.id, c.variantId),
                          disabled: busyId === row.id,
                        })),
                        {
                          label: "Ignorar",
                          onClick: () => ignore(row.id),
                          disabled: busyId === row.id,
                          tone: "danger" as const,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={pg.page} totalPages={pg.totalPages} totalItems={rows.length} pageSize={pg.pageSize} onChange={pg.setPage} />
          </>
        )}
      </div>
    </div>
  );
}
