import { randomUUID } from "node:crypto";
import { releaseLease, tryAcquireLease } from "@blacksand/db";

/**
 * Corre `fn` solo si este proceso consigue el turno de sondeo de pedidos (ver
 * `poll-lease.repository.ts` en @blacksand/db). Si otro proceso — la app de
 * escritorio o el worker en la nube — ya lo tiene, NO corre y devuelve
 * `{ ran: false }`: esa pasada la está haciendo el otro.
 *
 * `who` solo sirve para identificar al dueño en la base ("app" / "cloud-worker").
 * El turno vence solo a los 10 min por si el proceso se cae a mitad de camino.
 */
export const ORDER_POLL_LEASE_KEY = "order-poll";
const LEASE_TTL_SECONDS = 10 * 60;

export type LeaseResult<T> = { ran: true; value: T } | { ran: false };

export async function withOrderPollLease<T>(who: string, fn: () => Promise<T>): Promise<LeaseResult<T>> {
  const holder = `${who}:${randomUUID()}`;
  const acquired = await tryAcquireLease(ORDER_POLL_LEASE_KEY, holder, LEASE_TTL_SECONDS);
  if (!acquired) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await releaseLease(ORDER_POLL_LEASE_KEY, holder).catch(() => undefined);
  }
}
