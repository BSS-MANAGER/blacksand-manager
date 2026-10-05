import { useEffect, useState } from "react";

/**
 * A pedido del usuario: las listas de más de 10 filas se paginan para que
 * la interfaz de cada sección no se haga interminable. `PAGE_SIZE` es el
 * mismo para todas las tablas de la app, para que la paginación se sienta
 * consistente en todas partes.
 */
export const PAGE_SIZE = 10;

/**
 * `resetKey` es cualquier valor que, al cambiar (un filtro, una búsqueda),
 * debe volver la paginación a la página 1 — si no, el usuario se podría
 * quedar mirando una página vacía después de filtrar. Es opcional: varias
 * tablas de esta app no tienen filtro propio, y ahí no hace falta.
 *
 * La página siempre se recalcula "clampeada" contra el total de páginas
 * actual (en vez de guardar un número que podría quedar fuera de rango),
 * así que ni siquiera hace falta `resetKey` para que la paginación quede
 * siempre en un estado válido — solo se usa para forzar volver a la
 * página 1 cuando cambia el significado de "página 2" (un filtro nuevo).
 */
export function usePagination(totalItems: number, resetKey?: unknown, pageSize: number = PAGE_SIZE) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = start + pageSize;

  return { page: clampedPage, setPage, totalPages, start, end, pageSize };
}

export function paginate<T>(items: T[], start: number, end: number): T[] {
  return items.slice(start, end);
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  const from = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  return (
    <div className="pagination">
      <button type="button" className="secondary small" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ← Anterior
      </button>
      <span className="pagination-info">
        {from}–{to} de {totalItems} · página {page} de {totalPages}
      </span>
      <button type="button" className="secondary small" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Siguiente →
      </button>
    </div>
  );
}
