-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT,
    "channelOrderId" TEXT,
    "orderDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "subtotal" REAL NOT NULL DEFAULT 0,
    "discounts" REAL NOT NULL DEFAULT 0,
    "taxes" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'pendiente',
    "cancelledAt" DATETIME,
    "restocked" BOOLEAN,
    "cancelReason" TEXT,
    "stockDeducted" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Order_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("channelId", "channelOrderId", "customerId", "discounts", "id", "orderDate", "paymentMethod", "status", "subtotal", "syncStatus", "taxes", "total") SELECT "channelId", "channelOrderId", "customerId", "discounts", "id", "orderDate", "paymentMethod", "status", "subtotal", "syncStatus", "taxes", "total" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_channelId_channelOrderId_key" ON "Order"("channelId", "channelOrderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
