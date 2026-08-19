import { expect } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import type { BackendSession } from "../../src/adapters/types.ts";

/** Optional-chained capability calls (`await session.steer?.(blocks)`) are a test-robustness trap:
 *  if the method ever vanished from a steer-capable adapter the call would silently no-op, and the
 *  test would then either pass vacuously or hang awaiting a turn nothing ever drove -- never
 *  reporting the missing method. These helpers assert presence FIRST and hand back a bound call,
 *  so a vanished capability fails at the call site with its own name in the message. */
export function requireSteer(
  session: BackendSession,
): (blocks: RichBlock[]) => Promise<boolean | void> {
  const steer = session.steer;
  expect(typeof steer).toBe("function");
  if (steer === undefined) throw new Error("session.steer is missing on a steer-capable session");
  return (blocks) => steer.call(session, blocks);
}

export function requireInterrupt(session: BackendSession): () => Promise<void> {
  const interrupt = session.interrupt;
  expect(typeof interrupt).toBe("function");
  if (interrupt === undefined) {
    throw new Error("session.interrupt is missing on a steer-capable session");
  }
  return () => interrupt.call(session);
}
