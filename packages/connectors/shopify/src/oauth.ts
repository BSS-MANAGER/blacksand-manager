import type { ShopifyConnectionConfig } from "./types.js";

export interface ShopifyTokenSet {
  accessToken: string;
  expiresAt: string; // ISO
}

export class ShopifyOAuthError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyOAuthError";
  }
}

type ClientCredentialsConfig = Pick<ShopifyConnectionConfig, "shopDomain" | "clientId" | "clientSecret">;

/**
 * Limpia errores comunes de copiar/pegar el dominio (protocolo, slash final,
 * espacios) — la causa más frecuente de "fetch failed" con DNS ENOTFOUND.
 */
export function normalizeShopDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Intercambia client_id + client_secret por un Admin API access token
 * (Client Credentials Grant). Reemplaza al viejo modelo de token estático
 * para apps admin-created en la misma organización — ver
 * https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant.
 * El token dura 24h (`expires_in` ~86399s) y debe renovarse antes de vencer.
 */
export async function requestShopifyAccessToken(config: ClientCredentialsConfig): Promise<ShopifyTokenSet> {
  const domain = normalizeShopDomain(config.shopDomain);
  let response: Response;
  try {
    response = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
  } catch (err) {
    // fetch() de Node lanza un TypeError genérico "fetch failed" sin detalle;
    // la causa real (DNS, TLS, dominio mal escrito, sin internet) viaja en
    // `cause`. La incluimos en el mensaje porque Electron IPC solo propaga
    // `.message` del error al renderer, no propiedades adicionales.
    const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause) : String(err);
    throw new ShopifyOAuthError(
      `No se pudo conectar con https://${domain} — revisa que el dominio esté bien escrito ` +
        `(solo "tu-tienda.myshopify.com", sin "https://" ni "/" al final) y tu conexión a internet. Detalle: ${cause}`,
    );
  }
  if (!response.ok) {
    const body = await safeJson(response);
    // Igual que con "fetch failed": Electron IPC solo propaga `.message` al
    // renderer, así que el detalle de Shopify va incrustado ahí, no solo en
    // `details` (que se pierde al cruzar el puente IPC).
    throw new ShopifyOAuthError(
      `Error al obtener el access token (HTTP ${response.status}): ${JSON.stringify(body)}`,
      body,
    );
  }
  const json = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  return { accessToken: json.access_token, expiresAt };
}

/** Devuelve un token vigente, renovando automáticamente si está por expirar (margen de 5 min). */
export async function ensureFreshShopifyToken(
  config: ClientCredentialsConfig,
  current: ShopifyTokenSet,
): Promise<ShopifyTokenSet> {
  const expiresAtMs = new Date(current.expiresAt).getTime();
  const marginMs = 5 * 60 * 1000;
  if (Date.now() < expiresAtMs - marginMs) {
    return current;
  }
  return requestShopifyAccessToken(config);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
