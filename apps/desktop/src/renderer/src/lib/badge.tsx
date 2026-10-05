import { useState } from "react";
import { syncErrorCodeLabel, isInformationalSyncErrorCode } from "@blacksand/shared";

/**
 * `code`, opcional: el código corto de error de esta misma fila (ver
 * `@blacksand/shared/sync-error-codes.ts`), cuando el llamador ya lo tiene
 * a mano. A pedido del usuario (bug `PAUSADO_SIN_STOCK`, pedido #1153): un
 * estado `"error"` cuyo código es "informativo" (`EN_REVISION`,
 * `SIN_PUBLICAR`, `PAUSADO_SIN_STOCK` — casos esperados, no un problema
 * real de la app) ya se explica solo con su propio badge
 * (`ErrorDetailBadge`, más abajo), así que acá NO se duplica con el badge
 * rojo genérico "Error" — evita el combo confuso "Error" + "Pausado (sin
 * stock)" que se veía antes en el Dashboard y en Productos para el mismo
 * caso. Sin `code` (llamadas viejas que todavía no lo pasan), el
 * comportamiento es igual que antes.
 */
export function StatusBadge({ status, code }: { status: string; code?: string | null }) {
  if (status === "error" && isInformationalSyncErrorCode(code)) {
    return null;
  }
  const cls = `badge badge-${status}`;
  const labels: Record<string, string> = {
    sincronizado: "Sincronizado",
    pendiente: "Pendiente",
    error: "Error",
    conflicto: "Conflicto",
  };
  return <span className={cls}>{labels[status] ?? status}</span>;
}

/**
 * A pedido del usuario: en vez de mostrar el texto completo de un error de
 * sincronización siempre visible en la tabla (lo que había antes — podía
 * ser varias oraciones largas por celda), esto muestra solo un código
 * corto como badge (ver `@blacksand/shared/sync-error-codes.ts`) y, al
 * hacer clic, abre el desglose completo en un popover aparte — "en otro
 * sector", no mezclado con la tabla.
 *
 * `code` puede venir `null`/`undefined` (sin error → no se renderiza nada
 * más que un guion) igual que antes se hacía con `lastError ?? "—"`.
 */
export function ErrorDetailBadge({
  code,
  detail,
}: {
  code: string | null | undefined;
  detail?: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!code) return <span style={{ color: "var(--text-dim)" }}>—</span>;

  // Un código conocido pero sin código de error en el catálogo (no
  // debería pasar) se muestra igual, con el tono genérico — nunca se
  // oculta información nueva/no identificada (mismo criterio que
  // `describeMeliError`). "SIN_PUBLICAR" (bug #1151) y "PAUSADO_SIN_STOCK"
  // (bug #1153) usan el tono suave también — ninguno de los dos es un
  // error de sincronización real: el primero es un aviso de que falta
  // publicar el producto en ese canal, el segundo es Mercado Libre
  // pausando solo una publicación sin stock (su comportamiento normal).
  const tone = isInformationalSyncErrorCode(code) ? "warn" : "err";

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className={`badge badge-code badge-code-${tone}`}
        onClick={() => setOpen((v) => !v)}
      >
        {syncErrorCodeLabel(code)}
      </button>
      {open && (
        <div className="card error-detail-popover" role="dialog">
          <div className="error-detail-popover-header">
            <strong>Detalle del error</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar">
              ×
            </button>
          </div>
          <p>{detail || "Sin más detalle disponible."}</p>
        </div>
      )}
    </span>
  );
}
