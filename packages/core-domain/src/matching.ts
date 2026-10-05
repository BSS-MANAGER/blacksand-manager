/**
 * Estrategias de emparejamiento inicial entre catálogo central y catálogo de
 * canal (sección G.1). Regla de oro: nunca fusionar automáticamente un caso
 * ambiguo — solo SKU o código de barras EXACTOS se consideran match directo;
 * todo lo demás va a conciliación manual (G.1, punto 2).
 */

export interface CentralCatalogEntry {
  productId: string;
  variantId: string;
  sku: string;
  barcode: string | null;
}

export interface ChannelCatalogEntry {
  channelProductId: string;
  channelVariantId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string;
}

export type MatchOutcome =
  | { kind: "match_exacto"; central: CentralCatalogEntry; channel: ChannelCatalogEntry; matchedBy: "sku" | "barcode" }
  | { kind: "ambiguo"; channel: ChannelCatalogEntry; candidates: CentralCatalogEntry[] }
  | { kind: "producto_nuevo"; channel: ChannelCatalogEntry };

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Empareja una entrada de catálogo de canal contra el catálogo central.
 * SKU exacto tiene prioridad sobre código de barras exacto. Si hay más de
 * un candidato posible (o ninguno con SKU/barcode pero coincide texto de
 * forma imprecisa), se marca como ambiguo para conciliación manual — nunca
 * se decide solo.
 */
export function matchChannelEntry(
  channelEntry: ChannelCatalogEntry,
  centralCatalog: CentralCatalogEntry[],
): MatchOutcome {
  const channelSku = normalize(channelEntry.sku);
  const channelBarcode = normalize(channelEntry.barcode);

  if (channelSku) {
    const bySku = centralCatalog.filter((c) => normalize(c.sku) === channelSku);
    if (bySku.length === 1) {
      return { kind: "match_exacto", central: bySku[0]!, channel: channelEntry, matchedBy: "sku" };
    }
    if (bySku.length > 1) {
      return { kind: "ambiguo", channel: channelEntry, candidates: bySku };
    }
  }

  if (channelBarcode) {
    const byBarcode = centralCatalog.filter((c) => normalize(c.barcode) === channelBarcode);
    if (byBarcode.length === 1) {
      return { kind: "match_exacto", central: byBarcode[0]!, channel: channelEntry, matchedBy: "barcode" };
    }
    if (byBarcode.length > 1) {
      return { kind: "ambiguo", channel: channelEntry, candidates: byBarcode };
    }
  }

  if (!channelSku && !channelBarcode) {
    // Sin SKU ni código de barras: nunca se adivina por nombre solo — es
    // ambiguo por definición si existe algún candidato con nombre parecido,
    // o directamente "producto nuevo" si no hay nada remotamente similar.
    const looseCandidates = centralCatalog.filter((c) =>
      normalize(c.sku)?.includes(normalize(channelEntry.title)?.slice(0, 6) ?? "\0"),
    );
    if (looseCandidates.length > 0) {
      return { kind: "ambiguo", channel: channelEntry, candidates: looseCandidates };
    }
  }

  return { kind: "producto_nuevo", channel: channelEntry };
}

export function matchChannelCatalog(
  channelCatalog: ChannelCatalogEntry[],
  centralCatalog: CentralCatalogEntry[],
): MatchOutcome[] {
  return channelCatalog.map((entry) => matchChannelEntry(entry, centralCatalog));
}
