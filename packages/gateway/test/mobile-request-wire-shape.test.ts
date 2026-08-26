import { describe, it, expect } from "vitest";

import { check, MobileNodeRequestFrameSchema } from "cozygateway-contract";
import { vi } from "vitest";

import { MobileNodeBroker } from "../src/mobile-node.ts";

/**
 * The phone validates the EXACT key set of a `mobile_node_request` and drops anything carrying an
 * extra key without a word: no error frame, no log, nothing. The gateway then waits out its own
 * timer and reports `expired`, so a single stray key reads as "the phone ignored us" from one end
 * and "nothing happened" from the other.
 *
 * That is exactly what shipped. The attach envelope's `kind` was spread onto the wire frame beside
 * the fields that belong there, and every phone-node request died in silence for it.
 */

/** What the data plane hands the broker, straight off the attach connection. */
const attachFrame = {
  kind: "mobile_request" as const,
  requestId: "request-1",
  command: "device.status" as const,
  threadId: "thread-1",
  turnId: "turn-1",
  expiresAt: 1_787_790_000_000,
  purpose: "Report phone readiness",
};

const lease = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

describe("the frame the phone actually receives", () => {
  it("carries no key the contract does not name", () => {
    const { kind: _kind, ...request } = attachFrame;
    const frame = { type: "mobile_node_request", lease, bot: "cleo", ...request };
    expect(check(MobileNodeRequestFrameSchema, frame)).toBe(true);
  });

  it("is rejected outright when an envelope key leaks onto it", () => {
    // Spreading the attach frame whole is the bug, reproduced. The schema closes its key set, so
    // this is the check the phone would apply, applied before the frame is ever sent.
    const frame = { type: "mobile_node_request", lease, bot: "cleo", ...attachFrame };
    expect(check(MobileNodeRequestFrameSchema, frame)).toBe(false);
  });
});

describe("the broker's own dispatch", () => {
  const route = () => ({
    status: "available" as const, selectedSocketPresent: true, selectedSocketOpen: true,
    commandAdvertised: true, connectedSocketCount: 1, foreground: true,
  });

  function brokerWith(send: ReturnType<typeof vi.fn>, result: ReturnType<typeof vi.fn>) {
    return new MobileNodeBroker({ route, send, result, receipt: () => true, now: () => 1_000 });
  }

  const base = {
    requestId: "request-1", bot: "cleo", threadId: "thread-1", turnId: "turn-1",
    purpose: "Report phone readiness", deviceId: "origin", agentId: "cleo",
    expiresAt: 2_000, command: "device.status" as const,
  };

  it("sends a frame the phone can accept", () => {
    const send = vi.fn((_deviceId: string, _frame: unknown) => true),
      result = vi.fn((_agentId: string, _frame: unknown) => {});
    brokerWith(send, result).invoke(base);
    const frame = send.mock.calls.at(-1)?.[1];
    expect(frame, "no frame was sent").toBeDefined();
    expect(check(MobileNodeRequestFrameSchema, frame)).toBe(true);
  });

  it("refuses to send one carrying a key the contract forbids, and says so", () => {
    const send = vi.fn((_deviceId: string, _frame: unknown) => true),
      result = vi.fn((_agentId: string, _frame: unknown) => {});
    // `kind` is an attach-envelope key. It reached the wire once, and the phone answered by
    // dropping every request in silence for it.
    brokerWith(send, result).invoke({ ...base, kind: "mobile_request" } as never);
    expect(send).not.toHaveBeenCalled();
    expect(result.mock.calls.at(-1)?.[1]).toMatchObject({
      requestId: "request-1", status: "policy_blocked",
    });
  });
});
