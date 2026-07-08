import { createDecipheriv, hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";
import { PREVIEW_MAX_CHARS, RelayNotifier } from "../src/push-notifier.ts";

function decrypt(pushKey: string, wire: string): { threadId: string; agentName: string; preview: string } {
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(pushKey, "utf8"), Buffer.alloc(0), Buffer.from("cozygateway-push-v0", "utf8"), 32),
  );
  const raw = Buffer.from(wire, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as { threadId: string; agentName: string; preview: string };
}

interface Sent {
  url: string;
  body: { pushId: string; ciphertext: string };
}

/** fetch stub: returns per-URL statuses, records calls. */
function fetchStub(statusFor: (url: string) => number | "reject"): { impl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const status = statusFor(url);
    sent.push({ url, body: JSON.parse(String(init?.body)) as Sent["body"] });
    if (status === "reject") throw new Error("network down");
    return new Response(null, { status });
  }) as typeof fetch;
  return { impl, sent };
}

function seeded(regs: Array<{ deviceId: string; pushId: string; relayUrl: string; pushKey: string }>) {
  const storage = openStorage(":memory:");
  for (const [i, reg] of regs.entries()) {
    storage.createDevice({ id: reg.deviceId, name: `dev${i}`, tokenHash: `h${i}`, createdAt: i });
    storage.savePushRegistration(reg.deviceId, { pushId: reg.pushId, relayUrl: reg.relayUrl, pushKey: reg.pushKey });
  }
  return storage;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("RelayNotifier", () => {
  it("is a no-op with zero registrations", async () => {
    const storage = seeded([]);
    const { impl, sent } = fetchStub(() => 202);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      {
        threadId: "t",
        agentName: "A",
        preview: "p",
      },
      new Set(),
    );
    await settle();
    expect(sent).toHaveLength(0);
    storage.close();
  });

  it("fans out one encrypted notify per registration, joining relayUrl with and without a trailing slash", async () => {
    const storage = seeded([
      { deviceId: "d1", pushId: "p1", relayUrl: "http://relay-a.test", pushKey: "key-1" },
      { deviceId: "d2", pushId: "p2", relayUrl: "http://relay-b.test/", pushKey: "key-2" },
    ]);
    const { impl, sent } = fetchStub(() => 202);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      {
        threadId: "t1",
        agentName: "Agent",
        preview: "hello",
      },
      new Set(),
    );
    await settle();
    expect(sent.map((s) => s.url).sort()).toEqual(["http://relay-a.test/notify", "http://relay-b.test/notify"]);
    const forP1 = sent.find((s) => s.body.pushId === "p1");
    expect(forP1).toBeDefined();
    expect(decrypt("key-1", forP1?.body.ciphertext ?? "")).toEqual({
      threadId: "t1",
      agentName: "Agent",
      preview: "hello",
    });
    storage.close();
  });

  it("truncates the preview to PREVIEW_MAX_CHARS", async () => {
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      {
        threadId: "t",
        agentName: "A",
        preview: "x".repeat(PREVIEW_MAX_CHARS + 50),
      },
      new Set(),
    );
    await settle();
    expect(decrypt("k", sent[0]?.body.ciphertext ?? "").preview).toBe("x".repeat(PREVIEW_MAX_CHARS));
    storage.close();
  });

  it("truncates on a code-point boundary instead of splitting a surrogate pair", async () => {
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    // U+1F600 is an astral character encoded as a high/low surrogate pair. Placed so its high
    // surrogate lands exactly at UTF-16 index PREVIEW_MAX_CHARS - 1, a naive `.slice(0,
    // PREVIEW_MAX_CHARS)` cuts between the pair, leaving a lone high surrogate that would
    // serialize as U+FFFD (replacement character) instead of dropping the whole character.
    const astral = "\u{1f600}";
    const preview = "x".repeat(PREVIEW_MAX_CHARS - 1) + astral + "y".repeat(50);
    expect(preview.charCodeAt(PREVIEW_MAX_CHARS - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(preview.charCodeAt(PREVIEW_MAX_CHARS - 1)).toBeLessThanOrEqual(0xdbff);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      {
        threadId: "t",
        agentName: "A",
        preview,
      },
      new Set(),
    );
    await settle();
    const delivered = decrypt("k", sent[0]?.body.ciphertext ?? "").preview;
    expect(delivered).toBe("x".repeat(PREVIEW_MAX_CHARS - 1));
    expect(delivered).not.toContain("�");
    expect(/[\ud800-\udbff]$/.test(delivered)).toBe(false);
    storage.close();
  });

  it("prunes exactly the registration a relay 404s and keeps the others", async () => {
    const storage = seeded([
      { deviceId: "d1", pushId: "p1", relayUrl: "http://gone.test", pushKey: "k1" },
      { deviceId: "d2", pushId: "p2", relayUrl: "http://alive.test", pushKey: "k2" },
    ]);
    const { impl, sent } = fetchStub((url) => (url.startsWith("http://gone.test") ? 404 : 202));
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      { threadId: "t", agentName: "A", preview: "p" },
      new Set(),
    );
    await settle();
    expect(storage.pushRegistrations().map((r) => r.deviceId)).toEqual(["d2"]);
    // Self-contained: the surviving registration's POST actually fired, rather than relying on
    // the separate fan-out test above to establish that.
    expect(sent.find((s) => s.body.pushId === "p2")).toBeDefined();
    expect(sent.some((s) => s.body.pushId === "p1")).toBe(true);
    storage.close();
  });

  it("keeps the registration on 429, 500, and network error, and never throws", async () => {
    for (const outcome of [429, 500, "reject"] as const) {
      const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
      const { impl } = fetchStub(() => outcome);
      const notifier = new RelayNotifier({ storage, fetchImpl: impl, log: () => {} });
      expect(() => notifier.notify({ threadId: "t", agentName: "A", preview: "p" }, new Set())).not.toThrow();
      await settle();
      expect(storage.pushRegistrations()).toHaveLength(1);
      storage.close();
    }
  });

  it("does not throw even when reading registrations fails", () => {
    const storage = seeded([]);
    storage.close(); // closed db: pushRegistrations() will throw inside notify
    const { impl } = fetchStub(() => 202);
    const notifier = new RelayNotifier({ storage, fetchImpl: impl, log: () => {} });
    expect(() => notifier.notify({ threadId: "t", agentName: "A", preview: "p" }, new Set())).not.toThrow();
  });

  it("skips registrations for connected devices, still sends to disconnected ones", async () => {
    const storage = seeded([
      { deviceId: "d1", pushId: "p1", relayUrl: "http://relay-a.test", pushKey: "key-1" },
      { deviceId: "d2", pushId: "p2", relayUrl: "http://relay-b.test", pushKey: "key-2" },
    ]);
    const { impl, sent } = fetchStub(() => 202);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      { threadId: "t", agentName: "A", preview: "p" },
      new Set(["d1"]), // d1 has a live socket at commit time; d2 does not
    );
    await settle();
    expect(sent.some((s) => s.body.pushId === "p1")).toBe(false);
    const forP2 = sent.find((s) => s.body.pushId === "p2");
    expect(forP2).toBeDefined();
    expect(decrypt("key-2", forP2?.body.ciphertext ?? "")).toEqual({ threadId: "t", agentName: "A", preview: "p" });
    storage.close();
  });

  it("is a no-op when every registration's device is in the connected set", async () => {
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify(
      { threadId: "t", agentName: "A", preview: "p" },
      new Set(["d1"]),
    );
    await settle();
    expect(sent).toHaveLength(0);
    storage.close();
  });

  it("late isDeviceConnected check suppresses the send without pruning the registration", async () => {
    // Narrows (rather than closes) the race from issue #11: the commit-time snapshot passed
    // to notify() missed this device (it isn't in the Set below), but the live isDeviceConnected
    // recheck immediately before the fetch reports it connected by then. The send must be
    // skipped, and unlike a relay 404 this is not a reason to prune the registration: the
    // device is fine, it just doesn't need a push anymore.
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    const notifier = new RelayNotifier({
      storage,
      fetchImpl: impl,
      log: () => {},
      isDeviceConnected: (deviceId) => deviceId === "d1",
    });
    notifier.notify({ threadId: "t", agentName: "A", preview: "p" }, new Set()); // stale snapshot: d1 absent
    await settle();
    expect(sent).toHaveLength(0);
    expect(storage.pushRegistrations().map((r) => r.deviceId)).toEqual(["d1"]);
    storage.close();
  });

  it("still sends when isDeviceConnected is provided but reports the device disconnected", async () => {
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    const notifier = new RelayNotifier({
      storage,
      fetchImpl: impl,
      log: () => {},
      isDeviceConnected: () => false,
    });
    notifier.notify({ threadId: "t", agentName: "A", preview: "p" }, new Set());
    await settle();
    expect(sent.find((s) => s.body.pushId === "p1")).toBeDefined();
    storage.close();
  });

  it("defers the send one macrotask so the recheck observes presence flipped by an already-queued event", async () => {
    // Race regression for issue #11, deterministic form. The real race: a WS auth frame is
    // already sitting in the socket's event queue when a commit fires, so the commit-time
    // snapshot misses the device, but the hub processes the auth (a macrotask) before the
    // deferred send runs its recheck. The queued setImmediate below stands in for that queued
    // auth frame: it is scheduled BEFORE notify() is called, exactly like an auth frame that
    // arrived before the commit, and only it flips presence to connected. This test fails if
    // #send rechecks synchronously instead of yielding one macrotask first: the recheck would
    // read `connected === false` and the POST would fire.
    const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
    const { impl, sent } = fetchStub(() => 202);
    let connected = false;
    const notifier = new RelayNotifier({
      storage,
      fetchImpl: impl,
      log: () => {},
      isDeviceConnected: () => connected,
    });
    setImmediate(() => {
      connected = true; // the "auth frame" ahead of the deferred send in the macrotask queue
    });
    notifier.notify({ threadId: "t", agentName: "A", preview: "p" }, new Set()); // snapshot misses d1
    expect(connected).toBe(false); // the commit-time decision really did run before the flip
    await settle();
    expect(sent).toHaveLength(0);
    expect(storage.pushRegistrations().map((r) => r.deviceId)).toEqual(["d1"]); // no pruning on skip
    storage.close();
  });
});
