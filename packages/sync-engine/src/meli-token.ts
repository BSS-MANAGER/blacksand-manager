import {
  insertLiveTokenIfMissing,
  readLiveToken,
  refreshLiveTokenLocked,
  upsertLiveToken,
  type LiveTokenRow,
} from "@blacksand/db";
import { refreshMeliToken, type MeliAppConfig, type MeliTokenSet } from "@blacksand/connector-mercadolibre";

/**
 * Token de Mercado Libre COMPARTIDO entre la app de escritorio y el worker en
 * la nube (ver `channel-live-token.repository.ts` en @blacksand/db para el
 * porqué: el refresh_token es de un solo uso, hay que refrescar con la fila
 * bloqueada para que dos procesos nunca gasten el mismo).
 *
 * El access_token dura 6 h (fijo). Se renueva cuando faltan menos de 30 min,
 * igual que `ensureFreshMeliToken`: así un sondeo cada 5-15 min lo renueva
 * con bastante holgura antes de que venza.
 */
const CHANNEL_CODE = "mercadolibre";
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

function rowToTokenSet(row: LiveTokenRow): MeliTokenSet {
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    userId: Number(row.userId ?? 0),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function tokenSetToRow(set: MeliTokenSet): LiveTokenRow {
  return {
    channelCode: CHANNEL_CODE,
    accessToken: set.accessToken,
    refreshToken: set.refreshToken,
    userId: set.userId ? String(set.userId) : null,
    expiresAt: new Date(set.expiresAt),
  };
}

/** ¿Hay ya un token de Mercado Libre en la base compartida? */
export async function hasLiveMeliToken(): Promise<boolean> {
  return (await readLiveToken(CHANNEL_CODE)) !== null;
}

/**
 * Pasa a la base compartida el token que la app ya tenía en su bóveda local
 * (solo la primera vez). Nunca pisa un token que ya esté en la base.
 */
export async function seedLiveMeliTokenIfMissing(tokenSet: MeliTokenSet): Promise<boolean> {
  return insertLiveTokenIfMissing(tokenSetToRow(tokenSet));
}

/** Guarda un token recién obtenido (al conectar/reconectar la cuenta por OAuth): pisa el anterior. */
export async function saveLiveMeliToken(tokenSet: MeliTokenSet): Promise<void> {
  await upsertLiveToken(tokenSetToRow(tokenSet));
}

/**
 * Devuelve un token vigente, refrescándolo (con la fila bloqueada) si está por
 * vencer. `null` = todavía no hay ningún token guardado en la base compartida.
 */
export async function getFreshMeliTokenSet(config: MeliAppConfig): Promise<MeliTokenSet | null> {
  const current = await readLiveToken(CHANNEL_CODE);
  if (!current) return null;
  if (current.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return rowToTokenSet(current);

  const refreshed = await refreshLiveTokenLocked(
    CHANNEL_CODE,
    // Con la fila ya bloqueada y releída: si otro proceso se adelantó y el token ya está fresco, no se vuelve a refrescar.
    (row) => row.expiresAt.getTime() - Date.now() <= REFRESH_MARGIN_MS,
    async (row) => tokenSetToRow(await refreshMeliToken(config, row.refreshToken)),
  );
  return refreshed ? rowToTokenSet(refreshed) : null;
}

/**
 * Para cuando Mercado Libre respondió 401 con `failedAccessToken`: refresca
 * (con la fila bloqueada) SOLO si ese sigue siendo el token guardado. Si otro
 * proceso ya lo renovó, devuelve el token nuevo sin gastar el refresh_token.
 */
export async function refreshMeliAccessTokenAfterUnauthorized(
  config: MeliAppConfig,
  failedAccessToken: string,
): Promise<string | undefined> {
  const refreshed = await refreshLiveTokenLocked(
    CHANNEL_CODE,
    (row) => row.accessToken === failedAccessToken,
    async (row) => tokenSetToRow(await refreshMeliToken(config, row.refreshToken)),
  );
  return refreshed?.accessToken;
}
