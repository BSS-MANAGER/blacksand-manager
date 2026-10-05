-- CreateTable
CREATE TABLE "MeliCategoryGroupMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupKey" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "listingTypeId" TEXT NOT NULL,
    "attributeDefaults" TEXT NOT NULL DEFAULT '[]',
    "emptyGtinAttributeId" TEXT,
    "emptyGtinValueId" TEXT,
    "emptyGtinValueName" TEXT,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MeliCategoryGroupMapping_groupKey_key" ON "MeliCategoryGroupMapping"("groupKey");
