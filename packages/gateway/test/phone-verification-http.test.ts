import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

import { SETUP_CODE_TTL_MS } from "../src/auth.ts";
import { PHONE_VERIFICATION_SCRIPT, runPhoneProof } from "../src/phone-verification-page.ts";
import { normalizeCanonicalOrigin, PhoneVerification } from "../src/phone-verification.ts";
import { openStorage } from "../src/storage.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { testHermes } from "./support/test-config.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  gateway = await startGateway({
    name: "phone-http", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes(),
  });
});

afterEach(async () => {
  await gateway.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

async function completeProbe(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
    const challenge = '{"type":"cozy_onboarding_probe"}';
    ws.on("open", () => ws.send(challenge));
    ws.on("message", (data) => {
      expect(String(data)).toBe(challenge);
      ws.close(); resolve();
    });
    ws.on("error", reject);
  });
}

describe("phone verification page", () => {
  it("exposes bounded operator status and cancellation without returning a capability", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture", startedAt: 1,
    });
    const verifier = new PhoneVerification({ storage, now: () => 1, monotonicNow: () => 1 });
    verifier.activate({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture",
    });
    const challenge = verifier.begin("tailscale");

    expect(verifier.status(challenge.challengeId)).toEqual({ state: "pending", expiresAt: challenge.expiresAt });
    expect(verifier.status(challenge.challengeId)).not.toHaveProperty("verificationUrl");
    expect(verifier.cancel(challenge.challengeId)).toBe(true);
    expect(verifier.status(challenge.challengeId)).toEqual({ state: "not_found" });
    expect(verifier.cancel(challenge.challengeId)).toBe(true);
    expect(() => verifier.begin("lan")).not.toThrow();

    verifier.close(); storage.close();
  });

  it("reads operator status from SQLite across processes and clears terminal or expired proof", () => {
    const directory = mkdtempSync(join(tmpdir(), `phone-verification-${randomUUID()}-`));
    const path = join(directory, "gateway.sqlite");
    const writer = openStorage(path);
    writer.beginGatewayBoot({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture", startedAt: 1,
    });
    const verifier = new PhoneVerification({ storage: writer, now: () => 1, monotonicNow: () => 1 });
    verifier.activate({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture",
    });
    const challenge = verifier.begin("tailscale");
    const reader = openStorage(path);
    const restarted = new PhoneVerification({ storage: reader, now: () => 2, monotonicNow: () => 2 });

    expect(restarted.status(challenge.challengeId)).toEqual({ state: "pending", expiresAt: challenge.expiresAt });
    expect(reader.onboardingLiveVerification(2)).toEqual({
      challengeId: challenge.challengeId,
      state: "active",
      expiresAt: challenge.expiresAt,
    });
    expect(reader.onboardingLiveVerification(challenge.expiresAt + 1)).toBeUndefined();
    expect(restarted.cancel(challenge.challengeId)).toBe(true);
    expect(verifier.status(challenge.challengeId)).toEqual({ state: "not_found" });
    expect(reader.onboardingLiveVerification(2)).toBeUndefined();

    restarted.close(); verifier.close(); reader.close(); writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("replaces an expired operator challenge repeatedly without restarting the Gateway", () => {
    const storage = openStorage(":memory:");
    const now = 1;
    let monotonicNow = 1;
    storage.beginGatewayBoot({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture", startedAt: now,
    });
    const verifier = new PhoneVerification({ storage, now: () => now, monotonicNow: () => monotonicNow });
    verifier.activate({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture",
    });
    const operatorContext = {
      canonicalOrigin: "https://gateway.example",
      durableFingerprint: "posture",
    };

    const first = verifier.begin("tailscale", operatorContext);
    monotonicNow += SETUP_CODE_TTL_MS + 1;
    const second = verifier.begin("tailscale", operatorContext);
    monotonicNow += SETUP_CODE_TTL_MS + 1;
    const third = verifier.begin("tailscale", operatorContext);

    expect(new Set([first.challengeId, second.challengeId, third.challengeId]).size).toBe(3);
    expect(new Set([first.verificationUrl, second.verificationUrl, third.verificationUrl]).size).toBe(3);
    expect(verifier.status(first.challengeId)).toEqual({ state: "not_found" });
    expect(verifier.status(second.challengeId)).toEqual({ state: "not_found" });
    expect(verifier.status(third.challengeId)).toEqual({ state: "pending", expiresAt: third.expiresAt });
    verifier.close(); storage.close();
  });

  it("distinguishes a challenge invalidated by a later Gateway boot", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot({
      bootGeneration: "boot-before", verificationEpoch: "epoch-before",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture", startedAt: 1,
    });
    const verifier = new PhoneVerification({ storage, now: () => 3, monotonicNow: () => 3 });
    verifier.activate({
      bootGeneration: "boot-before", verificationEpoch: "epoch-before",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture",
    });
    const challenge = verifier.begin("tailscale");

    storage.beginGatewayBoot({
      bootGeneration: "boot-after", verificationEpoch: "epoch-after",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture", startedAt: 2,
    });

    expect(verifier.status(challenge.challengeId)).toEqual({ state: "gateway_restarted" });
    verifier.close();
    storage.close();
  });

  it("does not relabel an already cancelled challenge as a Gateway restart", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot({
      bootGeneration: "boot-before", verificationEpoch: "epoch-before",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture", startedAt: 1,
    });
    const verifier = new PhoneVerification({ storage, now: () => 2, monotonicNow: () => 2 });
    verifier.activate({
      bootGeneration: "boot-before", verificationEpoch: "epoch-before",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture",
    });
    const challenge = verifier.begin("tailscale");
    expect(verifier.cancel(challenge.challengeId)).toBe(true);

    storage.beginGatewayBoot({
      bootGeneration: "boot-after", verificationEpoch: "epoch-after",
      canonicalOrigin: "https://gateway.example", durableFingerprint: "posture", startedAt: 3,
    });

    expect(verifier.status(challenge.challengeId)).toEqual({ state: "not_found" });
    verifier.close();
    storage.close();
  });

  it("normalizes literal default ports while preserving non-default ports", () => {
    expect(normalizeCanonicalOrigin("http://gateway.example:80")).toBe("http://gateway.example");
    expect(normalizeCanonicalOrigin("https://gateway.example:443")).toBe("https://gateway.example");
    expect(normalizeCanonicalOrigin("https://gateway.example:8443")).toBe("https://gateway.example:8443");
  });

  it.each([
    ["http://gateway.example:80", "http://gateway.example"],
    ["https://gateway.example:443", "https://gateway.example"],
  ])("serves a verifier activated with default-port origin %s at browser authority", async (configured, canonical) => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: canonical,
      durableFingerprint: "posture", startedAt: 1,
    });
    const verifier = new PhoneVerification({ storage, now: () => 1, monotonicNow: () => 1 });
    verifier.activate({
      bootGeneration: "boot", verificationEpoch: "epoch", canonicalOrigin: configured,
      durableFingerprint: "posture",
    });
    const challenge = verifier.begin();
    const response = await verifier.handleHttp(new Request(challenge.verificationUrl, {
      headers: { host: new URL(canonical).host },
    }), ["Host", new URL(canonical).host]);
    expect(response.status).toBe(200);
    verifier.close(); storage.close();
  });

  it("executes the emitted page workflow itself exactly once in a browser-like harness", async () => {
    expect(PHONE_VERIFICATION_SCRIPT).toContain("runPhoneProof");
    expect(PHONE_VERIFICATION_SCRIPT).not.toContain("cozy_onboarding_probed");
    const calls: string[] = [];
    const elements = { status: { textContent: "" }, phrase: { textContent: "", hidden: true } };
    class FakeWebSocket {
      listeners = new Map<string, Array<(event: { data?: string }) => void>>();
      constructor() { queueMicrotask(() => this.emit("open", {})); }
      addEventListener(name: string, fn: (event: { data?: string }) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
      }
      send(frame: string) {
        calls.push("probe");
        queueMicrotask(() => this.emit("message", { data: frame }));
      }
      close() {}
      emit(name: string, event: { data?: string }) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
    }
    runInNewContext(PHONE_VERIFICATION_SCRIPT, {
      location: { pathname: "/cozy/onboarding/cap", protocol: "https:", host: "gateway.example" },
      history: { replaceState: () => calls.push("history") },
      document: { getElementById: (id: "status" | "phrase") => elements[id] },
      fetch: async (path: string) => {
        calls.push(path === "/health" ? "health" : "confirm");
        return { ok: true, json: async () => ({ phrase: "amber kite" }) };
      },
      WebSocket: FakeWebSocket, TextEncoder, setTimeout, clearTimeout, queueMicrotask,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["history", "health", "probe", "confirm"]);
    expect(elements.phrase).toMatchObject({ textContent: "amber kite", hidden: false });
  });
  it("is inert, self-contained, and strips the capability before automatically running proof", async () => {
    const challenge = gateway.beginPhoneVerification();
    expect(challenge.verificationUrl).not.toContain(challenge.phrase);
    expect(challenge).not.toHaveProperty("setupCode");
    const response = await fetch(challenge.verificationUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain(challenge.phrase);
    expect(html).not.toMatch(/<button|https?:\/\/(?!127\.0\.0\.1)/i);

    await completeProbe(challenge.verificationUrl);
    const confirmed = await fetch(`${challenge.verificationUrl}/confirm`, {
      method: "POST",
      headers: { origin: gateway.url, "content-type": "application/json" },
      body: JSON.stringify({ type: "confirm" }),
    });
    expect(await confirmed.json()).toEqual({ phrase: challenge.phrase });
  });

  it("keeps HEAD, OPTIONS, and repeated GET inert", async () => {
    const challenge = gateway.beginPhoneVerification();
    expect((await fetch(challenge.verificationUrl, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(challenge.verificationUrl, { method: "OPTIONS" })).status).toBe(204);
    expect((await fetch(challenge.verificationUrl)).status).toBe(200);
    expect((await fetch(challenge.verificationUrl)).status).toBe(200);
    await completeProbe(challenge.verificationUrl);
  });
});

describe("runPhoneProof", () => {
  it("runs health, probe, confirm, and phrase display exactly once in order", async () => {
    const calls: string[] = [];
    const result = await runPhoneProof({
      health: async () => { calls.push("health"); },
      openProbe: async () => { calls.push("probe"); },
      confirm: async () => { calls.push("confirm"); return { phrase: "amber kite" }; },
      showPhrase: (phrase) => { calls.push(`show:${phrase}`); },
    });
    expect(result).toBe("confirmed");
    expect(calls).toEqual(["health", "probe", "confirm", "show:amber kite"]);
  });

  it.each(["health", "probe", "confirm"] as const)("stops after a failed %s step", async (failed) => {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
      if (name === failed) throw new Error("offline");
    };
    const showPhrase = vi.fn();
    expect(await runPhoneProof({
      health: step("health"),
      openProbe: step("probe"),
      confirm: async () => { await step("confirm")(); return { phrase: "never" }; },
      showPhrase,
    })).toBe("failed");
    expect(calls).toEqual(failed === "health" ? ["health"] : failed === "probe" ? ["health", "probe"] : ["health", "probe", "confirm"]);
    expect(showPhrase).not.toHaveBeenCalled();
  });
});
