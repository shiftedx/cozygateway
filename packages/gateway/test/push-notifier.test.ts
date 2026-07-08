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
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify({
      threadId: "t",
      agentName: "A",
      preview: "p",
    });
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
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify({
      threadId: "t1",
      agentName: "Agent",
      preview: "hello",
    });
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
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify({
      threadId: "t",
      agentName: "A",
      preview: "x".repeat(PREVIEW_MAX_CHARS + 50),
    });
    await settle();
    expect(decrypt("k", sent[0]?.body.ciphertext ?? "").preview).toBe("x".repeat(PREVIEW_MAX_CHARS));
    storage.close();
  });

  it("prunes exactly the registration a relay 404s and keeps the others", async () => {
    const storage = seeded([
      { deviceId: "d1", pushId: "p1", relayUrl: "http://gone.test", pushKey: "k1" },
      { deviceId: "d2", pushId: "p2", relayUrl: "http://alive.test", pushKey: "k2" },
    ]);
    const { impl } = fetchStub((url) => (url.startsWith("http://gone.test") ? 404 : 202));
    new RelayNotifier({ storage, fetchImpl: impl, log: () => {} }).notify({ threadId: "t", agentName: "A", preview: "p" });
    await settle();
    expect(storage.pushRegistrations().map((r) => r.deviceId)).toEqual(["d2"]);
    storage.close();
  });

  it("keeps the registration on 429, 500, and network error, and never throws", async () => {
    for (const outcome of [429, 500, "reject"] as const) {
      const storage = seeded([{ deviceId: "d1", pushId: "p1", relayUrl: "http://r.test", pushKey: "k" }]);
      const { impl } = fetchStub(() => outcome);
      const notifier = new RelayNotifier({ storage, fetchImpl: impl, log: () => {} });
      expect(() => notifier.notify({ threadId: "t", agentName: "A", preview: "p" })).not.toThrow();
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
    expect(() => notifier.notify({ threadId: "t", agentName: "A", preview: "p" })).not.toThrow();
  });
});
