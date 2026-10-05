-- Token vivo de un canal (Mercado Libre) compartido entre la app de escritorio y el
-- worker en la nube — ver packages/db/src/repositories/channel-live-token.repository.ts.
-- Idempotente a propósito (IF NOT EXISTS): el repositorio también la crea sola si hace falta.
CREATE TABLE IF NOT EXISTS "ChannelLiveToken" (
    "channelCode" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLiveToken_pkey" PRIMARY KEY ("channelCode")
);

-- Si la tabla ya existía sin esta columna (borrador anterior), se agrega.
ALTER TABLE "ChannelLiveToken" ADD COLUMN IF NOT EXISTS "userId" TEXT;
