-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MeliCategoryGroupMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupKey" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "listingTypeId" TEXT NOT NULL,
    "attributeDefaults" TEXT NOT NULL DEFAULT '[]',
    "emptyGtinAttributeId" TEXT,
    "emptyGtinValueId" TEXT,
    "emptyGtinValueName" TEXT,
    "forceStandardSize" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_MeliCategoryGroupMapping" ("attributeDefaults", "categoryId", "categoryName", "confirmedAt", "createdAt", "emptyGtinAttributeId", "emptyGtinValueId", "emptyGtinValueName", "groupKey", "id", "listingTypeId", "updatedAt") SELECT "attributeDefaults", "categoryId", "categoryName", "confirmedAt", "createdAt", "emptyGtinAttributeId", "emptyGtinValueId", "emptyGtinValueName", "groupKey", "id", "listingTypeId", "updatedAt" FROM "MeliCategoryGroupMapping";
DROP TABLE "MeliCategoryGroupMapping";
ALTER TABLE "new_MeliCategoryGroupMapping" RENAME TO "MeliCategoryGroupMapping";
CREATE UNIQUE INDEX "MeliCategoryGroupMapping_groupKey_key" ON "MeliCategoryGroupMapping"("groupKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
