import type { ShopifyConnectionConfig } from "./types.js";
import { ensureFreshShopifyToken, normalizeShopDomain, requestShopifyAccessToken, type ShopifyTokenSet } from "./oauth.js";

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public readonly errors?: unknown,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

export interface ShopifyGraphQLResult<T> {
  data: T;
  throttleStatus?: ShopifyThrottleStatus;
}

/**
 * Cliente mínimo de la GraphQL Admin API (sección B.1). No implementa
 * escritura en Fase 1 — solo consultas de lectura (productos/inventario).
 * Respeta `throttleStatus.currentlyAvailable` para que el motor de
 * sincronización pueda espaciar llamadas (F.6 / I: rate limits).
 */
export class ShopifyClient {
  // Cache en memoria del access token vigente (Client Credentials Grant,
  // expira ~24h — ver oauth.ts). Cada ShopifyClient nuevo empieza sin
  // caché y pide uno la primera vez que se necesita.
  private tokenSet: ShopifyTokenSet | null = null;

  constructor(private readonly config: ShopifyConnectionConfig) {}

  private get endpoint(): string {
    return `https://${normalizeShopDomain(this.config.shopDomain)}/admin/api/${this.config.apiVersion}/graphql.json`;
  }

  private async getAccessToken(): Promise<string> {
    this.tokenSet = this.tokenSet
      ? await ensureFreshShopifyToken(this.config, this.tokenSet)
      : await requestShopifyAccessToken(this.config);
    return this.tokenSet.accessToken;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<ShopifyGraphQLResult<T>> {
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause) : String(err);
      throw new ShopifyApiError(`No se pudo conectar con ${this.endpoint}. Detalle: ${cause}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ShopifyApiError(`Shopify respondió ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: unknown;
      extensions?: { cost?: { throttleStatus?: ShopifyThrottleStatus } };
    };

    if (json.errors) {
      // Igual que con los otros errores de Shopify: Electron IPC solo
      // propaga `.message` al renderer, así que el detalle va incrustado
      // ahí (no solo en `errors`, que se pierde al cruzar el puente IPC).
      throw new ShopifyApiError(`Shopify GraphQL devolvió errores: ${JSON.stringify(json.errors)}`, json.errors);
    }
    if (!json.data) {
      throw new ShopifyApiError("Shopify GraphQL no devolvió `data`");
    }

    return { data: json.data, throttleStatus: json.extensions?.cost?.throttleStatus };
  }

  /** Confirma que el token es válido y los scopes alcanzan para Fase 1 (lectura). */
  async verifyAccess(): Promise<{ shopName: string; scopes: string[] }> {
    const result = await this.graphql<{
      shop: { name: string };
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(
      `query VerifyAccess {
        shop { name }
        currentAppInstallation { accessScopes { handle } }
      }`,
    );
    return {
      shopName: result.data.shop.name,
      scopes: result.data.currentAppInstallation.accessScopes.map((s) => s.handle),
    };
  }

  /**
   * Fase 2a: actualiza precio y/o SKU de una variante ya existente en
   * Shopify (nunca crea variantes/productos nuevos — eso quedaba fuera de
   * alcance hasta "Crear producto", ver `createProduct` más abajo, que sí
   * crea un producto+variante nuevos y reusa este mismo método para
   * completarle precio/SKU/código de barras). Requiere el gid del producto
   * padre (`channelProductId`) porque `productVariantsBulkUpdate` opera
   * sobre variantes de un mismo producto.
   *
   * `barcode` se agregó para "Crear producto" — a diferencia de
   * `price`/`sku` (que van dentro de `inventoryItem`), `barcode` es un
   * campo de primer nivel de `ProductVariantsBulkInput` según la
   * documentación general de la Admin API; no se confirmó todavía contra
   * esta cuenta puntual (ningún flujo anterior de la app lo necesitaba).
   */
  async updateVariantPriceAndSku(
    productGid: string,
    variantGid: string,
    patch: { price?: number; sku?: string; barcode?: string | null },
  ): Promise<void> {
    if (patch.price === undefined && patch.sku === undefined && patch.barcode === undefined) return;

    const variantInput: Record<string, unknown> = { id: variantGid };
    if (patch.price !== undefined) variantInput.price = patch.price.toFixed(2);
    if (patch.sku !== undefined) variantInput.inventoryItem = { sku: patch.sku };
    if (patch.barcode !== undefined) variantInput.barcode = patch.barcode ?? "";

    const result = await this.graphql<{
      productVariantsBulkUpdate: {
        productVariants: { id: string }[];
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      { productId: productGid, variants: [variantInput] },
    );

    const errors = result.data.productVariantsBulkUpdate.userErrors;
    if (errors.length > 0) {
      throw new ShopifyApiError(
        `Shopify rechazó la actualización de precio/SKU: ${JSON.stringify(errors)}`,
        errors,
      );
    }
  }

  /**
   * "Descuentos masivos": fija precio Y precio de comparación (el precio
   * anterior que la tienda muestra tachado) de varias variantes de UN mismo
   * producto en una sola llamada — `productVariantsBulkUpdate` ya opera
   * sobre un producto con una lista de variantes, así que un producto con
   * varias tallas/colores cuesta una mutación, no una por variante.
   * `compareAtPrice: null` BORRA el precio de comparación (se usa al
   * revertir un descuento sobre un producto que antes no tenía ninguno).
   * Los dos valores se mandan siempre juntos a propósito: así nunca queda
   * un estado intermedio raro (precio nuevo con el tachado viejo).
   */
  async updateVariantPrices(
    productGid: string,
    variants: { variantGid: string; price: number; compareAtPrice: number | null }[],
  ): Promise<void> {
    if (variants.length === 0) return;

    const result = await this.graphql<{
      productVariantsBulkUpdate: {
        productVariants: { id: string }[];
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      {
        productId: productGid,
        variants: variants.map((v) => ({
          id: v.variantGid,
          price: v.price.toFixed(2),
          compareAtPrice: v.compareAtPrice === null ? null : v.compareAtPrice.toFixed(2),
        })),
      },
    );

    const errors = result.data.productVariantsBulkUpdate.userErrors;
    if (errors.length > 0) {
      throw new ShopifyApiError(`Shopify rechazó la actualización de precios: ${JSON.stringify(errors)}`, errors);
    }
  }

  /**
   * "Auditoría de Stock" — a pedido del usuario, caso real: "el inventario
   * de casco wendy en shopify es 9 y en ML es 10, algo pasó, revisalo y
   * corrige". Para poder MOSTRAR la comparación antes de corregir nada,
   * hace falta poder leer el stock real de Shopify de UNA variante puntual
   * en vivo (hasta ahora `ShopifyClient` solo sabía escribirlo —
   * `setVariantInventoryQuantity` arriba). Reusa a propósito el mismo campo
   * `inventoryQuantity` que ya usa el importador de Fase 1 para traer el
   * catálogo completo (`products.ts`, `fetchAllShopifyProducts`) — ya
   * confirmado en vivo contra esta cuenta — en vez de una consulta nueva de
   * `inventoryLevels`/`quantities` sin probar.
   */
  async getVariantInventoryQuantity(variantGid: string): Promise<number | null> {
    const result = await this.graphql<{
      productVariant: { inventoryQuantity: number | null } | null;
    }>(
      `query VariantInventoryQuantity($id: ID!) {
        productVariant(id: $id) {
          inventoryQuantity
        }
      }`,
      { id: variantGid },
    );
    return result.data.productVariant?.inventoryQuantity ?? null;
  }

  /**
   * Fase 2a: fija el stock disponible de una variante al valor absoluto
   * indicado (no calcula deltas — `inventorySetQuantities` es idempotente).
   * Primero resuelve el `inventoryItem.id` y la ubicación vigente de la
   * variante, porque la mutación de inventario los necesita explícitos.
   */
  async setVariantInventoryQuantity(variantGid: string, quantity: number): Promise<void> {
    const lookup = await this.graphql<{
      productVariant: {
        inventoryItem: {
          id: string;
          inventoryLevels: { nodes: { location: { id: string } }[] };
        } | null;
      } | null;
    }>(
      `query VariantInventoryItem($id: ID!) {
        productVariant(id: $id) {
          inventoryItem {
            id
            inventoryLevels(first: 1) {
              nodes { location { id } }
            }
          }
        }
      }`,
      { id: variantGid },
    );

    const inventoryItem = lookup.data.productVariant?.inventoryItem;
    const locationId = inventoryItem?.inventoryLevels.nodes[0]?.location.id;
    if (!inventoryItem || !locationId) {
      throw new ShopifyApiError(
        `No se encontró inventoryItem/ubicación para la variante ${variantGid} en Shopify — ` +
          "revisa que la variante tenga seguimiento de inventario activado.",
      );
    }

    const result = await this.graphql<{
      inventorySetQuantities: {
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation SetQuantity($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: [{ inventoryItemId: inventoryItem.id, locationId, quantity }],
        },
      },
    );

    const errors = result.data.inventorySetQuantities.userErrors;
    if (errors.length > 0) {
      throw new ShopifyApiError(`Shopify rechazó la actualización de stock: ${JSON.stringify(errors)}`, errors);
    }
  }

  /**
   * Fase 2b: URLs de imágenes de un producto, pedidas al vuelo en el
   * momento de publicar en Mercado Libre. `ProductImage` existe en el
   * esquema central pero el importador de Fase 1 nunca lo llena — en vez de
   * hacer ese backfill para las 304+ variantes existentes, se resuelve
   * directo contra Shopify usando el `channelProductId` que ya está
   * guardado en `ChannelProductMap` desde la importación.
   */
  async getProductImages(productGid: string): Promise<string[]> {
    const result = await this.graphql<{
      product: { images: { nodes: { url: string }[] } } | null;
    }>(
      `query ProductImages($id: ID!) {
        product(id: $id) {
          images(first: 10) { nodes { url } }
        }
      }`,
      { id: productGid },
    );
    return result.data.product?.images.nodes.map((n) => n.url) ?? [];
  }

  /**
   * Fase 2b: descripción del producto para copiarla también a la
   * publicación de Mercado Libre. Se trae `descriptionHtml` (el HTML
   * completo, con tablas/íconos/formato) en vez del campo `description` de
   * Shopify (texto plano ya recortado por Shopify) — probando contra
   * cuentas reales, ese recorte automático de Shopify puede dejar el texto
   * casi vacío cuando la descripción es mayormente tablas/imágenes, así que
   * el HTML completo se adapta a mano al formato de Mercado Libre en
   * `@blacksand/core-domain` (`convertShopifyDescriptionForMeli`), que sí
   * conserva el contenido de tablas como texto en vez de perderlo.
   */
  async getProductDescriptionHtml(productGid: string): Promise<string | null> {
    const result = await this.graphql<{
      product: { descriptionHtml: string } | null;
    }>(
      `query ProductDescriptionHtml($id: ID!) {
        product(id: $id) {
          descriptionHtml
        }
      }`,
      { id: productGid },
    );
    const html = result.data.product?.descriptionHtml?.trim();
    return html ? html : null;
  }

  /**
   * Fase 2b: peso real de la variante (para sincronizarlo como
   * `seller_package_weight` en Mercado Libre en vez de un valor fijo por
   * grupo). El "tipo de Embalaje" nativo de la pestaña Envío de Shopify
   * (con sus propias medidas de largo/ancho/alto) NO está disponible por
   * ninguna API pública de Shopify — confirmado por el propio staff de
   * Shopify en su foro de desarrolladores — pero el peso sí, vía
   * `InventoryItem.measurement.weight`.
   */
  async getVariantWeightGrams(variantGid: string): Promise<number | null> {
    const result = await this.graphql<{
      productVariant: {
        inventoryItem: { measurement: { weight: { value: number; unit: string } | null } } | null;
      } | null;
    }>(
      `query VariantWeight($id: ID!) {
        productVariant(id: $id) {
          inventoryItem {
            measurement {
              weight { value unit }
            }
          }
        }
      }`,
      { id: variantGid },
    );
    const weight = result.data.productVariant?.inventoryItem?.measurement.weight;
    if (!weight || weight.value <= 0) return null;

    switch (weight.unit) {
      case "GRAMS":
        return weight.value;
      case "KILOGRAMS":
        return weight.value * 1000;
      case "POUNDS":
        return weight.value * 453.592;
      case "OUNCES":
        return weight.value * 28.3495;
      default:
        return weight.value;
    }
  }

  /**
   * Fase 2b: largo/ancho/alto del paquete, cargados por el usuario como
   * metacampos del PRODUCTO (no de la variante — el embalaje suele ser el
   * mismo para todas las variantes de un mismo producto) — a diferencia
   * del selector nativo de "Embalaje" de la pestaña Envío (no accesible
   * por API, ver `getVariantWeightGrams`), un metacampo sí se puede leer
   * por GraphQL.
   *
   * NO se asume un namespace/key exacto: cuando Shopify crea una
   * definición de metacampo sin que el usuario escriba un namespace a
   * mano, suele asignar uno propio (típicamente "custom") en vez del que
   * uno esperaría, y probando contra la cuenta real los valores no
   * aparecían con el namespace/key fijo que se había asumido al
   * principio ("embalaje.largo_cm" exacto). Para no depender de acertarle
   * a esos dos datos, se traen TODOS los metacampos del producto y se
   * busca por el NOMBRE del campo (`key`, sin importar el namespace)
   * conteniendo "largo"/"ancho"/"alto" — funciona sea cual sea el
   * namespace real que haya quedado asignado.
   */
  async getPackageDimensionsCm(
    productGid: string,
  ): Promise<{ lengthCm: number | null; widthCm: number | null; heightCm: number | null }> {
    const result = await this.graphql<{
      product: { metafields: { nodes: { namespace: string; key: string; value: string }[] } } | null;
    }>(
      `query PackageDimensions($id: ID!) {
        product(id: $id) {
          metafields(first: 50) {
            nodes { namespace key value }
          }
        }
      }`,
      { id: productGid },
    );
    const nodes = result.data.product?.metafields.nodes ?? [];

    const findByKeyword = (keyword: string): string | undefined =>
      nodes.find((n) => n.key.toLowerCase().includes(keyword))?.value;

    // El valor puede venir como "20", "20.5", "20,5" (coma decimal, común
    // en Chile) o con la unidad pegada ("20 cm") si el campo se definió
    // como texto en vez de número — se toma el primer número que aparezca.
    const toNumber = (raw: string | undefined): number | null => {
      if (!raw) return null;
      const match = raw.replace(",", ".").match(/-?\d+(\.\d+)?/);
      if (!match) return null;
      const n = Number(match[0]);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    return {
      lengthCm: toNumber(findByKeyword("largo")),
      widthCm: toNumber(findByKeyword("ancho")),
      heightCm: toNumber(findByKeyword("alto")),
    };
  }

  /**
   * "Crear producto" (a pedido del usuario: subir productos nuevos desde la
   * app, que se publiquen solos en Shopify y Mercado Libre) — SKU único, sin
   * variantes de color/talla (ver la decisión del usuario). `productCreate`
   * sin `variants` en el input crea el producto con UNA variante "default"
   * automática (sin opciones propias); el precio/SKU/código de barras se
   * completan después con `updateVariantPriceAndSku` (mismo método que ya
   * usa Fase 2a) y el stock con `setVariantInventoryQuantity` (ya existe) —
   * evita duplicar esa lógica acá.
   *
   * SIN PROBAR EN VIVO todavía. Dos supuestos a verificar contra la cuenta
   * real: (a) que `productCreate` sin `variants` siga devolviendo una
   * variante default automática en esta versión de la API (el input
   * `ProductInput.variants` se sacó de la Admin API en 2024-04 — se asume
   * que el comportamiento de "una variante default" que la reemplazó sigue
   * vigente); (b) que esa variante default ya venga con inventario
   * rastreado y conectado a la ubicación principal (si no, `setVariantInventoryQuantity`
   * puede fallar por no encontrar `inventoryLevels` — `createProductAndPublish`,
   * en @blacksand/sync-engine, no aborta toda la creación si solo falla el
   * stock, lo deja como advertencia para revisar a mano en Shopify).
   */
  async createProduct(input: {
    title: string;
    descriptionHtml?: string | null;
    vendor?: string | null;
    productType?: string | null;
  }): Promise<{ productGid: string; defaultVariantGid: string }> {
    const result = await this.graphql<{
      productCreate: {
        product: { id: string; variants: { nodes: { id: string }[] } } | null;
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title: input.title,
          descriptionHtml: input.descriptionHtml ?? undefined,
          vendor: input.vendor ?? undefined,
          productType: input.productType ?? undefined,
          status: "ACTIVE",
        },
      },
    );

    const errors = result.data.productCreate.userErrors;
    if (errors.length > 0) {
      throw new ShopifyApiError(`Shopify rechazó la creación del producto: ${JSON.stringify(errors)}`, errors);
    }
    const product = result.data.productCreate.product;
    const defaultVariantGid = product?.variants.nodes[0]?.id;
    if (!product || !defaultVariantGid) {
      throw new ShopifyApiError("Shopify creó el producto pero no devolvió la variante por defecto.");
    }
    return { productGid: product.id, defaultVariantGid };
  }

  /**
   * Sube UNA imagen local (bytes ya leídos por el llamador — el conector no
   * toca el disco, mismo criterio de separación que el resto del paquete) y
   * la deja adjunta al producto. Flujo estándar de "staged upload" de la
   * Admin API (subir bytes propios en vez de referenciar una URL ya
   * pública, que es lo único que hace `pictures`/`media` de Mercado Libre):
   * 1. `stagedUploadsCreate` pide una URL temporaria + parámetros de forma.
   * 2. POST multipart directo a esa URL (no es la API de Shopify — es
   *    almacenamiento temporal, por eso no lleva el header de autenticación
   *    de Shopify).
   * 3. `productCreateMedia` adjunta ese archivo ya subido al producto,
   *    referenciándolo por la URL de recurso que devolvió el paso 1.
   * SIN PROBAR EN VIVO todavía — mismo criterio que el resto de Fase 2b: se
   * ajusta contra la respuesta real si esta cuenta se comporta distinto.
   */
  async uploadProductImage(
    productGid: string,
    file: { filename: string; mimeType: string; data: Uint8Array },
  ): Promise<void> {
    const staged = await this.graphql<{
      stagedUploadsCreate: {
        stagedTargets: {
          url: string;
          resourceUrl: string;
          parameters: { name: string; value: string }[];
        }[];
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
      {
        input: [
          {
            resource: "IMAGE",
            filename: file.filename,
            mimeType: file.mimeType,
            httpMethod: "POST",
          },
        ],
      },
    );

    const stagedErrors = staged.data.stagedUploadsCreate.userErrors;
    if (stagedErrors.length > 0) {
      throw new ShopifyApiError(
        `Shopify rechazó el pedido de subida de imagen: ${JSON.stringify(stagedErrors)}`,
        stagedErrors,
      );
    }
    const target = staged.data.stagedUploadsCreate.stagedTargets[0];
    if (!target) {
      throw new ShopifyApiError("Shopify no devolvió un destino de subida para la imagen.");
    }

    const form = new FormData();
    for (const param of target.parameters) {
      form.append(param.name, param.value);
    }
    // El campo del archivo en sí va al final, con el nombre "file" (así lo
    // documenta Shopify para stagedUploadsCreate) — el `Blob` necesita el
    // `mimeType` para que el almacenamiento temporal lo acepte como imagen.
    form.append("file", new Blob([file.data], { type: file.mimeType }), file.filename);

    let uploadResponse: Response;
    try {
      uploadResponse = await fetch(target.url, { method: "POST", body: form });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause) : String(err);
      throw new ShopifyApiError(`No se pudo subir la imagen "${file.filename}" al almacenamiento de Shopify: ${cause}`);
    }
    if (!uploadResponse.ok) {
      const body = await uploadResponse.text().catch(() => "");
      throw new ShopifyApiError(`La subida de "${file.filename}" falló (${uploadResponse.status}): ${body}`);
    }

    const attach = await this.graphql<{
      productCreateMedia: {
        media: { id: string }[];
        mediaUserErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation AttachMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id }
          mediaUserErrors { field message }
        }
      }`,
      {
        productId: productGid,
        media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE" }],
      },
    );

    const attachErrors = attach.data.productCreateMedia.mediaUserErrors;
    if (attachErrors.length > 0) {
      throw new ShopifyApiError(
        `Shopify subió "${file.filename}" pero no la pudo adjuntar al producto: ${JSON.stringify(attachErrors)}`,
        attachErrors,
      );
    }
  }
}
