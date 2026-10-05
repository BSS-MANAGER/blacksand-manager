import { ShopifyClient } from "@blacksand/connector-shopify";
import { MercadoLibreClient, type MeliAppConfig } from "@blacksand/connector-mercadolibre";
import {
  getFreshMeliTokenSet,
  refreshMeliAccessTokenAfterUnauthorized,
  type PushChannelClients,
} from "@blacksand/sync-engine";
import type { WorkerConfig } from "./config.js";

/**
 * Arma los clientes de Shopify y Mercado Libre — mismo objetivo que
 * `buildChannelClients()` de la app de escritorio, pero sin la bóveda local:
 *  - Shopify: client id/secret de las variables de entorno (el token de 24 h se
 *    pide y renueva solo, dentro de `ShopifyClient`).
 *  - Mercado Libre: client id/secret del entorno, y el TOKEN sale de la base
 *    compartida (tabla `ChannelLiveToken`), refrescándolo con la fila bloqueada
 *    para no chocar con la app de escritorio (el refresh_token es de un solo
 *    uso). Si el token no está o no se puede renovar, el motivo queda en
 *    `mercadolibreError` (igual que en la app) en vez de tumbar a Shopify.
 */
export async function buildWorkerClients(config: WorkerConfig): Promise<PushChannelClients> {
  const clients: PushChannelClients = {};

  clients.shopify = new ShopifyClient({
    shopDomain: config.shopify.shopDomain,
    apiVersion: config.shopify.apiVersion,
    clientId: config.shopify.clientId,
    clientSecret: config.shopify.clientSecret,
  });

  const meliApp: MeliAppConfig = {
    clientId: config.meli.clientId,
    clientSecret: config.meli.clientSecret,
    redirectUri: config.meli.redirectUri,
    siteId: "MLC",
  };

  try {
    const tokenSet = await getFreshMeliTokenSet(meliApp);
    if (!tokenSet) {
      clients.mercadolibreError =
        "No hay ningún token de Mercado Libre guardado en la base compartida. Abre la app de escritorio una vez " +
        "(con la cuenta de Mercado Libre conectada) para que lo deje ahí, o reconecta la cuenta en Configuración.";
    } else {
      clients.mercadolibre = new MercadoLibreClient(tokenSet.accessToken, (failedAccessToken) =>
        refreshMeliAccessTokenAfterUnauthorized(meliApp, failedAccessToken),
      );
    }
  } catch (err) {
    clients.mercadolibreError = err instanceof Error ? err.message : String(err);
  }

  return clients;
}
