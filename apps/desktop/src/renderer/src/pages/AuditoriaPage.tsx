import { useEffect, useState } from "react";
import type { AuditRow } from "../../../shared-ipc-types";
import { usePagination, paginate, Pagination } from "../lib/pagination";

export default function AuditoriaPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.blacksand.audit
      .list()
      .then(setRows)
      .catch((err) => setError(String(err)));
  }, []);

  // A pedido del usuario: el historial crece sin límite — se pagina de a
  // 10 para que la sección no se haga interminable.
  const pg = usePagination(rows?.length ?? 0);
  const pageRows = rows ? paginate(rows, pg.start, pg.end) : null;

  return (
    <div>
      <h1>Historial / auditoría</h1>
      <p className="page-subtitle">
        Registro de operaciones sensibles desde el primer commit (módulo 13): conexión de
        canales, importaciones y decisiones de conciliación.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {rows === null ? (
          <div className="empty-state">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">Sin actividad registrada todavía.</div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                <th>Entidad</th>
                <th>Usuario</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {pageRows!.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString("es-CL")}</td>
                  <td>{row.action}</td>
                  <td>
                    {row.entityType}
                    {row.entityId ? ` #${row.entityId.slice(0, 8)}` : ""}
                  </td>
                  <td>{row.userName ?? "sistema"}</td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{row.detail ?? "—"}</td>
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
