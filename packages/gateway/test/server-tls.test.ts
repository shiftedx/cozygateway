import { once } from "node:events";
import { join } from "node:path";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayInfo } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { generateSelfSigned, writeGarbage } from "./helpers/self-signed.ts";

const running: RunningGateway[] = [];

beforeEach(() => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
});

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

function baseConfig(): Parameters<typeof startGateway>[0] {
  return {
    name: "tls-gw",
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermes: testHermes(),
  };
}

/** A GET that trusts exactly the fixture's certificate. Node's global fetch has no per-call CA
 *  hook, so this goes through node:https rather than weakening verification. */
function getJson(url: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { agent: new HttpsAgent({ ca, keepAlive: false }) }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("gateway-native TLS", () => {
  it("serves HTTPS on the provided pair, and its WS endpoint over wss", async () => {
    const pair = generateSelfSigned();
    const gateway = await startGateway({
      ...baseConfig(),
      tls: { certFile: pair.certFile, keyFile: pair.keyFile },
    });
    running.push(gateway);

    expect(gateway.url.startsWith("https://")).toBe(true);

    const health = await getJson(`${gateway.url}/health`, pair.certPem);
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as GatewayInfo).name).toBe("tls-gw");

    // The client-side scheme derivation the app and the tests share (`http` -> `ws`) has to land
    // on wss for an https gateway, or every paired device silently talks plaintext to a TLS port.
    const wsUrl = `${gateway.url.replace("http", "ws")}/ws`;
    expect(wsUrl.startsWith("wss://")).toBe(true);
    const ws = new WebSocket(wsUrl, { ca: pair.certPem });
    await once(ws, "open");
    ws.close();
  });

  it("keeps plain HTTP byte-for-byte when no TLS is configured", async () => {
    const gateway = await startGateway(baseConfig());
    running.push(gateway);
    expect(gateway.url.startsWith("http://")).toBe(true);
    const res = await fetch(`${gateway.url}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as GatewayInfo).name).toBe("tls-gw");
  });

  it("fails loudly at startup on a present-but-broken pair, without binding a listener", async () => {
    const pair = generateSelfSigned();
    const garbage = writeGarbage(pair.dir, "broken.pem");
    await expect(
      startGateway({ ...baseConfig(), tls: { certFile: garbage, keyFile: pair.keyFile } }),
    ).rejects.toThrow(/broken\.pem/);
  });

  it("fails loudly at startup when the cert file is absent", async () => {
    const pair = generateSelfSigned();
    await expect(
      startGateway({ ...baseConfig(), tls: { certFile: join(pair.dir, "gone.pem"), keyFile: pair.keyFile } }),
    ).rejects.toThrow(/gone\.pem/);
  });
});
