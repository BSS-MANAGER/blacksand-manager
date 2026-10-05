-- Turno de sondeo compartido entre la app de escritorio y el worker en la nube — ver
-- packages/db/src/repositories/poll-lease.repository.ts. Idempotente (IF NOT EXISTS):
-- el repositorio también la crea sola si hace falta.
CREATE TABLE IF NOT EXISTS "PollLease" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PollLease_pkey" PRIMARY KEY ("key")
)
