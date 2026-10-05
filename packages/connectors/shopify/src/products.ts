import type { ShopifyClient } from "./client.js";
import type { ShopifyNormalizedProduct } from "./types.js";

const PRODUCTS_PAGE_QUERY = `
  query ProductsPage($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        vendor
        productType
        status
        images(first: 10) { nodes { url } }
        variants(first: 100) {
          nodes {
            id
            sku
            barcode
            title
            inventoryQuantity
            price
            compareAtPrice
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

interface ProductsPageResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      vendor: string | null;
      productType: string | null;
      status: string;
      images: { nodes: { url: string }[] };
      variants: {
        nodes: Array<{
          id: string;
          sku: string | null;
          barcode: string | null;
          title: string;
          inventoryQuantity: number | null;
          price: string | null;
          compareAtPrice: string | null;
          selectedOptions: { name: string; value: string }[];
        }>;
      };
    }>;
  };
}

/**
 * Trae el catálogo completo (todas las páginas) vía GraphQL Admin API.
 * Usado por el importador de Fase 1 (L.1, entregable 6). Para catálogos muy
 * grandes, la migración natural es a Bulk Operations API (sección B.1) —
 * fuera de alcance de Fase 1.
 */
export async function fetchAllShopifyProducts(
  client: ShopifyClient,
  onPage?: (count: number) => void,
): Promise<ShopifyNormalizedProduct[]> {
  const results: ShopifyNormalizedProduct[] = [];
  let cursor: string | null = null;

  do {
    const { data }: { data: ProductsPageResponse } = await client.graphql<ProductsPageResponse>(
      PRODUCTS_PAGE_QUERY,
      { cursor },
    );

    for (const node of data.products.nodes) {
      results.push({
        channelProductId: node.id,
        title: node.title,
        vendor: node.vendor,
        productType: node.productType,
        status: node.status,
        images: node.images.nodes.map((img, position) => ({ url: img.url, position })),
        variants: node.variants.nodes.map((v) => ({
          channelVariantId: v.id,
          sku: v.sku,
          barcode: v.barcode,
          title: v.title,
          price: v.price ? Number(v.price) : null,
          compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
          inventoryQuantity: v.inventoryQuantity,
          // "Colour" por si la tienda quedó en inglés en algún producto puntual — no debería pasar en una tienda en español, pero es gratis cubrirlo.
          color: v.selectedOptions.find((o) => /^colou?r$/i.test(o.name.trim()))?.value ?? null,
          // "Tamaño"/"Size" por si algún producto quedó con otro nombre para la opción de talla.
          size: v.selectedOptions.find((o) => /^tallas?$|^tama[ñn]os?$|^sizes?$/i.test(o.name.trim()))?.value ?? null,
        })),
      });
    }

    onPage?.(results.length);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return results;
}
