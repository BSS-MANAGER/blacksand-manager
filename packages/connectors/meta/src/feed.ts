/**
 * Conector Meta / Facebook — sección A.3 / B.3 de la especificación.
 *
 * IMPORTANTE (léase antes de tocar este archivo): Facebook/Instagram Shopping
 * (catálogo con etiquetado de productos, pestaña Shop) está descontinuado para
 * cuentas de Chile desde agosto de 2023 y sigue así en 2026. La Marketplace
 * Partner Seller API es exclusiva de partners agregadores aprobados por Meta,
 * no de un comercio individual. Por lo tanto este conector NUNCA debe:
 *   - crear pedidos,
 *   - descontar o sincronizar stock,
 *   - ni tratarse como canal transaccional.
 *
 * Su único rol (Fase 6 del plan) es generar un feed de catálogo compatible
 * con Catalog API / Advantage+ catalog ads para publicidad dinámica. Esta
 * clase deja el feed generado en memoria/archivo — NO lo publica todavía
 * (eso es explícitamente responsabilidad de una fase posterior, una vez que
 * el usuario decida activar campañas).
 */

export interface MetaCatalogFeedItem {
  id: string; // SKU o SKU de variante central
  title: string;
  description: string;
  availability: "in stock" | "out of stock";
  condition: "new";
  price: string; // "12990 CLP"
  link: string; // URL del producto en la tienda Shopify
  image_link: string;
  brand?: string;
}

export interface CentralCatalogEntryForFeed {
  sku: string;
  name: string;
  description?: string | null;
  price?: number | null;
  quantityAvailable: number;
  productUrl: string;
  imageUrl?: string | null;
  brand?: string | null;
}

/** Genera las filas del feed de catálogo (formato CSV/TSV estándar de Meta Catalog). */
export function buildMetaCatalogFeed(entries: CentralCatalogEntryForFeed[]): MetaCatalogFeedItem[] {
  return entries.map((entry) => ({
    id: entry.sku,
    title: entry.name,
    description: entry.description ?? entry.name,
    availability: entry.quantityAvailable > 0 ? "in stock" : "out of stock",
    condition: "new",
    price: `${Math.round(entry.price ?? 0)} CLP`,
    link: entry.productUrl,
    image_link: entry.imageUrl ?? "",
    brand: entry.brand ?? undefined,
  }));
}

const FEED_HEADERS = [
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
] as const;

/** Serializa el feed a CSV (import manual en Commerce Manager, o vía Catalog API en Fase 6). */
export function serializeFeedToCsv(items: MetaCatalogFeedItem[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [FEED_HEADERS.join(",")];
  for (const item of items) {
    lines.push(FEED_HEADERS.map((h) => escape(String(item[h] ?? ""))).join(","));
  }
  return lines.join("\n");
}
