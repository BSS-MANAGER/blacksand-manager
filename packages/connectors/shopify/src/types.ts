/**
 * Configuración de conexión a una tienda Shopify (Custom App, sección A.1/B.1).
 * Desde que Shopify retiró el modelo de token estático para apps
 * admin-created, las apps nuevas (creadas en dev.shopify.com/dashboard)
 * entregan un Client ID + Client Secret en vez de un `shpat_...` fijo. El
 * access token real se obtiene con Client Credentials Grant (ver oauth.ts)
 * y expira cada 24h, por lo que ShopifyClient lo renueva solo.
 */
export interface ShopifyConnectionConfig {
  shopDomain: string; // ej: mi-tienda.myshopify.com
  apiVersion: string; // ej: 2026-01
  clientId: string;
  clientSecret: string;
}

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyNormalizedVariant {
  channelVariantId: string; // gid://shopify/ProductVariant/...
  sku: string | null;
  barcode: string | null;
  title: string;
  price: number | null;
  /** "Precio de comparación" de Shopify (el precio anterior, que la tienda muestra tachado) — `null` si no tiene. Se usa en "Descuentos". Opcional para no romper a quien arme esta forma a mano. */
  compareAtPrice?: number | null;
  inventoryQuantity: number | null;
  /** Valor de la opción de variante llamada "Color" (o "Colour") — `null` si el producto no tiene esa opción. Fase 2b: se publica igual en Mercado Libre (`COLOR`, ver `matchColorAttributeValue`). */
  color: string | null;
  /** Valor de la opción de variante llamada "Talla"/"Tamaño" (o "Size") — `null` si el producto no tiene esa opción. Fase 2b: se publica en Mercado Libre cuando la categoría lo exige (`SIZE`, ver `matchSizeAttributeValue`); si viene vacío, se publica como "Standard" a pedido del usuario. */
  size: string | null;
}

export interface ShopifyNormalizedProduct {
  channelProductId: string; // gid://shopify/Product/...
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  images: { url: string; position: number }[];
  variants: ShopifyNormalizedVariant[];
}

/** Declaración explícita de las capacidades que este conector soporta en Fase 1 (D.4). */
export const SHOPIFY_PHASE1_SCOPES = ["read_products", "read_inventory", "read_orders"] as const;

/** Fase 3a (F.3): pedidos leídos por sondeo para descontar stock. */
export interface ShopifyNormalizedOrderLine {
  channelProductId: string | null; // gid://shopify/Product/... (padre, para resolver el mapeo exacto)
  channelVariantId: string | null; // gid://shopify/ProductVariant/...
  sku: string | null;
  quantity: number;
  unitPrice: number;
}

export interface ShopifyNormalizedOrder {
  channelOrderId: string; // gid://shopify/Order/...
  name: string; // ej: #1023, útil para mostrar en UI
  createdAt: string; // ISO
  cancelled: boolean;
  /**
   * Fase 3c (cancelaciones): si el pedido está cancelado, indica si Shopify
   * repuso el stock al cancelar (`true`), lo dejó descontado (`false`), o no
   * se pudo determinar con confianza (`null`). Se calcula en `orders.ts`
   * (`detectShopifyRestock`) leyendo `refundLineItems.restockType` del
   * reembolso que Shopify crea junto con la cancelación — SIN VERIFICAR
   * contra una cancelación real todavía (no hay acceso a la API en vivo
   * desde este entorno, mismo criterio que el resto del proyecto). Cuando
   * viene `null`, el pedido queda "cancelado" pero pendiente de revisión
   * manual en la app, igual que ya pasa siempre con Mercado Libre — nunca
   * se adivina. Siempre `null` cuando `cancelled` es `false`.
   */
  restocked: boolean | null;
  /** `cancelReason` crudo de Shopify (CUSTOMER/DECLINED/FRAUD/INVENTORY/OTHER/STAFF) — null si no está cancelado o Shopify no lo dio. Solo para mostrar en pantalla. */
  cancelReason: string | null;
  lines: ShopifyNormalizedOrderLine[];
}
