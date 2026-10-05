import { useEffect, useRef, useState } from "react";

export interface RowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}

/**
 * A pedido del usuario: en vez de una fila de tabla cada vez más ancha con
 * un botón por acción (el caso puntual que lo motivó: el botón
 * "Reintentar" en "Pedidos recientes" del Dashboard, pero pasa igual en
 * cualquier fila con dos o más acciones), esto las agrupa detrás de un
 * botón de tres puntos que despliega un menú angosto — el ancho de la fila
 * deja de depender de cuántas acciones tenga.
 *
 * Si `actions` viene vacío, no se dibuja ningún botón — se muestra un
 * guion, igual que antes cuando no había ninguna acción disponible para
 * esa fila.
 */
export function RowActionsMenu({ actions, label = "Más acciones" }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (actions.length === 0) return <span style={{ color: "var(--text-dim)" }}>—</span>;

  return (
    <div className="row-actions" ref={ref}>
      <button type="button" className="secondary small row-actions-trigger" aria-label={label} onClick={() => setOpen((v) => !v)}>
        ⋮
      </button>
      {open && (
        <div className="row-actions-menu" role="menu">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`row-actions-item${a.tone === "danger" ? " danger" : ""}`}
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
