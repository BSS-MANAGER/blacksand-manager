import { getDb } from "../client.js";

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Registro de auditoría (módulo 13). Toda operación sensible de Fase 1
 * (conexión de canal, importación, conciliación manual, cambio de credencial)
 * debe pasar por aquí — nunca se sobrescribe ni se borra un registro existente.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const db = getDb();
  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before !== undefined ? JSON.stringify(entry.before) : null,
      after: entry.after !== undefined ? JSON.stringify(entry.after) : null,
    },
  });
}

export async function listAuditLog(limit = 200) {
  const db = getDb();
  return db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: true },
  });
}

/**
 * Trae los eventos de auditoría de cualquiera de las acciones indicadas,
 * del más viejo al más nuevo, con `after` ya parseado desde JSON. Lo usa
 * "Descuentos" (`bulk-discount.ts`, @blacksand/sync-engine): guarda UNA
 * entrada de auditoría por producto con el precio de antes y de después de
 * cada variante, y desde ahí arma el historial de descuentos y sabe qué
 * restaurar al revertir — sin necesidad de una tabla nueva (el
 * `AuditLog` ya es el registro permanente, nunca se borra ni se pisa).
 */
export async function listAuditEntriesByActions(
  actions: string[],
  limit = 5000,
): Promise<{ createdAt: Date; action: string; entityId: string | null; after: unknown }[]> {
  const db = getDb();
  const rows = await db.auditLog.findMany({
    where: { action: { in: actions } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows
    .reverse()
    .map((r) => ({
      createdAt: r.createdAt,
      action: r.action,
      entityId: r.entityId,
      after: r.after ? (JSON.parse(r.after) as unknown) : null,
    }));
}

/**
 * Para un producto puntual, trae sus eventos "publicar_en_canal" ordenados
 * por fecha (el más viejo primero) con `after` ya parseado desde JSON —
 * `meli-duplicate-fix.ts` (@blacksand/sync-engine) los usa para saber CUÁL
 * de dos publicaciones vivas para la misma variante se creó primero (ver el
 * comentario grande en `MeliDuplicateGroup`, shared-ipc-types.ts: el caso
 * real de ~20 productos publicados dos veces por un doble clic).
 */
export async function listPublishAuditEntriesForEntity(
  entityId: string,
): Promise<{ createdAt: Date; after: { itemId?: string; sku?: string } | null }[]> {
  const db = getDb();
  const rows = await db.auditLog.findMany({
    where: { action: "publicar_en_canal", entityId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    createdAt: r.createdAt,
    after: r.after ? (JSON.parse(r.after) as { itemId?: string; sku?: string }) : null,
  }));
}
