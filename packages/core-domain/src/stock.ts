/**
 * Cálculo de stock disponible (sección E.1: quantityAvailable es calculado,
 * no persistido) y detección de discrepancias entre el stock consolidado
 * central y lo que reporta cada canal (usado por el dashboard de
 * sincronización, módulo 5, y por F.5 — resolución de conflictos).
 */

export interface InventorySnapshot {
  quantityOnHand: number;
  quantityCommitted: number;
  safetyStock: number;
}

export function calculateAvailableQuantity(snapshot: InventorySnapshot): number {
  return Math.max(0, snapshot.quantityOnHand - snapshot.quantityCommitted - snapshot.safetyStock);
}

export interface StockComparison {
  centralAvailable: number;
  channelReported: number | null;
}

export type StockDiscrepancy =
  | { kind: "sin_datos_de_canal" }
  | { kind: "coincide" }
  | { kind: "discrepancia"; diff: number };

/** diff > 0: el canal muestra MÁS stock del que hay en realidad (riesgo de sobreventa). */
export function detectStockDiscrepancy(comparison: StockComparison): StockDiscrepancy {
  if (comparison.channelReported === null) return { kind: "sin_datos_de_canal" };
  const diff = comparison.channelReported - comparison.centralAvailable;
  if (diff === 0) return { kind: "coincide" };
  return { kind: "discrepancia", diff };
}
