-- "Descuentos": precio normal guardado por variante de Shopify (ver el
-- comentario del modelo VariantPriceBaseline en schema.prisma). Idempotente a
-- propósito (IF NOT EXISTS): el repositorio también la crea sola si hace falta.
CREATE TABLE IF NOT EXISTS "VariantPriceBaseline" (
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "sku" TEXT,
    "baselinePrice" DOUBLE PRECISION NOT NULL,
    "lastAppliedPrice" DOUBLE PRECISION,
    "lastAppliedCompareAt" DOUBLE PRECISION,
    "prevPrice" DOUBLE PRECISION,
    "prevCompareAt" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantPriceBaseline_pkey" PRIMARY KEY ("variantGid")
)
