import { createServer, type Http2Server } from "node:http2";
import { once } from "node:events";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { apnsConfigFromEnv, apnsTransport, buildProviderJwt, type ApnsConfig } from "../src/apns.ts";

function testConfig(): { config: ApnsConfig; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey,
    config: {
      keyP8: String(privateKey.export({ format: "pem", type: "pkcs8" })),
      keyId: "KEY123",
      teamId: "TEAM123",
      topic: "com.cozylabs.cozychat",
      environment: "development",
    },
  };
}

let server: Http2Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function fakeApns(
  handler: (headers: Record<string, unknown>, body: string, stream: import("node:http2").ServerHttp2Stream) => void,
): Promise<string> {
  server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => (body += d));
    stream.on("end", () => handler(headers as Record<string, unknown>, body, stream));
  });
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("buildProviderJwt", () => {
  it("produces a verifiable ES256 JWT with the right header and claims", () => {
    const { config, publicKey } = testConfig();
    const jwt = buildProviderJwt(config, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s ?? "", "base64url"),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toEqual({ iss: "TEAM123", iat: 1_700_000_000 });
  });
});

describe("apnsTransport.deliver", () => {
  it("POSTs the alert + ciphertext under 'c' to /3/device/<token> with a bearer JWT", async () => {
    const { config, publicKey } = testConfig();
    let seen: { headers: Record<string, unknown>; body: string } | undefined;
    const baseUrl = await fakeApns((headers, body, stream) => {
      seen = { headers, body };
      stream.respond({ ":status": 200 });
      stream.end();
    });

    await apnsTransport(config, { baseUrl }).deliver("DEVICETOKENHEX", "CIPHERBLOB");

    expect(seen?.headers[":path"]).toBe("/3/device/DEVICETOKENHEX");
    expect(seen?.headers[":method"]).toBe("POST");
    expect(seen?.headers["apns-topic"]).toBe("com.cozylabs.cozychat");
    expect(seen?.headers["apns-push-type"]).toBe("alert");
    const auth = String(seen?.headers["authorization"]);
    expect(auth.startsWith("bearer ")).toBe(true);
    const [h, c, s] = auth.slice("bearer ".length).split(".");
    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(seen?.body ?? "")).toEqual({
      aps: { alert: { title: "CozyChat", body: "New message" }, "mutable-content": 1 },
      c: "CIPHERBLOB",
    });
  });

  it("rejects on a non-2xx APNs status", async () => {
    const { config } = testConfig();
    const baseUrl = await fakeApns((_headers, _body, stream) => {
      stream.respond({ ":status": 400 });
      stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
    });
    await expect(apnsTransport(config, { baseUrl }).deliver("tok", "c")).rejects.toThrow(/HTTP 400/);
  });
});

describe("apnsConfigFromEnv", () => {
  it("returns undefined when no APNs vars are set (relay runs webhook-only)", () => {
    expect(apnsConfigFromEnv({}, () => "")).toBeUndefined();
  });

  it("throws when only some APNs vars are set", () => {
    expect(() => apnsConfigFromEnv({ APNS_KEY_ID: "k" }, () => "")).toThrow(/APNs config incomplete/);
  });

  it("reads the key file and returns config when all are set", () => {
    const cfg = apnsConfigFromEnv(
      {
        APNS_KEY_P8_PATH: "/keys/apns.p8",
        APNS_KEY_ID: "k",
        APNS_TEAM_ID: "t",
        APNS_TOPIC: "com.cozylabs.cozychat",
        APNS_ENVIRONMENT: "production",
      },
      (p) => (p === "/keys/apns.p8" ? "PEMDATA" : ""),
    );
    expect(cfg).toEqual({
      keyP8: "PEMDATA",
      keyId: "k",
      teamId: "t",
      topic: "com.cozylabs.cozychat",
      environment: "production",
    });
  });
});
