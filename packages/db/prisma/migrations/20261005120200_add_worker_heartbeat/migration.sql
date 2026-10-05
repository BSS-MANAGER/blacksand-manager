-- "Latido" del worker en la nube — ver packages/db/src/repositories/worker-heartbeat.repository.ts.
-- Idempotente (IF NOT EXISTS): el repositorio también la crea sola si hace falta.
CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMPTZ NOT NULL,
    "lastOkAt" TIMESTAMPTZ,
    "lastSummary" TEXT,
    "lastError" TEXT,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("key")
)
