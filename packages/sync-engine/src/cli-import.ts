/**
 * Script de línea de comandos para probar la importación de Fase 1 sin la UI
 * de Electron (útil en Fase 0/1 mientras se valida contra datos reales).
 * Uso: pnpm run import:catalog  (después de configurar .env / bóveda).
 */
import { seedChannels } from "@blacksand/db";
import { ShopifyClient } from "@blacksand/connector-shopify";
import { MercadoLibreClient } from "@blacksand/connector-mercadolibre";
import { importShopifyCatalog, importMercadoLibreCatalog } from "./importer.js";

async function main() {
  await seedChannels();

  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01";
  const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (shopDomain && shopifyToken) {
    const client = new ShopifyClient({ shopDomain, apiVersion, adminAccessToken: shopifyToken });
    const access = await client.verifyAccess();
    console.log(`Conectado a Shopify: ${access.shopName} (scopes: ${access.scopes.join(", ")})`);
    const summary = await importShopifyCatalog(client);
    console.log("Importación Shopify:", summary);
  } else {
    console.log("Shopify no configurado (faltan SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN) — se omite.");
  }

  const meliToken = process.env.MELI_ACCESS_TOKEN;
  if (meliToken) {
    const client = new MercadoLibreClient(meliToken);
    const summary = await importMercadoLibreCatalog(client);
    console.log("Importación Mercado Libre:", summary);
  } else {
    console.log("Mercado Libre no configurado (falta MELI_ACCESS_TOKEN de prueba) — se omite.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
