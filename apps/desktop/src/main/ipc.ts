import { ipcMain, shell, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  getDb,
  listDashboardSyncStatus,
  listProductsWithSyncStatus,
  listPendingReconciliation,
  listAuditLog,
  listRecentOrders,
  recordAudit,
  deleteProduct,
  readWorkerHeartbeat,
} from "@blacksand/db";
import {
  applyReconciliationDecision,
  importShopifyCatalog,
  importMercadoLibreCatalog,
  pushVariantToChannels,
  pollAllChannelOrders,
  listPendingCancellations,
  resolveOrderCancellation,
  backfillOrderNumbers,
  retryOrderSync,
  registerPosSale,
  listPublishCandidateGroups,
  previewCategoryForGroup,
  confirmGroupMapping,
  publishBatch,
  syncMeliDescriptions,
  listMeliKeywordOverrides,
  saveMeliKeywordOverride,
  deleteMeliKeywordOverride,
  searchMeliCategories,
  previewAllPendingCategories,
  listMeliListingIssues,
  reactivateMeliListing,
  closeMeliListing,
  previewMeliDuplicates,
  closeMeliDuplicates,
  previewMeliBrandFix,
  fixMeliBrandBySkuPrefix,
  previewMeliSkuFix,
  fixMeliSkuMismatches,
  previewStockAudit,
  applyStockAuditCorrection,
  previewBulkDiscountProducts,
  applyBulkDiscount,
  listDiscountBatches,
  listPriceBaselines,
  revertDiscountBatch,
  listMeliSkuPrefixBrandOverrides,
  saveMeliSkuPrefixBrandOverride,
  deleteMeliSkuPrefixBrandOverride,
  createProductAndPublish,
  getFreshMeliTokenSet,
  refreshMeliAccessTokenAfterUnauthorized,
  saveLiveMeliToken,
  seedLiveMeliTokenIfMissing,
  withOrderPollLease,
  type PushChannelClients,
  type CategoryPreview,
} from "@blacksand/sync-engine";
import { getCredentialVault, newCredentialRef, type CredentialVault } from "@blacksand/credentials";
import { ShopifyClient } from "@blacksand/connector-shopify";
import {
  MercadoLibreClient,
  buildMeliAuthorizationUrl,
  exchangeMeliAuthorizationCode,
  type MeliAppConfig,
  type MeliTokenSet,
} from "@blacksand/connector-mercadolibre";
import { readAppConfig, updateAppConfig } from "./config-store.js";
import { registerShippingHandlers } from "./shipping-gmail.js";
import { IPC_CHANNELS } from "../shared-ipc-types.js";
import type {
  BackfillOrderNumbersResult,
  RetryOrderSyncResult,
  ChannelStatusRow,
  CreateProductInput,
  CreateProductResult,
  DashboardRow,
  MercadoLibreConfigInput,
  MeliCategoryPreviewResult,
  MeliConfirmGroupMappingInput,
  MeliDescriptionSyncResult,
  MeliListingTypeRow,
  MeliPublishBatchResult,
  MeliPublishGroupRow,
  MeliKeywordOverrideRow,
  MeliCategorySearchResultRow,
  MeliBulkCategoryPreviewRow,
  MeliListingIssueRow,
  MeliListingReactivateResult,
  MeliListingCloseResult,
  MeliDuplicateGroup,
  MeliDuplicateCloseOutcome,
  MeliBrandFixPreviewRow,
  MeliBrandFixRunResult,
  MeliSkuFixPreviewRow,
  MeliSkuFixItemInput,
  MeliSkuFixRunResult,
  MeliSkuPrefixBrandOverrideRow,
  StockAuditRow,
  StockAuditApplyResult,
  DiscountPreviewProduct,
  DiscountApplyInput,
  DiscountApplyResult,
  DiscountBatchRow,
  DiscountBaselineRow,
  DiscountRevertResult,
  MeliPromotionsProbeResult,
  CloudWorkerStatus,
  OrderIngestSummaryRow,
  PendingCancellationRow,
  PosSaleInput,
  PosSaleResult,
  ProductRow,
  ProductUpdateInput,
  ProductUpdateResult,
  ProductDeleteResult,
  ReconciliationRow,
  RecentOrderRow,
  ShopifyConfigInput,
} from "../shared-ipc-types.js";

/** Fase 3a: ventana MÍNIMA de sondeo de pedidos — la idempotencia por channelOrderId hace que re-revisar pedidos ya vistos sea barato. Ya NO es la única ventana usada (ver `computeOrderPollLookbackHours` abajo): esto sola dejaba pedidos sin procesar para siempre si la app estaba cerrada más de este tiempo (bug real: pedido #1151, ver comentario grande abajo). */
const ORDER_POLL_LOOKBACK_HOURS = Number(process.env.ORDER_POLL_LOOKBACK_HOURS ?? 24);

/** Techo de seguridad para el catch-up automático (30 días) — evita una consulta desmedida si el checkpoint quedara corrupto o muy viejo. El catch-up MANUAL (input del usuario en el Dashboard) no está limitado por esto. */
const ORDER_POLL_MAX_AUTO_LOOKBACK_HOURS = 24 * 30;

/** Primera corrida después de instalar este arreglo (todavía no hay `lastPollAt` guardado): mira 7 días atrás en vez de solo 24h, para recuperar solo automáticamente pedidos recientes que se hayan perdido con el bug viejo — como el caso real que lo motivó. */
const ORDER_POLL_FIRST_RUN_LOOKBACK_HOURS = 24 * 7;

/**
 * Bug real reportado por el usuario: "no se está realizando la actualización
 * de stock conforme a las ventas que se están realizando por shopify... el
 * pedido #1151 (SKU em745mc) no se descontó en ML". Causa: el sondeo de
 * pedidos (automático cada pocos minutos, y el botón manual "Revisar
 * pedidos ahora") SIEMPRE consultaba una ventana fija "ahora menos
 * `ORDER_POLL_LOOKBACK_HOURS` (24h por defecto)", sin memoria de cuándo fue
 * la última corrida. Si la app estuvo cerrada más de 24h (dejar el PC
 * apagado toda una noche larga, o un fin de semana), cualquier pedido que
 * haya llegado en ese hueco queda FUERA de esa ventana — y como la ventana
 * siempre es "ahora - 24h", NUNCA vuelve a cubrir ese momento en el futuro.
 * El pedido simplemente no se procesa: sin error, sin registro en
 * Auditoría, sin ningún aviso en la app.
 *
 * El arreglo: guardar en `config.json` (`orderPolling.lastPollAt`, ver
 * `config-store.ts`) cuándo terminó la última corrida, y usar esa fecha
 * como punto de partida de la siguiente en vez de la ventana fija — así
 * ningún hueco pierde pedidos en silencio, sin importar cuánto haya estado
 * cerrada la app. `ORDER_POLL_LOOKBACK_HOURS` pasa a ser solo un PISO (para
 * que corridas muy seguidas igual miren un mínimo razonable hacia atrás, por
 * las dudas). Si todavía no hay checkpoint guardado (primera corrida después
 * de instalar este arreglo), se usa un catch-up de 7 días para recuperar
 * solo automáticamente pedidos recientes ya perdidos por el bug viejo.
 *
 * `customLookbackHours` (opcional): override explícito del usuario desde el
 * Dashboard ("revisar pedidos de los últimos N días") para casos como el
 * #1151, si resulta ser más viejo que la ventana automática de 7 días.
 */
export function computeOrderPollLookbackHours(customLookbackHours?: number): number {
  if (customLookbackHours !== undefined && customLookbackHours > 0) {
    return customLookbackHours;
  }

  const config = readAppConfig();
  const lastPollAt = config.orderPolling?.lastPollAt;
  if (!lastPollAt) return ORDER_POLL_FIRST_RUN_LOOKBACK_HOURS;

  const hoursSinceLastPoll = (Date.now() - new Date(lastPollAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hoursSinceLastPoll) || hoursSinceLastPoll <= 0) {
    return ORDER_POLL_LOOKBACK_HOURS;
  }
  return Math.min(Math.max(hoursSinceLastPoll, ORDER_POLL_LOOKBACK_HOURS), ORDER_POLL_MAX_AUTO_LOOKBACK_HOURS);
}

/** Se llama después de cada sondeo (automático o manual) para dejar registrado hasta cuándo se revisó — ver `computeOrderPollLookbackHours`. */
export function recordOrderPollCheckpoint(): void {
  updateAppConfig({ orderPolling: { lastPollAt: new Date().toISOString() } });
}

/**
 * Fase 2a: construye los clientes de canal ya autenticados a partir de la
 * configuración/bóveda locales — mismo patrón que ya usa
 * `sync:runImportNow`, reutilizado aquí para el push de ediciones manuales
 * y (Fase 3) para el sondeo de pedidos y la venta presencial. Exportada
 * para que el scheduler de `main/index.ts` la reuse también.
 *
 * Fase 3: a diferencia de Shopify (que renueva su propio token internamente
 * en `ShopifyClient`), el token de Mercado Libre nunca se refrescaba desde
 * la app — sin esto, el sondeo automático se habría quedado sin conexión
 * ~6h después de conectar Mercado Libre sin que el usuario lo notara.
 */
/**
 * `buildChannelClients()` se llama desde muchos lugares casi al mismo
 * tiempo — el sondeo de pedidos cada 5 min, la sincronización de
 * descripciones cada 30 min (+ una vez al abrir la app), y cualquier acción
 * manual de la UI. El `inFlightRefresh` de `ensureFreshMeliToken` (en
 * `oauth.ts`) evita que dos refrescos con el MISMO `refresh_token` en
 * memoria choquen, pero acá había una ventana más amplia: cada llamada a
 * `buildChannelClients()` LEE el token guardado del vault por su cuenta, lo
 * refresca si hace falta, y recién AL FINAL lo vuelve a guardar. Si una
 * segunda llamada leía el vault en el hueco entre que la primera terminó de
 * refrescar y alcanzó a guardar el nuevo token, la segunda partía con un
 * `refresh_token` que Mercado Libre ya había rotado (son de un solo uso) y
 * fallaba con "unsupported_grant_type"/"invalid_grant" — el mismo síntoma
 * de antes, pero por esta ventana más amplia, no por la carrera que ya
 * arregla `ensureFreshMeliToken`. Acá se envuelve el ciclo completo
 * (leer → refrescar → guardar) en una única promesa compartida para que
 * TODOS los llamadores esperen el mismo resultado en vez de repetirlo.
 */
let inFlightMeliClientBuild: Promise<MercadoLibreClient | undefined> | null = null;

/**
 * Bug real reportado por el usuario: tenía que reconectar Mercado Libre 2-3
 * veces al día. Causa encontrada en `main/index.ts`: `window-all-closed`
 * llamaba a `app.quit()` de inmediato, sin esperar ningún trabajo async en
 * curso. Si el usuario cerraba la ventana justo mientras `buildMeliClient`
 * tenía un refresco de token en vuelo — Mercado Libre YA le había entregado
 * el refresh_token nuevo (y rotado/invalidado el viejo, son de un solo
 * uso) pero el proceso todavía no alcanzaba a guardarlo en la bóveda (ver
 * el `await vault.set(...)` de abajo) — Electron mataba el proceso a mitad
 * de camino. La bóveda se quedaba con el refresh_token VIEJO, que Mercado
 * Libre ya había invalidado del todo: la próxima vez que la app intentaba
 * refrescar, el rechazo era definitivo y forzaba reconectar a mano.
 *
 * Esta función deja que `main/index.ts` espere ese guardado antes de cerrar
 * la app de verdad, en vez de interrumpirlo.
 */
export function getPendingMeliClientBuild(): Promise<unknown> | null {
  const pending = [inFlightMeliClientBuild, inFlightMeliForcedRefresh].filter(
    (p): p is Promise<MercadoLibreClient | undefined> | Promise<string | undefined> => p !== null,
  );
  return pending.length > 0 ? Promise.allSettled(pending) : null;
}

/** Refresco forzado por un 401 en curso (ver `refreshMeliAfterUnauthorized`). */
let inFlightMeliForcedRefresh: Promise<string | undefined> | null = null;

/**
 * Sincronización 24/7: el token de Mercado Libre YA NO vive solo en la bóveda
 * de este PC — la única copia válida está en la base de datos compartida
 * (tabla `ChannelLiveToken`), porque el worker en la nube también necesita un
 * token vigente y el refresh_token de Mercado Libre es de un solo uso (si cada
 * proceso refrescara con su propia copia, el segundo fallaría con
 * `invalid_grant` y habría que reconectar a mano). Todo refresco se hace en
 * `@blacksand/sync-engine` (`meli-token.ts`) con la fila bloqueada. La bóveda
 * local conserva el `clientSecret` (fijo) y, de respaldo, una copia del último
 * token (ver `mirrorMeliTokenToVault`).
 */
async function loadMeliAppConfig(
  config: ReturnType<typeof readAppConfig>,
  vault: CredentialVault,
): Promise<MeliAppConfig | undefined> {
  const mercadolibre = config.mercadolibre;
  if (!mercadolibre?.tokenRef) return undefined;
  const clientSecret = await vault.get(mercadolibre.clientSecretRef);
  if (!clientSecret) return undefined;
  return { clientId: mercadolibre.clientId, clientSecret, redirectUri: mercadolibre.redirectUri, siteId: "MLC" };
}

let lastMirroredMeliAccessToken: string | null = null;

/**
 * Copia de respaldo (best-effort) del último token en la bóveda local. Ya no
 * es la fuente de verdad: si falla, no pasa nada — la base compartida manda.
 */
async function mirrorMeliTokenToVault(
  config: ReturnType<typeof readAppConfig>,
  vault: CredentialVault,
  tokenSet: MeliTokenSet,
): Promise<void> {
  const tokenRef = config.mercadolibre?.tokenRef;
  if (!tokenRef || lastMirroredMeliAccessToken === tokenSet.accessToken) return;
  try {
    await vault.set(tokenRef, JSON.stringify(tokenSet));
    lastMirroredMeliAccessToken = tokenSet.accessToken;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[meli-token] No se pudo guardar la copia de respaldo del token en la bóveda local:", err);
  }
}

/**
 * Se ejecuta cuando Mercado Libre responde 401 a una llamada (access_token
 * vencido o invalidado): renueva el token (con la fila compartida bloqueada,
 * así app y worker nunca gastan el mismo refresh_token) y devuelve el nuevo
 * access_token para que el cliente reintente la llamada. Si otro proceso ya lo
 * renovó, devuelve ese sin renovar de nuevo. Una sola renovación a la vez por
 * proceso (promesa compartida).
 */
function refreshMeliAfterUnauthorized(failedAccessToken: string): Promise<string | undefined> {
  if (inFlightMeliForcedRefresh) return inFlightMeliForcedRefresh;

  inFlightMeliForcedRefresh = (async () => {
    const appConfig = await loadMeliAppConfig(readAppConfig(), getCredentialVault());
    if (!appConfig) return undefined;
    return refreshMeliAccessTokenAfterUnauthorized(appConfig, failedAccessToken);
  })().finally(() => {
    inFlightMeliForcedRefresh = null;
  });

  return inFlightMeliForcedRefresh;
}

async function buildMeliClient(
  config: ReturnType<typeof readAppConfig>,
  vault: CredentialVault,
): Promise<MercadoLibreClient | undefined> {
  const tokenRef = config.mercadolibre?.tokenRef;
  if (!tokenRef) return undefined;
  if (inFlightMeliClientBuild) return inFlightMeliClientBuild;

  inFlightMeliClientBuild = (async () => {
    const appConfig = await loadMeliAppConfig(config, vault);
    if (!appConfig) return undefined;

    let tokenSet = await getFreshMeliTokenSet(appConfig);
    if (!tokenSet) {
      // Primera vez con la base compartida: se pasa a ella el token que esta
      // app ya tenía en su bóveda local (así no hay que reconectar la cuenta).
      const raw = await vault.get(tokenRef);
      if (!raw) return undefined;
      await seedLiveMeliTokenIfMissing(JSON.parse(raw) as MeliTokenSet);
      tokenSet = await getFreshMeliTokenSet(appConfig);
      if (!tokenSet) return undefined;
    }

    await mirrorMeliTokenToVault(config, vault, tokenSet);
    return new MercadoLibreClient(tokenSet.accessToken, refreshMeliAfterUnauthorized);
  })();

  try {
    return await inFlightMeliClientBuild;
  } finally {
    inFlightMeliClientBuild = null;
  }
}

export async function buildChannelClients(): Promise<PushChannelClients> {
  const config = readAppConfig();
  const vault = getCredentialVault();
  const clients: PushChannelClients = {};

  if (config.shopify) {
    const clientSecret = await vault.get(config.shopify.credentialRef);
    if (clientSecret) {
      clients.shopify = new ShopifyClient({
        shopDomain: config.shopify.shopDomain,
        apiVersion: config.shopify.apiVersion,
        clientId: config.shopify.clientId,
        clientSecret,
      });
    }
  }

  // Bug real SKU EM7405MC (ronda 4): antes, si `buildMeliClient` fallaba
  // (token de refresco vencido/rotado, error de red al refrescarlo, etc.),
  // la excepción se propagaba sin atrapar hasta acá — lo que rompía
  // `buildChannelClients()` ENTERO, incluyendo el cliente de Shopify que
  // ya se había construido bien un par de líneas más arriba. Desde el
  // sondeo periódico automático (`apps/desktop/src/main/index.ts`), eso
  // significaba que NINGÚN pedido nuevo se procesaba en esa corrida —ni de
  // Shopify ni de Mercado Libre— sin que quedara ningún aviso visible para
  // el usuario (el error solo se veía en la consola del proceso principal,
  // que normalmente nadie está mirando). Ahora se atrapa acá: Shopify
  // sigue funcionando igual, y el motivo del fallo de Mercado Libre queda
  // guardado en `mercadolibreError` para que `pushStockToOtherChannels`
  // (`@blacksand/sync-engine`) lo convierta en un error visible y
  // accionable por pedido, en vez de un push que se salta en silencio —
  // ver el comentario grande en `PushChannelClients.mercadolibreError`.
  try {
    clients.mercadolibre = await buildMeliClient(config, vault);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[buildChannelClients] No se pudo construir el cliente de Mercado Libre:", err);
    clients.mercadolibreError = message;
  }

  return clients;
}

/**
 * Error uniforme para cuando una acción necesita Mercado Libre pero
 * `buildChannelClients()` no entregó un cliente. Antes, cada uno de los
 * handlers de abajo mostraba siempre el mismo mensaje genérico ("no está
 * conectado (falta OAuth)") sin importar la causa real — lo cual es
 * engañoso cuando la cuenta SÍ está conectada (hay un `tokenRef` guardado
 * en `config.json`, o sea que el usuario ya autorizó la cuenta alguna
 * vez) pero el refresco del token falló en ESTE intento puntual (token
 * rotado/vencido, error de red al refrescar, etc. — ver el comentario
 * grande en `PushChannelClients.mercadolibreError`, @blacksand/sync-engine,
 * `push.ts`). Ahora se distingue de verdad: si `buildChannelClients()`
 * capturó un `mercadolibreError`, se muestra ESE motivo real (y se
 * sugiere reconectar en Configuración); solo si no hay ningún error
 * capturado Y tampoco hay cliente, es que nunca se conectó.
 */
function meliNotConnectedError(clients: PushChannelClients): Error {
  if (clients.mercadolibreError) {
    return new Error(
      `No se pudo conectar con Mercado Libre (la cuenta está conectada, pero el token falló al renovarse ahora): ${clients.mercadolibreError}. Si esto se repite, reconecta la cuenta desde Configuración.`,
    );
  }
  return new Error("Mercado Libre no está conectado (falta OAuth)");
}

/**
 * `state` del intercambio OAuth de Mercado Libre en curso (si hay uno). No
 * se persiste a disco: vive solo mientras el usuario está en medio del flujo
 * "Conectar cuenta" → autorizar en el navegador → pegar la URL de vuelta.
 */
let pendingMeliOAuthState: string | null = null;

/**
 * Mercado Libre exige que el redirect_uri sea una dirección pública real
 * (rechaza "localhost" con "La dirección debe ser válida"), así que no hay
 * forma de levantar un servidor local que capture el `code` en automático
 * como con Shopify. En vez de eso, el redirect_uri configurado apunta a una
 * página real cualquiera (p. ej. el sitio de la tienda) y el usuario pega de
 * vuelta la URL completa (o solo el `code`) de esa página tras autorizar.
 */
function parseMeliOAuthPaste(pasted: string): { code: string | null; state: string | null } {
  const trimmed = pasted.trim();
  try {
    const url = new URL(trimmed);
    return { code: url.searchParams.get("code"), state: url.searchParams.get("state") };
  } catch {
    // No es una URL (o vino sin protocolo): se asume que es directamente el valor de "code".
    return { code: trimmed || null, state: null };
  }
}

export function registerIpcHandlers(): void {
  registerShippingHandlers();

  ipcMain.handle(IPC_CHANNELS.dashboardGetSyncStatus, async (): Promise<DashboardRow[]> => {
    const rows = await listDashboardSyncStatus();
    return rows.map((r) => ({
      id: r.id,
      productName: r.product.name,
      channelCode: r.channel.code,
      status: r.status as DashboardRow["status"],
      stockDiff: r.stockDiff,
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
      lastError: r.lastError,
      lastErrorCode: r.lastErrorCode,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.channelsGetStatus, async (): Promise<ChannelStatusRow[]> => {
    const db = getDb();
    const channels = await db.channel.findMany({ include: { credentials: true } });
    const config = readAppConfig();
    return channels.map((c) => {
      const cred = c.credentials[0];
      const configured =
        (c.code === "shopify" && Boolean(config.shopify)) ||
        (c.code === "mercadolibre" && Boolean(config.mercadolibre?.tokenRef)) ||
        (c.code === "meta" && Boolean(config.meta));
      return {
        code: c.code as ChannelStatusRow["code"],
        name: c.name,
        isActive: c.isActive,
        configured,
        lastVerified: cred?.updatedAt ? cred.updatedAt.toISOString() : null,
        detail: cred?.status ?? null,
      };
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.channelsSaveShopifyConfig,
    async (_event, input: ShopifyConfigInput) => {
      const client = new ShopifyClient(input);
      const access = await client.verifyAccess(); // falla rápido si las credenciales/dominio son inválidos

      const vault = getCredentialVault();
      const ref = newCredentialRef("shopify", "client_secret");
      await vault.set(ref, input.clientSecret);

      updateAppConfig({
        shopify: {
          shopDomain: input.shopDomain,
          apiVersion: input.apiVersion,
          clientId: input.clientId,
          credentialRef: ref,
        },
      });

      const db = getDb();
      const channel = await db.channel.update({ where: { code: "shopify" }, data: { isActive: true } });
      await db.channelCredential.upsert({
        where: { credentialRef: ref },
        update: { scopes: access.scopes.join(","), status: "activo", tokenExpiresAt: null },
        create: {
          channelId: channel.id,
          credentialRef: ref,
          scopes: access.scopes.join(","),
          status: "activo",
        },
      });

      await recordAudit({ action: "conectar_canal", entityType: "channel", entityId: channel.id, after: { shopName: access.shopName } });

      return { ok: true as const, shopName: access.shopName, scopes: access.scopes };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.channelsSaveMercadoLibreConfig,
    async (_event, input: MercadoLibreConfigInput) => {
      const vault = getCredentialVault();
      const ref = newCredentialRef("mercadolibre", "client_secret");
      await vault.set(ref, input.clientSecret);

      updateAppConfig({
        mercadolibre: {
          clientId: input.clientId,
          clientSecretRef: ref,
          redirectUri: input.redirectUri,
          siteId: "MLC",
        },
      });

      await recordAudit({ action: "configurar_canal", entityType: "channel", entityId: "mercadolibre" });
      return { ok: true as const };
    },
  );

  ipcMain.handle(IPC_CHANNELS.channelsStartMercadoLibreOAuth, async () => {
    const config = readAppConfig();
    if (!config.mercadolibre) {
      throw new Error("Primero guarda el Client ID/Secret de Mercado Libre en Configuración");
    }
    const vault = getCredentialVault();
    const clientSecret = await vault.get(config.mercadolibre.clientSecretRef);
    if (!clientSecret) throw new Error("No se encontró el client secret en la bóveda");

    const state = randomUUID();
    pendingMeliOAuthState = state;

    const authUrl = buildMeliAuthorizationUrl(
      { clientId: config.mercadolibre.clientId, clientSecret, redirectUri: config.mercadolibre.redirectUri, siteId: "MLC" },
      state,
    );

    await shell.openExternal(authUrl);
    return { ok: true as const };
  });

  ipcMain.handle(
    IPC_CHANNELS.channelsCompleteMercadoLibreOAuth,
    async (_event, pastedUrlOrCode: string) => {
      if (!pendingMeliOAuthState) {
        throw new Error('Primero haz clic en "Conectar cuenta" para iniciar la autorización con Mercado Libre.');
      }
      const config = readAppConfig();
      if (!config.mercadolibre) throw new Error("Mercado Libre no está configurado");
      const vault = getCredentialVault();
      const clientSecret = await vault.get(config.mercadolibre.clientSecretRef);
      if (!clientSecret) throw new Error("No se encontró el client secret en la bóveda");

      const { code, state } = parseMeliOAuthPaste(pastedUrlOrCode);
      if (state && state !== pendingMeliOAuthState) {
        throw new Error(
          'El "state" de lo que pegaste no coincide con esta sesión de conexión. Haz clic de nuevo ' +
            'en "Conectar cuenta" y pega la URL más reciente a la que te llevó Mercado Libre.',
        );
      }
      if (!code) {
        throw new Error(
          'No se encontró "code" en lo que pegaste. Pega la URL completa de la página a la que te ' +
            'llevó Mercado Libre después de autorizar (o, si solo copiaste el código, pega únicamente ese valor).',
        );
      }

      const tokenSet = await exchangeMeliAuthorizationCode(
        { clientId: config.mercadolibre.clientId, clientSecret, redirectUri: config.mercadolibre.redirectUri, siteId: "MLC" },
        code,
      );

      const tokenRef = newCredentialRef("mercadolibre", "token_set");
      await vault.set(tokenRef, JSON.stringify(tokenSet));
      // Token nuevo (cuenta recién conectada/reconectada): pisa el que hubiera en la base compartida, que es la que usan la app Y el worker en la nube.
      await saveLiveMeliToken(tokenSet);
      updateAppConfig({ mercadolibre: { ...config.mercadolibre, tokenRef } });

      const db = getDb();
      const channel = await db.channel.update({ where: { code: "mercadolibre" }, data: { isActive: true } });
      await db.channelCredential.upsert({
        where: { credentialRef: tokenRef },
        update: { status: "activo", tokenExpiresAt: new Date(tokenSet.expiresAt) },
        create: { channelId: channel.id, credentialRef: tokenRef, status: "activo", tokenExpiresAt: new Date(tokenSet.expiresAt) },
      });
      await recordAudit({ action: "conectar_canal", entityType: "channel", entityId: channel.id });

      pendingMeliOAuthState = null;
      return { ok: true as const };
    },
  );

  /** Deserializa `listingSubStatus` (JSON string en el esquema) de forma defensiva — mismo criterio que `parseSubStatus` en `@blacksand/sync-engine/meli-listing-status.ts`. */
  function parseListingSubStatus(json: string | null | undefined): string[] {
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  ipcMain.handle(IPC_CHANNELS.productsList, async (): Promise<ProductRow[]> => {
    const products = await listProductsWithSyncStatus();
    return products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,
      totalStock: p.variants.reduce(
        (sum, v) => sum + v.inventoryItems.reduce((s, i) => s + i.quantityOnHand, 0),
        0,
      ),
      channels: p.channelMap.map((m) => ({
        code: m.channel.code,
        status: m.syncStatus,
        lastErrorCode: m.lastErrorCode,
        listingStatus: m.listingStatus,
        listingSubStatus: parseListingSubStatus(m.listingSubStatus),
      })),
      // Fase 2a: detalle editable por variante (antes la pantalla Productos
      // era de solo lectura a nivel producto).
      variants: p.variants.map((v) => {
        const variantMaps = p.channelMap.filter((m) => m.variantId === v.id);
        return {
          id: v.id,
          skuVariant: v.skuVariant,
          barcodeVariant: v.barcodeVariant,
          price: v.price,
          quantityOnHand: v.inventoryItems.reduce((s, i) => s + i.quantityOnHand, 0),
          channels: variantMaps.map((m) => ({
            code: m.channel.code,
            status: m.syncStatus,
            channelProductId: m.channelProductId,
            lastError: m.lastError,
            lastErrorCode: m.lastErrorCode,
            listingStatus: m.listingStatus,
          })),
        };
      }),
    }));
  });

  ipcMain.handle(
    IPC_CHANNELS.productsUpdate,
    async (_event, input: ProductUpdateInput): Promise<ProductUpdateResult> => {
      if (input.sku === undefined && input.price === undefined && input.quantity === undefined) {
        throw new Error("No hay ningún cambio que guardar (SKU, precio y stock vinieron vacíos).");
      }

      const before = await getDb().productVariant.findUnique({
        where: { id: input.variantId },
        select: { skuVariant: true, price: true },
      });

      const clients = await buildChannelClients();
      const results = await pushVariantToChannels(
        input.variantId,
        { sku: input.sku, price: input.price, quantity: input.quantity },
        clients,
      );

      await recordAudit({
        action: "editar_variante",
        entityType: "product_variant",
        entityId: input.variantId,
        before,
        after: { sku: input.sku, price: input.price, quantity: input.quantity, results },
      });

      return { ok: true as const, results };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.productsDelete,
    async (_event, productId: string, force?: boolean): Promise<ProductDeleteResult> => {
      const before = await getDb().product.findUnique({
        where: { id: productId },
        select: { sku: true, name: true },
      });
      if (!before) {
        throw new Error("Este producto ya no existe (puede que ya lo hayas eliminado).");
      }

      const result = await deleteProduct(productId, force ?? false);

      if (!result.deleted) {
        // No se borró nada — no es un error, es la advertencia que la UI le
        // muestra al usuario antes de confirmar el borrado forzado. No se
        // audita porque no pasó nada todavía.
        return result;
      }

      await recordAudit({
        action: "eliminar_producto",
        entityType: "product",
        entityId: productId,
        before,
        after: force ? { forced: true } : undefined,
      });

      return result;
    },
  );

  // --- "Crear producto" (subir un producto nuevo desde la app hacia
  // Shopify y, en el mismo acto, Mercado Libre) --------------------------

  ipcMain.handle(IPC_CHANNELS.productsPickImages, async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Elegir fotos del producto",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Imágenes", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  ipcMain.handle(
    IPC_CHANNELS.productsCreateAndPublish,
    async (_event, input: CreateProductInput): Promise<CreateProductResult> => {
      const clients = await buildChannelClients();
      const config = readAppConfig();

      // Las fotos se eligieron antes con `products:pickImages` (rutas
      // locales) — recién acá se leen los bytes, en el proceso principal,
      // para que nunca tengan que cruzar el puente IPC como archivo/Buffer
      // (mismo criterio de mantener el puente IPC liviano que el resto de
      // la app).
      const images = await Promise.all(
        input.imagePaths.map(async (path) => {
          const data = await readFile(path);
          const ext = extname(path).toLowerCase();
          return {
            filename: basename(path),
            mimeType: IMAGE_MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
            data,
          };
        }),
      );

      const result = await createProductAndPublish(
        clients,
        {
          sku: input.sku,
          barcode: input.barcode ?? null,
          name: input.name,
          description: input.description ?? null,
          brand: input.brand ?? null,
          category: input.category ?? null,
          price: input.price,
          quantityOnHand: input.quantityOnHand,
          images,
        },
        { defaultBrand: config.mercadolibrePublish?.defaultBrand ?? null },
      );

      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.reconciliationListPending, async (): Promise<ReconciliationRow[]> => {
    const pending = await listPendingReconciliation();
    const db = getDb();
    const allVariants = await db.productVariant.findMany({ include: { product: true } });

    return pending.map((row) => ({
      id: row.id,
      channelCode: row.channel.code,
      channelProductId: row.channelProductId,
      channelVariantId: row.channelVariantId,
      channelSku: row.channelSku,
      candidates: allVariants
        .filter((v) => row.channelSku && v.skuVariant.toLowerCase().includes(row.channelSku.toLowerCase().slice(0, 4)))
        .slice(0, 5)
        .map((v) => ({ variantId: v.id, productId: v.productId, sku: v.skuVariant, name: v.product.name })),
    }));
  });

  ipcMain.handle(IPC_CHANNELS.reconciliationConfirmMatch, async (_event, mapId: string, centralVariantId: string) => {
    const db = getDb();
    const mapRow = await db.channelProductMap.findUniqueOrThrow({ where: { id: mapId } });
    await applyReconciliationDecision({
      centralVariantId,
      channelCode: (await db.channel.findUniqueOrThrow({ where: { id: mapRow.channelId } })).code as "shopify" | "mercadolibre" | "meta",
      channelProductId: mapRow.channelProductId,
      channelVariantId: mapRow.channelVariantId,
      action: "confirmar_match",
    });
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.reconciliationIgnore, async (_event, mapId: string) => {
    const db = getDb();
    const mapRow = await db.channelProductMap.findUniqueOrThrow({ where: { id: mapId } });
    const channel = await db.channel.findUniqueOrThrow({ where: { id: mapRow.channelId } });
    await applyReconciliationDecision({
      centralVariantId: "",
      channelCode: channel.code as "shopify" | "mercadolibre" | "meta",
      channelProductId: mapRow.channelProductId,
      channelVariantId: mapRow.channelVariantId,
      action: "ignorar",
    });
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.auditList, async () => {
    const rows = await listAuditLog();
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      createdAt: r.createdAt.toISOString(),
      userName: r.user?.name ?? null,
      // Fase 3: resumen legible de `after` (p. ej. líneas de pedido sin
      // mapeo) — se recorta para no inundar la tabla con JSON gigante.
      detail: r.after ? r.after.slice(0, 300) : null,
    }));
  });

  ipcMain.handle(
    IPC_CHANNELS.syncRunOrderPollNow,
    async (_event, customLookbackHours?: number): Promise<OrderIngestSummaryRow[]> => {
      // Mismo "turno" compartido que el sondeo automático (ver `main/index.ts`): app y worker en la nube no deben procesar pedidos a la vez.
      const leased = await withOrderPollLease("app-manual", async () => {
        const clients = await buildChannelClients();
        const lookbackHours = computeOrderPollLookbackHours(customLookbackHours);
        const summaries = await pollAllChannelOrders(clients, lookbackHours);
        recordOrderPollCheckpoint();
        return summaries;
      });
      if (!leased.ran) {
        throw new Error(
          "Otro proceso (la revisión automática en la nube) está revisando pedidos ahora mismo. Espera un minuto y vuelve a intentar.",
        );
      }
      return leased.value;
    },
  );

  ipcMain.handle(IPC_CHANNELS.ordersListRecent, async (): Promise<RecentOrderRow[]> => {
    const orders = await listRecentOrders(20);
    return orders.map((o) => ({
      id: o.id,
      channelCode: o.channel?.code ?? null,
      // Fase 3d: cae al channelOrderId cuando no se guardó un número aparte (siempre el caso para Mercado Libre y para pedidos ingresados antes de este campo).
      orderNumber: o.orderNumber ?? o.channelOrderId,
      orderDate: o.orderDate.toISOString(),
      itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
      // "Eliminar producto" (con historial) deja variantId en NULL — cae al
      // snapshot guardado en ese momento, y si tampoco hay snapshot (pedido
      // viejo de antes de esta ronda) muestra un texto explícito en vez de
      // reventar.
      items: o.items.map((i) => ({
        sku: i.variant?.skuVariant ?? i.skuSnapshot ?? "Producto eliminado",
        quantity: i.quantity,
      })),
      total: o.total,
      status: o.status,
      syncStatus: o.syncStatus,
      // Fase 3g: detalle del último error de push, si lo hay.
      lastSyncError: o.lastSyncError,
      lastSyncErrorCode: o.lastSyncErrorCode,
      cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
      restocked: o.restocked,
    }));
  });

  // --- Cancelaciones de pedidos (Fase 3c) ---------------------------------
  // Ver el comentario grande en `orders.ts` (@blacksand/sync-engine): un
  // pedido cancelado de Shopify se resuelve solo (repone o no, según lo que
  // el usuario haya elegido al cancelar en la propia tienda); uno de
  // Mercado Libre siempre queda pendiente acá, porque esa tienda no expone
  // esa información por API.

  ipcMain.handle(IPC_CHANNELS.ordersListPendingCancellations, async (): Promise<PendingCancellationRow[]> => {
    return listPendingCancellations();
  });

  ipcMain.handle(
    IPC_CHANNELS.ordersResolveCancellation,
    async (_event, orderId: string, restocked: boolean): Promise<{ ok: true }> => {
      const clients = await buildChannelClients();
      return resolveOrderCancellation(orderId, restocked, clients);
    },
  );

  // --- Correlativo de pedidos (Fase 3e) -----------------------------------
  // A pedido explícito del usuario: "que los pedidos sean los correlativos
  // de mi tienda, tambien quiero actualizar los que ya estanban en la app".
  // Botón manual en el Dashboard — solo lee (Shopify) y escribe en la base
  // local, no toca stock ni ningún canal, así que es seguro correrlo las
  // veces que haga falta.
  ipcMain.handle(IPC_CHANNELS.ordersBackfillOrderNumbers, async (): Promise<BackfillOrderNumbersResult> => {
    const clients = await buildChannelClients();
    return backfillOrderNumbers(clients);
  });

  // --- Reintentar sincronización de pedidos (Fase 3g) ---------------------
  // A pedido explícito del usuario: "quiero corregir los errores y los
  // estados pendientes de los pedidos del dashboard". Reintenta SOLO el
  // push de stock a los demás canales de un pedido puntual — no vuelve a
  // tocar el inventario local, así que es seguro reintentar las veces que
  // haga falta.
  ipcMain.handle(
    IPC_CHANNELS.ordersRetrySync,
    async (_event, orderId: string): Promise<RetryOrderSyncResult> => {
      const clients = await buildChannelClients();
      return retryOrderSync(orderId, clients);
    },
  );

  ipcMain.handle(IPC_CHANNELS.posRegisterSale, async (_event, input: PosSaleInput): Promise<PosSaleResult> => {
    const clients = await buildChannelClients();
    const outcome = await registerPosSale(
      { items: input.items, paymentMethod: input.paymentMethod, observations: input.observations },
      clients,
    );
    return { ok: true as const, orderId: outcome.orderId, orderNumber: outcome.orderNumber, pushResults: outcome.pushResults };
  });

  ipcMain.handle(IPC_CHANNELS.syncRunImportNow, async (_event, channelCode: "shopify" | "mercadolibre") => {
    // Fase 3: reusa buildChannelClients (con refresco automático del token
    // de Mercado Libre) en vez de construir el cliente a mano aquí — antes
    // de esto, importar manualmente con un token de ML vencido fallaba en
    // vez de refrescarlo solo, igual que le pasaba al sondeo automático.
    const clients = await buildChannelClients();

    if (channelCode === "shopify") {
      if (!clients.shopify) throw new Error("Shopify no está configurado");
      return importShopifyCatalog(clients.shopify);
    }

    if (channelCode === "mercadolibre") {
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return importMercadoLibreCatalog(clients.mercadolibre);
    }

    throw new Error(`Canal no soportado para importación: ${channelCode}`);
  });

  // --- Fase 2b: publicar productos de Shopify en Mercado Libre -----------

  ipcMain.handle(IPC_CHANNELS.channelsGetMeliPublishDefaults, async () => {
    const config = readAppConfig();
    return { defaultBrand: config.mercadolibrePublish?.defaultBrand ?? null };
  });

  ipcMain.handle(
    IPC_CHANNELS.channelsSaveMeliPublishDefaults,
    async (_event, input: { defaultBrand: string }) => {
      updateAppConfig({ mercadolibrePublish: { defaultBrand: input.defaultBrand } });
      return { ok: true as const };
    },
  );

  ipcMain.handle(IPC_CHANNELS.meliPublishListCandidateGroups, async (): Promise<MeliPublishGroupRow[]> => {
    return listPublishCandidateGroups();
  });

  ipcMain.handle(
    IPC_CHANNELS.meliPublishPreviewCategory,
    async (
      _event,
      groupKey: string,
      customQuery?: string,
      includeAllPaths?: boolean,
    ): Promise<MeliCategoryPreviewResult> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      // `includeAllPaths` lo decide el llamador (ver el comentario grande en
      // `meliPublish.previewCategory`, shared-ipc-types.ts): la pantalla
      // "Revisar categoría" (un grupo a la vez) lo pide para mostrar el
      // camino completo de TODAS las alternativas del selector — necesario
      // para distinguir, ej., varios "Cascos" de ramas distintas del árbol
      // de Mercado Libre. "Publicar todo automáticamente" NO lo pide (llama
      // esto en cadena por cada grupo pendiente y solo usa
      // `predictions[0]`) para no multiplicar las llamadas sin necesidad.
      const preview = await previewCategoryForGroup(groupKey, clients.mercadolibre, customQuery, {
        includeAllPaths,
      });
      return toCategoryPreviewResult(preview);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.meliPublishConfirmGroupMapping,
    async (_event, input: MeliConfirmGroupMappingInput) => {
      await confirmGroupMapping({
        groupKey: input.groupKey,
        categoryId: input.categoryId,
        categoryName: input.categoryName,
        listingTypeId: input.listingTypeId,
        attributeDefaults: input.attributeDefaults,
        emptyGtinAttributeId: input.emptyGtinAttributeId ?? null,
        emptyGtinValueId: input.emptyGtinValueId ?? null,
        emptyGtinValueName: input.emptyGtinValueName ?? null,
        forceStandardSize: input.forceStandardSize ?? false,
        defaultColorValueId: input.defaultColorValueId ?? null,
        defaultColorValueName: input.defaultColorValueName ?? null,
      });
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.meliPublishRunBatch,
    async (_event, groupKey: string, limit: number): Promise<MeliPublishBatchResult> => {
      const clients = await buildChannelClients();
      const config = readAppConfig();
      return publishBatch(clients, groupKey, limit, {
        defaultBrand: config.mercadolibrePublish?.defaultBrand ?? null,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.meliGetListingTypes, async (): Promise<MeliListingTypeRow[]> => {
    const clients = await buildChannelClients();
    if (!clients.mercadolibre) throw meliNotConnectedError(clients);
    return clients.mercadolibre.getListingTypes("MLC");
  });

  ipcMain.handle(IPC_CHANNELS.meliSyncDescriptions, async (): Promise<MeliDescriptionSyncResult> => {
    // Mismo paso que corre solo cada cierto tiempo en segundo plano (ver
    // `main/index.ts`) — este botón lo fuerza de inmediato bajo demanda.
    const clients = await buildChannelClients();
    return syncMeliDescriptions(clients);
  });

  // --- Categorías por palabra clave (evita depender a ciegas de la
  // predicción de texto de Mercado Libre — ver `findKeywordOverride` en
  // @blacksand/core-domain) ------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.meliPublishListKeywordOverrides, async (): Promise<MeliKeywordOverrideRow[]> => {
    return listMeliKeywordOverrides();
  });

  ipcMain.handle(
    IPC_CHANNELS.meliPublishSaveKeywordOverride,
    async (_event, input: { keyword: string; categoryId: string; categoryName: string }) => {
      await saveMeliKeywordOverride(input);
      return { ok: true as const };
    },
  );

  ipcMain.handle(IPC_CHANNELS.meliPublishDeleteKeywordOverride, async (_event, id: string) => {
    await deleteMeliKeywordOverride(id);
    return { ok: true as const };
  });

  ipcMain.handle(
    IPC_CHANNELS.meliPublishSearchCategories,
    async (_event, query: string): Promise<MeliCategorySearchResultRow[]> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return searchMeliCategories(clients.mercadolibre, query);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.meliPublishPreviewAllPendingCategories,
    async (): Promise<MeliBulkCategoryPreviewRow[]> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      const rows = await previewAllPendingCategories(clients.mercadolibre);
      return rows.map((r) => ({
        groupKey: r.groupKey,
        sampleProductName: r.sampleProductName,
        productCount: r.productCount,
        preview: toCategoryPreviewResult(r.preview),
        suggestedKeyword: r.suggestedKeyword,
      }));
    },
  );

  // --- Estado en Mercado Libre (activas/pausadas/cerradas) ----------------
  // Ver el comentario grande en `meli-listing-status.ts` (@blacksand/sync-engine)
  // para el porqué: productos que Mercado Libre pausó/cerró por su cuenta
  // después de publicarlos, y que antes quedaban invisibles en la app.

  ipcMain.handle(IPC_CHANNELS.meliListingListIssues, async (): Promise<MeliListingIssueRow[]> => {
    return listMeliListingIssues();
  });

  ipcMain.handle(
    IPC_CHANNELS.meliListingReactivate,
    async (_event, channelProductId: string): Promise<MeliListingReactivateResult> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return reactivateMeliListing(clients.mercadolibre, channelProductId);
    },
  );

  // "Eliminar publicación" (a pedido del usuario: "necesito que la app
  // también me permita borrar publicaciones de ML directamente desde la
  // app"). Mercado Libre no expone un borrado permanente vía API para una
  // cuenta con historial — esto CIERRA la publicación, ver el comentario
  // grande en `closeMeliListing` (@blacksand/sync-engine).
  ipcMain.handle(
    IPC_CHANNELS.meliListingClose,
    async (_event, channelProductId: string): Promise<MeliListingCloseResult> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return closeMeliListing(clients.mercadolibre, channelProductId);
    },
  );

  // --- Cerrar publicaciones duplicadas -------------------------------------
  // Ver el comentario grande en `meli-duplicate-fix.ts` (@blacksand/sync-engine):
  // caso real, ~20 productos quedaron publicados dos veces por un doble
  // clic en "Publicar lote"/"Publicar todo automáticamente" (ya corregido).

  ipcMain.handle(IPC_CHANNELS.meliDuplicateFixPreview, async (): Promise<MeliDuplicateGroup[]> => {
    return previewMeliDuplicates();
  });

  ipcMain.handle(
    IPC_CHANNELS.meliDuplicateFixClose,
    async (_event, channelProductIds: string[]): Promise<MeliDuplicateCloseOutcome[]> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return closeMeliDuplicates(clients.mercadolibre, channelProductIds);
    },
  );

  // --- Corregir marca por prefijo de SKU -----------------------------------
  // Ver el comentario grande en `meli-brand-fix.ts` (@blacksand/sync-engine):
  // caso real, productos "EM..." (EmersonGear) publicados con la marca por
  // defecto de Configuración en vez de su marca real.

  ipcMain.handle(
    IPC_CHANNELS.meliBrandFixPreview,
    async (_event, skuPrefix: string): Promise<MeliBrandFixPreviewRow[]> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return previewMeliBrandFix(skuPrefix, clients.mercadolibre);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.meliBrandFixRun,
    async (
      _event,
      skuPrefix: string,
      newBrand: string,
      updateLocalBrand: boolean,
    ): Promise<MeliBrandFixRunResult> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return fixMeliBrandBySkuPrefix(skuPrefix, newBrand, clients.mercadolibre, updateLocalBrand);
    },
  );

  // --- Corregir SKU incorrecto en Mercado Libre ----------------------------
  // A pedido directo del usuario: "revisa los productos publicados en ML y
  // corrige los sku que estan con error". Ver el comentario grande en
  // `meli-sku-fix.ts` (@blacksand/sync-engine) — a diferencia de "Corregir
  // marca por prefijo de SKU", acá el valor correcto no lo elige el
  // usuario, es el SKU que ya está guardado localmente (Shopify).

  ipcMain.handle(IPC_CHANNELS.meliSkuFixPreview, async (): Promise<MeliSkuFixPreviewRow[]> => {
    const clients = await buildChannelClients();
    if (!clients.mercadolibre) throw meliNotConnectedError(clients);
    return previewMeliSkuFix(clients.mercadolibre);
  });

  ipcMain.handle(
    IPC_CHANNELS.meliSkuFixRun,
    async (_event, items: MeliSkuFixItemInput[]): Promise<MeliSkuFixRunResult> => {
      const clients = await buildChannelClients();
      if (!clients.mercadolibre) throw meliNotConnectedError(clients);
      return fixMeliSkuMismatches(items, clients.mercadolibre);
    },
  );

  // --- Auditoría de Stock (Shopify vs Mercado Libre) -----------------------
  // A pedido directo del usuario, caso real: "el inventario de casco wendy
  // en shopify es 9 y en ML es 10, algo pasó, revisalo y corrige". Ver el
  // comentario grande en `stock-audit.ts` (@blacksand/sync-engine) — la app
  // no decide sola cuál de los dos números es el correcto, muestra los tres
  // (local/Shopify/Mercado Libre) para que el usuario elija.

  ipcMain.handle(IPC_CHANNELS.stockAuditPreview, async (): Promise<StockAuditRow[]> => {
    const clients = await buildChannelClients();
    if (!clients.shopify) throw new Error("Shopify no está conectado (falta configurar el canal)");
    if (!clients.mercadolibre) throw meliNotConnectedError(clients);
    return previewStockAudit(clients.shopify, clients.mercadolibre);
  });

  ipcMain.handle(
    IPC_CHANNELS.stockAuditApply,
    async (_event, variantId: string, quantity: number): Promise<StockAuditApplyResult> => {
      const clients = await buildChannelClients();
      return applyStockAuditCorrection(variantId, quantity, clients);
    },
  );

  // --- Descuentos masivos (precio → precio de comparación) ----------------
  // Ver `bulk-discount.ts` (@blacksand/sync-engine): lee el catálogo EN VIVO
  // de Shopify, y al aplicar recalcula todo con datos frescos (no confía en
  // los números de la vista previa).

  ipcMain.handle(IPC_CHANNELS.discountPreview, async (): Promise<DiscountPreviewProduct[]> => {
    const clients = await buildChannelClients();
    if (!clients.shopify) throw new Error("Shopify no está conectado (falta configurar el canal)");
    return previewBulkDiscountProducts(clients.shopify);
  });

  ipcMain.handle(
    IPC_CHANNELS.discountApply,
    async (_event, input: DiscountApplyInput): Promise<DiscountApplyResult> => {
      const clients = await buildChannelClients();
      if (!clients.shopify) throw new Error("Shopify no está conectado (falta configurar el canal)");
      return applyBulkDiscount(clients.shopify, input);
    },
  );

  ipcMain.handle(IPC_CHANNELS.discountListBatches, async (): Promise<DiscountBatchRow[]> => {
    return listDiscountBatches();
  });

  ipcMain.handle(IPC_CHANNELS.discountListBaselines, async (): Promise<DiscountBaselineRow[]> => {
    const rows = await listPriceBaselines();
    return rows.map((r) => ({
      variantGid: r.variantGid,
      productGid: r.productGid,
      productTitle: r.productTitle,
      sku: r.sku,
      baselinePrice: r.baselinePrice,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.discountRevert, async (_event, batchId: string): Promise<DiscountRevertResult> => {
    const clients = await buildChannelClients();
    if (!clients.shopify) throw new Error("Shopify no está conectado (falta configurar el canal)");
    return revertDiscountBatch(clients.shopify, batchId);
  });

  // --- Promociones de Mercado Libre (solo lectura por ahora) ---------------

  ipcMain.handle(IPC_CHANNELS.cloudWorkerStatus, async (): Promise<CloudWorkerStatus | null> => {
    const beat = await readWorkerHeartbeat("order-poll");
    if (!beat) return null;
    return {
      lastRunAt: beat.lastRunAt.toISOString(),
      secondsSinceRun: beat.secondsSinceRun,
      lastOkAt: beat.lastOkAt ? beat.lastOkAt.toISOString() : null,
      lastSummary: beat.lastSummary,
      lastError: beat.lastError,
    };
  });

  ipcMain.handle(IPC_CHANNELS.meliPromotionsProbe, async (): Promise<MeliPromotionsProbeResult> => {
    const clients = await buildChannelClients();
    if (!clients.mercadolibre) throw meliNotConnectedError(clients);
    const userId = await clients.mercadolibre.getAuthorizedUserId();
    return clients.mercadolibre.probeSellerPromotions(userId);
  });

  // --- Marca automática por prefijo de SKU (publicaciones NUEVAS) ---------
  // Distinto del bloque de arriba (que corrige lo ya publicado): esto es la
  // regla permanente que usa `buildCreateItemPayload` (@blacksand/core-domain,
  // vía `matchSkuPrefixBrand`) para que toda publicación nueva con ese
  // prefijo de SKU salga con la marca correcta desde el principio.

  ipcMain.handle(IPC_CHANNELS.meliSkuPrefixBrandList, async (): Promise<MeliSkuPrefixBrandOverrideRow[]> => {
    return listMeliSkuPrefixBrandOverrides();
  });

  ipcMain.handle(
    IPC_CHANNELS.meliSkuPrefixBrandSave,
    async (_event, input: { skuPrefix: string; brand: string }): Promise<{ ok: true }> => {
      await saveMeliSkuPrefixBrandOverride(input);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.meliSkuPrefixBrandDelete, async (_event, id: string): Promise<{ ok: true }> => {
    await deleteMeliSkuPrefixBrandOverride(id);
    return { ok: true };
  });
}

/**
 * `previewCategoryForGroup`/`previewAllPendingCategories` (sync-engine)
 * devuelven `CategoryPreview`, que trae `groupNeeds` con `colorAttribute`/
 * `sizeAttribute` completos (el atributo entero, con su lista de valores) —
 * a propósito NO expuestos tal cual al renderer (son detalle interno de
 * cómo se resuelve color/talla por producto). Acá se recorta a lo que la
 * pantalla realmente necesita mostrar: `hasSizeAttribute` (para ofrecer el
 * checkbox "Talla siempre Standard para este grupo", ver
 * `PublishGroupMapping.forceStandardSize`) y `colorRequired`/`colorValues`
 * (para ofrecer el selector "Color por defecto" solo cuando la categoría
 * de verdad exige color, ver `PublishGroupMapping.defaultColorValueId`)
 * sin mandar el objeto de atributo completo que no hace falta en la UI.
 */
function toCategoryPreviewResult(preview: CategoryPreview): MeliCategoryPreviewResult {
  return {
    predictions: preview.predictions,
    attributes: preview.attributes,
    groupNeeds: {
      gtinFallback: preview.groupNeeds.gtinFallback,
      needsGroupDefault: preview.groupNeeds.needsGroupDefault,
      requiresSizeGuide: preview.groupNeeds.requiresSizeGuide,
      hasSizeAttribute: preview.groupNeeds.sizeAttribute !== null,
      colorRequired: preview.groupNeeds.colorAttribute?.required ?? false,
      colorValues: preview.groupNeeds.colorAttribute?.values ?? [],
    },
    categorySource: preview.categorySource,
  };
}
