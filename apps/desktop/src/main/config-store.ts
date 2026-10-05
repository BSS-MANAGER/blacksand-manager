import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Configuración NO sensible por canal (dominios, IDs de app, redirect URIs).
 * Los secretos (tokens, client secrets) nunca viven aquí — van a la bóveda
 * de credenciales (D.5) y solo se referencian por `credentialRef`.
 */
export interface AppConfig {
  shopify?: {
    shopDomain: string;
    apiVersion: string;
    clientId: string; // no es secreto, se puede guardar en claro
    credentialRef: string; // referencia al client secret en la bóveda (Client Credentials Grant)
  };
  mercadolibre?: {
    clientId: string;
    clientSecretRef: string; // referencia al client secret en la bóveda
    redirectUri: string;
    siteId: "MLC";
    tokenRef?: string; // referencia al access/refresh token en la bóveda
  };
  meta?: {
    catalogId?: string;
  };
  /** Fase 2b: defaults usados al publicar productos de Shopify en Mercado Libre (ver `buildCreateItemPayload`). */
  mercadolibrePublish?: {
    defaultBrand?: string;
  };
  /**
   * Bug real reportado por el usuario (pedido #1151 de Shopify, SKU
   * em745mc, nunca descontó stock en Mercado Libre): el sondeo de pedidos
   * usaba siempre una ventana fija "ahora - 24h", así que un pedido llegado
   * mientras la app estuvo cerrada más de 24h quedaba sin procesar para
   * siempre, sin ningún error visible. `lastPollAt` es el checkpoint que
   * arregla esto — se actualiza después de cada sondeo (automático o con el
   * botón "Revisar pedidos ahora") y la próxima corrida mira desde ahí en
   * vez de una ventana fija, así ningún hueco (PC apagado un fin de semana,
   * por ejemplo) pierde pedidos en silencio. Ver `computeOrderPollLookbackHours`
   * en `ipc.ts`.
   */
  orderPolling?: {
    lastPollAt?: string;
  };
}

function configPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "config.json");
}

export function readAppConfig(): AppConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function writeAppConfig(config: AppConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function updateAppConfig(patch: Partial<AppConfig>): AppConfig {
  const current = readAppConfig();
  const next = { ...current, ...patch };
  writeAppConfig(next);
  return next;
}
