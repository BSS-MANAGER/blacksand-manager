/**
 * Configuración del worker: TODO viene de variables de entorno (en GitHub
 * Actions, de "Repository secrets"). No usa la bóveda del sistema operativo
 * (no existe en un servidor sin pantalla) ni ningún archivo local.
 */

export interface WorkerConfig {
  shopify: { shopDomain: string; apiVersion: string; clientId: string; clientSecret: string };
  meli: { clientId: string; clientSecret: string; redirectUri: string };
  /** Cuántas horas hacia atrás mira cada pasada. Revisar de más es barato: los pedidos ya ingresados se reconocen y se saltan. */
  lookbackHours: number;
}

const REQUIRED = [
  "DATABASE_URL",
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "MELI_CLIENT_ID",
  "MELI_CLIENT_SECRET",
  "MELI_REDIRECT_URI",
] as const;

/** Lee y valida las variables. Si faltan, el error lista solo los NOMBRES faltantes (nunca valores). */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = REQUIRED.filter((name) => !env[name] || env[name]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno del worker: ${missing.join(", ")}. ` +
        `En GitHub: Settings → Secrets and variables → Actions → "New repository secret".`,
    );
  }
  const lookback = Number(env.ORDER_POLL_LOOKBACK_HOURS ?? 48);
  return {
    shopify: {
      shopDomain: env.SHOPIFY_SHOP_DOMAIN!.trim(),
      apiVersion: (env.SHOPIFY_API_VERSION ?? "2026-01").trim(),
      clientId: env.SHOPIFY_CLIENT_ID!.trim(),
      clientSecret: env.SHOPIFY_CLIENT_SECRET!.trim(),
    },
    meli: {
      clientId: env.MELI_CLIENT_ID!.trim(),
      clientSecret: env.MELI_CLIENT_SECRET!.trim(),
      redirectUri: env.MELI_REDIRECT_URI!.trim(),
    },
    lookbackHours: Number.isFinite(lookback) && lookback > 0 ? lookback : 48,
  };
}
