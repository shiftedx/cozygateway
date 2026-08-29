import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

import { PHONE_VERIFICATION_SCRIPT, runPhoneProof } from "../src/phone-verification-page.ts";
import { normalizeCanonicalOrigin } from "../src/phone-verification.ts";
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
    const messages: string[] = [];
    ws.on("message", (data) => {
      messages.push(String(data));
      if (messages.length === 2) {
        expect(messages).toEqual([challenge, '{"type":"cozy_onboarding_probed"}']);
        ws.close(); resolve();
      }
    });
    ws.on("error", reject);
  });
}

describe("phone verification page", () => {
  it("normalizes literal default ports while preserving non-default ports", () => {
    expect(normalizeCanonicalOrigin("http://gateway.example:80")).toBe("http://gateway.example");
    expect(normalizeCanonicalOrigin("https://gateway.example:443")).toBe("https://gateway.example");
    expect(normalizeCanonicalOrigin("https://gateway.example:8443")).toBe("https://gateway.example:8443");
  });

  it("executes the emitted page workflow itself exactly once in a browser-like harness", async () => {
    expect(PHONE_VERIFICATION_SCRIPT).toContain("runPhoneProof");
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
        queueMicrotask(() => this.emit("message", { data: '{"type":"cozy_onboarding_probed"}' }));
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
