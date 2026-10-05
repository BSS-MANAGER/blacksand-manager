import { z } from "zod";
import { CHANNEL_CODES } from "./channels.js";

/** Campos mínimos por producto (sección E.2 de la especificación). */
export const ProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().min(1),
  barcode: z.string().nullable().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  weight: z.number().nonnegative().nullable().optional(),
  dimensions: z
    .object({
      largo: z.number().nonnegative().optional(),
      ancho: z.number().nonnegative().optional(),
      alto: z.number().nonnegative().optional(),
    })
    .nullable()
    .optional(),
  baseCost: z.number().nonnegative().nullable().optional(),
  basePrice: z.number().nonnegative().nullable().optional(),
  status: z.enum(["borrador", "publicado", "pausado", "con_error"]),
});
export type ProductInput = z.infer<typeof ProductSchema>;

export const ProductVariantSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  skuVariant: z.string().min(1),
  barcodeVariant: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  weightOverride: z.number().nonnegative().nullable().optional(),
});
export type ProductVariantInput = z.infer<typeof ProductVariantSchema>;

export const ChannelCodeSchema = z.enum(CHANNEL_CODES);

/** Credenciales que puede pedir la UI de Configuración (sección L.1). */
export const ShopifyCredentialsSchema = z.object({
  shopDomain: z
    .string()
    .regex(/^[a-z0-9-]+\.myshopify\.com$/i, "Debe ser un dominio *.myshopify.com"),
  apiVersion: z.string().regex(/^\d{4}-\d{2}$/, "Formato esperado AAAA-MM, ej. 2026-01"),
  adminAccessToken: z.string().min(10),
});
export type ShopifyCredentials = z.infer<typeof ShopifyCredentialsSchema>;

export const MercadoLibreCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  siteId: z.literal("MLC"),
});
export type MercadoLibreCredentials = z.infer<typeof MercadoLibreCredentialsSchema>;

export const MercadoLibreTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  userId: z.number(),
  expiresAt: z.string().datetime(),
});
export type MercadoLibreToken = z.infer<typeof MercadoLibreTokenSchema>;

/** Estado de sincronización mostrado en el dashboard (módulo 5, sección F.6). */
export const SyncStatusEnum = z.enum(["sincronizado", "pendiente", "error", "conflicto"]);
export type SyncStatus = z.infer<typeof SyncStatusEnum>;

export const ReconciliationDecisionSchema = z.object({
  centralVariantId: z.string().uuid(),
  channelCode: ChannelCodeSchema,
  channelProductId: z.string(),
  channelVariantId: z.string().nullable(),
  action: z.enum(["confirmar_match", "crear_nuevo", "ignorar"]),
});
export type ReconciliationDecision = z.infer<typeof ReconciliationDecisionSchema>;
