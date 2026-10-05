-- CreateTable
CREATE TABLE "MeliSkuPrefixBrandOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skuPrefix" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MeliSkuPrefixBrandOverride_skuPrefix_key" ON "MeliSkuPrefixBrandOverride"("skuPrefix");
