import { mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { testHermes } from "./support/test-config.ts";

const TOKEN = "D".repeat(43);
const gateways: RunningGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-operator-server-"));
  const tokenPath = join(directory, "operator-control.token");
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  return { tokenPath, dbPath: join(directory, "gateway.sqlite") };
}

async function gateway(input: { dbPath: string; tokenPath?: string; host?: string }) {
  const running = await startGateway({
    name: "operator-control", host: input.host ?? "127.0.0.1", port: 0,
    dbPath: input.dbPath, turnTimeoutSeconds: 0, hermes: testHermes(),
    ...(input.tokenPath === undefined ? {} : { onboardingControlTokenFile: input.tokenPath }),
  });
  gateways.push(running);
  return running;
}

function control(running: RunningGateway, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${running.url}/cozy/operator/onboarding`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function beginBody(running: RunningGateway, mode: "tailscale" | "lan") {
  return { action: "begin", mode, canonicalOrigin: running.url, durableFingerprint: `posture-${mode}` };
}

async function probe(running: RunningGateway, verificationUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${verificationUrl.replace(/^http/, "ws")}/probe`, { origin: running.url });
    const frame = '{"type":"cozy_onboarding_probe"}';
    socket.on("open", () => socket.send(frame));
    socket.on("message", (data) => {
      if (String(data) !== frame) return reject(new Error("wrong echo"));
      socket.close(); resolve();
    });
    socket.on("error", reject);
  });
}

describe("running Gateway operator onboarding control", () => {
  it("rejects a non-loopback control request even on a wildcard LAN listener", async ({ skip }) => {
    const lanAddress = Object.values(networkInterfaces()).flat()
      .find((address) => address?.family === "IPv4" && !address.internal)?.address;
    if (lanAddress === undefined) skip();
    const { dbPath, tokenPath } = fixture();
    const running = await gateway({ dbPath, tokenPath, host: "0.0.0.0" });
    const response = await fetch(`http://${lanAddress}:${running.port}/cozy/operator/onboarding`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(beginBody(running, "lan")),
    });
    expect(response.status).toBe(404);
  });

  it("rebases a new challenge to the adapter-proven final origin and posture", async () => {
    const { dbPath, tokenPath } = fixture();
    const running = await gateway({ dbPath, tokenPath });
    const response = await control(running, {
      action: "begin",
      mode: "tailscale",
      canonicalOrigin: "https://cozy-personal.example.ts.net",
      durableFingerprint: "tailscale-posture-a",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verificationUrl: expect.stringMatching(/^https:\/\/cozy-personal\.example\.ts\.net\/cozy\/onboarding\//),
    });
  });

  it("is absent unless a valid token file is configured", async () => {
    const { dbPath } = fixture();
    const running = await gateway({ dbPath });
    expect((await control(running, beginBody(running, "lan"))).status).toBe(404);
  });

  it("makes disabled, wrong-method, and bad-auth failures externally identical", async () => {
    const { dbPath, tokenPath } = fixture();
    const disabled = await gateway({ dbPath });
    const enabled = await gateway({ dbPath: `${dbPath}.enabled`, tokenPath });
    const requests = [
      control(disabled, beginBody(disabled, "lan")),
      fetch(`${enabled.url}/cozy/operator/onboarding`, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      control(enabled, beginBody(enabled, "lan"), "E".repeat(43)),
    ];
    const failures = await Promise.all(await Promise.all(requests).then((responses) => responses.map(async (response) => ({
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    }))));

    expect(failures).toEqual(Array.from({ length: 3 }, () => ({
      status: 404,
      contentType: "application/json",
      cacheControl: "no-store",
      body: '{"error":"not_found"}',
    })));
  });

  it("requires the token and returns only the connectivity URL until the phone confirms", async () => {
    const { dbPath, tokenPath } = fixture();
    const running = await gateway({ dbPath, tokenPath, host: "0.0.0.0" });
    expect((await control(running, beginBody(running, "tailscale"), "E".repeat(43))).status).toBe(404);

    const begun = await control(running, beginBody(running, "tailscale"));
    expect(begun.status).toBe(200);
    const body = await begun.json() as {
      challengeId: string; sessionId: string; verificationUrl: string; expiresAt: number; state: string;
    };
    expect(body).toMatchObject({ state: "pending" });
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.verificationUrl).toMatch(/\/cozy\/onboarding\/[A-Za-z0-9_-]{43}$/);
    expect(body).not.toHaveProperty("phrase");
    expect(body).not.toHaveProperty("setupCode");

    await probe(running, body.verificationUrl);
    const confirmed = await fetch(`${body.verificationUrl}/confirm`, {
      method: "POST",
      headers: { origin: running.url, "content-type": "application/json" },
      body: '{"type":"confirm"}',
    });
    expect(confirmed.status).toBe(200);
    expect(await (await control(running, { action: "status", challengeId: body.challengeId })).json())
      .toMatchObject({ state: "confirmed", phrase: expect.any(String) });
  });

  it("admits one begin, supports idempotent cancel, and allows a clean retry", async () => {
    const { dbPath, tokenPath } = fixture();
    const running = await gateway({ dbPath, tokenPath });
    const [left, right] = await Promise.all([
      control(running, beginBody(running, "lan")),
      control(running, beginBody(running, "lan")),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const winner = left.status === 200 ? left : right;
    const { challengeId, verificationUrl } = await winner.json() as { challengeId: string; verificationUrl: string };

    expect((await control(running, { action: "cancel", challengeId })).status).toBe(200);
    expect((await control(running, { action: "cancel", challengeId })).status).toBe(200);
    expect((await fetch(verificationUrl)).status).toBe(404);
    expect((await control(running, beginBody(running, "lan"))).status).toBe(200);
  });

  it("does not resurrect a challenge across a Gateway restart", async () => {
    const { dbPath, tokenPath } = fixture();
    const first = await gateway({ dbPath, tokenPath });
    const { challengeId } = await (await control(first, beginBody(first, "tailscale"))).json() as { challengeId: string };
    await first.close();
    gateways.splice(gateways.indexOf(first), 1);

    const second = await gateway({ dbPath, tokenPath });
    const stale = await control(second, { action: "status", challengeId });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ state: "not_found" });
    expect((await control(second, beginBody(second, "tailscale"))).status).toBe(200);
  });
});
