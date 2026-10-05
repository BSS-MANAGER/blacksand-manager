import type { MeliAppConfig, MeliTokenSet } from "./types.js";

const AUTH_BASE = "https://auth.mercadolibre.cl"; // sitio MLC (B.2)
const API_BASE = "https://api.mercadolibre.com";

export class MeliOAuthError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MeliOAuthError";
  }
}

/** Construye la URL de autorización (Authorization Code) que el usuario debe abrir. */
export function buildMeliAuthorizationUrl(config: MeliAppConfig, state: string): string {
  const url = new URL(`${AUTH_BASE}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token?: string;
}

function toTokenSet(json: TokenResponse, previousRefreshToken?: string): MeliTokenSet {
  const refreshToken = json.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    // Sin refresh_token la conexión duraría solo 6 horas y la sincronización 24/7 no podría renovarla.
    throw new MeliOAuthError(
      `Mercado Libre no entregó el "refresh_token" (permisos recibidos: ${json.scope || "ninguno informado"}). ` +
        `Revisa en DevCenter que la aplicación tenga activado el permiso "offline_access" (acceso sin conexión), guarda y vuelve a conectar la cuenta.`,
    );
  }
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  return {
    accessToken: json.access_token,
    refreshToken,
    userId: json.user_id,
    expiresAt,
  };
}

/** Intercambia el `code` recibido en el callback OAuth por el primer access/refresh token. */
export async function exchangeMeliAuthorizationCode(
  config: MeliAppConfig,
  code: string,
): Promise<MeliTokenSet> {
  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!response.ok) {
    const details = await safeJson(response);
    // Solo `.message` cruza el puente de IPC hacia el renderer (mismo
    // criterio que el resto de la app) — el detalle real de Mercado Libre
    // (p. ej. "invalid_grant") se incrusta acá para que sea visible en la
    // pantalla, no solo en la consola del proceso principal.
    throw new MeliOAuthError(`Error al intercambiar code (${response.status}): ${describeMeliError(details)}`, details);
  }
  return toTokenSet((await response.json()) as TokenResponse);
}

/** Refresca el access_token usando el refresh_token — se debe automatizar antes de cada expiración (D.5). */
export async function refreshMeliToken(config: MeliAppConfig, refreshToken: string): Promise<MeliTokenSet> {
  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    // Tope de espera: este refresco puede correr con una fila de la base bloqueada (ver `refreshLiveTokenLocked`), no puede colgarse para siempre.
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const details = await safeJson(response);
    throw new MeliOAuthError(`Error al refrescar token (${response.status}): ${describeMeliError(details)}`, details);
  }
  return toTokenSet((await response.json()) as TokenResponse, refreshToken);
}

/**
 * Mercado Libre devuelve el detalle real del rechazo en el cuerpo JSON
 * (p. ej. `{ error: "invalid_grant", message: "..." }` cuando el
 * refresh_token ya fue usado — son de un solo uso y rotan en cada refresco,
 * ver `ensureFreshMeliToken`). Sin esto, solo se veía el código HTTP.
 */
function describeMeliError(details: unknown): string {
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const parts = [d.error, d.message ?? d.error_description].filter(Boolean);
    if (parts.length > 0) return parts.join(" — ");
  }
  return "sin detalle en la respuesta";
}

/**
 * Se llama a esto desde varios lugares casi al mismo tiempo: el sondeo
 * automático de pedidos cada 5 minutos (`startPollingScheduler`) y
 * cualquier acción manual en la UI (incluida "Publicar en ML"), todos vía
 * `buildChannelClients()`. Mercado Libre rota el `refresh_token` en cada
 * uso (es de un solo uso) — si dos refrescos casi simultáneos usan el
 * MISMO `refresh_token` guardado, el segundo llega tarde y Mercado Libre
 * lo rechaza porque el primero ya lo gastó. Esta promesa compartida evita
 * esa carrera: mientras hay un refresco en curso, cualquier otro llamador
 * espera el mismo resultado en vez de disparar una segunda llamada HTTP
 * con un `refresh_token` que ya va a estar gastado para cuando le toque
 * su turno en el hilo de JS.
 */
let inFlightRefresh: Promise<MeliTokenSet> | null = null;

/**
 * Refresca YA, sin mirar la fecha de expiración (para cuando Mercado Libre
 * respondió 401 aunque el token "debería" seguir vigente). Comparte la misma
 * promesa en vuelo que `ensureFreshMeliToken`, así que dos llamadas casi
 * simultáneas nunca gastan el mismo refresh_token dos veces.
 */
export function forceRefreshMeliToken(config: MeliAppConfig, current: MeliTokenSet): Promise<MeliTokenSet> {
  if (!inFlightRefresh) {
    inFlightRefresh = refreshMeliToken(config, current.refreshToken).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

/**
 * Devuelve un token vigente, refrescando automáticamente si está por expirar.
 *
 * El access_token dura 6 h (fijo, no se puede alargar). El margen es de 30
 * min — antes 5 — para que el sondeo automático (que corre cada 5 min y pasa
 * por acá) lo renueve con bastante holgura ANTES de que venza, en vez de
 * rozar el límite; si el sondeo se atrasa o falla un par de veces, el token
 * igual sigue vigente. Si de todas formas vence (PC dormido, sin internet),
 * el cliente lo renueva solo al recibir un 401 (ver `MercadoLibreClient`).
 */
export async function ensureFreshMeliToken(
  config: MeliAppConfig,
  current: MeliTokenSet,
): Promise<MeliTokenSet> {
  const expiresAtMs = new Date(current.expiresAt).getTime();
  const marginMs = 30 * 60 * 1000;
  if (Date.now() < expiresAtMs - marginMs) {
    return current;
  }
  return forceRefreshMeliToken(config, current);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
