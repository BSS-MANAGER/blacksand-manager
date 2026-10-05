import { getDb, recordAudit, upsertChannelSyncStatus } from "@blacksand/db";
import type { ReconciliationDecision } from "@blacksand/shared";

/**
 * Aplica la decisión explícita del usuario sobre un caso ambiguo de
 * conciliación manual (sección G.1, punto 2). Nunca se decide en automático
 * — esta función solo actúa después de una confirmación humana desde la
 * pantalla "Conciliación".
 */
export async function applyReconciliationDecision(
  decision: ReconciliationDecision,
  userId?: string,
): Promise<void> {
  const db = getDb();

  const mapRow = await db.channelProductMap.findFirst({
    where: {
      channelProductId: decision.channelProductId,
      channelVariantId: decision.channelVariantId ?? "",
    },
  });
  if (!mapRow) {
    throw new Error("No se encontró el registro de conciliación pendiente");
  }

  if (decision.action === "ignorar") {
    await db.channelProductMap.delete({ where: { id: mapRow.id } });
    await recordAudit({
      userId,
      action: "conciliacion_ignorar",
      entityType: "channel_product_map",
      entityId: mapRow.id,
    });
    return;
  }

  if (decision.action === "confirmar_match") {
    const variant = await db.productVariant.findUnique({ where: { id: decision.centralVariantId } });
    if (!variant) throw new Error("Variante central no existe");

    await db.channelProductMap.update({
      where: { id: mapRow.id },
      data: {
        productId: variant.productId,
        variantId: variant.id,
        syncStatus: "sincronizado",
        lastSyncedAt: new Date(),
      },
    });
    await upsertChannelSyncStatus({ productId: variant.productId, channelId: mapRow.channelId, status: "sincronizado" });
    await recordAudit({
      userId,
      action: "conciliacion_confirmar_match",
      entityType: "channel_product_map",
      entityId: mapRow.id,
      after: { variantId: variant.id },
    });
    return;
  }

  // action === "crear_nuevo": el llamador (UI/IPC) ya debe haber creado el
  // producto/variante central antes de invocar esto con confirmar_match;
  // este caso queda documentado para que el flujo de UI lo resuelva en dos
  // pasos explícitos (crear, luego confirmar) en vez de adivinar aquí.
  throw new Error(
    "'crear_nuevo' debe resolverse creando primero el producto central y luego llamando " +
      "a esta función con action='confirmar_match'.",
  );
}
