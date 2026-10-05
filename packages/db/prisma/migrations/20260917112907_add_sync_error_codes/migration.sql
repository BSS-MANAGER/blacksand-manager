-- AlterTable
ALTER TABLE "ChannelProductMap" ADD COLUMN "lastErrorCode" TEXT;

-- AlterTable
ALTER TABLE "ChannelSyncStatus" ADD COLUMN "lastErrorCode" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "lastSyncErrorCode" TEXT;
