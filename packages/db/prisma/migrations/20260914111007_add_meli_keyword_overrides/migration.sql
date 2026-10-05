-- CreateTable
CREATE TABLE "MeliCategoryKeywordOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyword" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MeliCategoryKeywordOverride_keyword_key" ON "MeliCategoryKeywordOverride"("keyword");
