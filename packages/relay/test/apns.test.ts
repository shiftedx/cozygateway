import { createServer, type ClientHttp2Session, type Http2Server } from "node:http2";
import { EventEmitter, once } from "node:events";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  APNS_DELIVERY_TIMEOUT_MS,
  apnsConfigFromEnv,
  apnsTransport,
  buildProviderJwt,
  type ApnsConfig,
} from "../src/apns.ts";

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

/** A fake ClientHttp2Session: the lifecycle assertions (was close() called, and how many times)
 *  are not observable through a real socket, so the transport takes a `connect` seam. */
class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  written = "";
  ended = false;
  timeoutMs: number | undefined;
  timeoutHandler: (() => void) | undefined;
  destroyed = false;
  setEncoding(): void {}
  setTimeout(ms: number, handler: () => void): void {
    this.timeoutMs = ms;
    this.timeoutHandler = handler;
  }
  write(chunk: string): void {
    this.written += chunk;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Drive a happy-path response. */
  respond(status: number, body = ""): void {
    this.emit("response", { ":status": status });
    if (body !== "") this.emit("data", body);
    this.emit("end");
  }
}

class FakeSession extends EventEmitter {
  closeCalls = 0;
  destroyCalls = 0;
  requests: FakeRequest[] = [];
  close(): void {
    this.closeCalls += 1;
  }
  destroy(): void {
    this.destroyCalls += 1;
  }
  request(headers: Record<string, string>): FakeRequest {
    const req = new FakeRequest();
    req.headers = headers;
    this.requests.push(req);
    return req;
  }
  get lastRequest(): FakeRequest {
    const req = this.requests.at(-1);
    if (req === undefined) throw new Error("no request issued");
    return req;
  }
}

function fakeConnect(): { connect: (url: string) => ClientHttp2Session; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    connect: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as unknown as ClientHttp2Session;
    },
  };
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
  it("sends ActivityKit payloads directly with the liveactivity topic and quiet priority", async () => {
    const { config } = testConfig();
    let seen: { headers: Record<string, unknown>; body: string } | undefined;
    const baseUrl = await fakeApns((headers, body, stream) => {
      seen = { headers, body };
      stream.respond({ ":status": 200 });
      stream.end();
    });

    await apnsTransport(config, { baseUrl }).deliver("ACTIVITYTOKEN", "", { liveActivity: {
      timestamp: 100, event: "update", priority: 5, staleDate: 220,
      contentState: { phase: "usingTools", toolCallCount: 2, shortStatus: "Using 2 tools",
        eventSequence: 7, elapsedSeconds: 94 },
    } });

    expect(seen?.headers["apns-topic"]).toBe("com.cozylabs.cozychat.push-type.liveactivity");
    expect(seen?.headers["apns-push-type"]).toBe("liveactivity");
    expect(seen?.headers["apns-priority"]).toBe("5");
    expect(JSON.parse(seen?.body ?? "{}")).toEqual({ aps: {
      timestamp: 100, event: "update", "stale-date": 220,
      "content-state": { phase: "usingTools", toolCallCount: 2,
        shortStatus: "Using 2 tools", eventSequence: 7, elapsedSeconds: 94 },
    } });
  });

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

describe("apnsTransport push categories", () => {
  async function deliverWithCategory(
    category: "message" | "approval.pending" | "approval.resolved",
    collapseId: string,
  ): Promise<{ headers: Record<string, unknown>; body: Record<string, unknown> }> {
    const { config } = testConfig();
    let seen: { headers: Record<string, unknown>; body: string } | undefined;
    const baseUrl = await fakeApns((headers, body, stream) => {
      seen = { headers, body };
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await apnsTransport(config, { baseUrl }).deliver("DEVTOK", "CIPHERBLOB", { category, collapseId });
    return { headers: seen?.headers ?? {}, body: JSON.parse(seen?.body ?? "{}") as Record<string, unknown> };
  }

  it("sets aps.category so the app can attach its Approve/Deny actions client-side", async () => {
    const { body } = await deliverWithCategory("approval.pending", "toolu_01");
    expect(body["aps"]).toMatchObject({ category: "approval.pending", "mutable-content": 1 });
    expect(body["c"]).toBe("CIPHERBLOB");
  });

  it("uses the content-free message alert and caller collapse id for bot replies", async () => {
    const { headers, body } = await deliverWithCategory("message", "botmsg.abc123");
    expect(headers["apns-collapse-id"]).toBe("botmsg.abc123");
    expect(body["aps"]).toMatchObject({
      category: "message",
      alert: { title: "CozyChat", body: "New message" },
    });
  });

  it("coalesces on the caller's collapse id (apns-collapse-id = toolCallId)", async () => {
    const { headers } = await deliverWithCategory("approval.pending", "toolu_01");
    expect(headers["apns-collapse-id"]).toBe("toolu_01");
    expect(headers["apns-push-type"]).toBe("alert");
  });

  it("sends the resolve on the same collapse id, so it replaces the pending notification in place", async () => {
    const { headers, body } = await deliverWithCategory("approval.resolved", "toolu_01");
    expect(headers["apns-collapse-id"]).toBe("toolu_01");
    expect(body["aps"]).toMatchObject({ category: "approval.resolved" });
  });

  it("carries only a value-free fallback alert; every approval detail stays inside the ciphertext", async () => {
    const { body } = await deliverWithCategory("approval.pending", "toolu_01");
    const aps = body["aps"] as { alert: { title: string; body: string } };
    expect(aps.alert).toEqual({ title: "CozyChat", body: "Approval requested" });
    // The APNs JSON, minus the opaque ciphertext, names nothing about the tool call itself.
    const rendered = JSON.stringify({ ...body, c: undefined });
    expect(rendered).not.toContain("CIPHERBLOB");
    expect(rendered).not.toContain("toolu_01");
  });

  it("omits apns-collapse-id and aps.category for an uncategorized message push (unchanged)", async () => {
    const { config } = testConfig();
    let seen: { headers: Record<string, unknown>; body: string } | undefined;
    const baseUrl = await fakeApns((headers, body, stream) => {
      seen = { headers, body };
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await apnsTransport(config, { baseUrl }).deliver("DEVTOK", "CIPHERBLOB");
    expect(seen?.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(seen?.body ?? "")).toEqual({
      aps: { alert: { title: "CozyChat", body: "New message" }, "mutable-content": 1 },
      c: "CIPHERBLOB",
    });
  });
});

describe("apnsTransport delivery timeout", () => {
  it("exports an operator-sane default timeout", () => {
    expect(APNS_DELIVERY_TIMEOUT_MS).toBe(10_000);
  });

  it("rejects when a connected APNs session accepts the request but never responds", async () => {
    const { config } = testConfig();
    // Real server, real socket: accept the stream and stay silent forever.
    const baseUrl = await fakeApns(() => {});
    const transport = apnsTransport(config, { baseUrl, deliveryTimeoutMs: 60 });
    await expect(transport.deliver("tok", "c")).rejects.toThrow(/timed out/i);
  });

  it("arms the request timeout with the configured value and closes the session when it fires", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const transport = apnsTransport(config, { connect, deliveryTimeoutMs: 1234 });
    const pending = transport.deliver("tok", "c");
    const session = sessions[0]!;
    expect(session.lastRequest.timeoutMs).toBe(1234);
    session.lastRequest.timeoutHandler?.();
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(session.closeCalls).toBe(1);
  });

  it("defaults the request timeout to APNS_DELIVERY_TIMEOUT_MS", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const transport = apnsTransport(config, { connect });
    const pending = transport.deliver("tok", "c");
    expect(sessions[0]!.lastRequest.timeoutMs).toBe(APNS_DELIVERY_TIMEOUT_MS);
    sessions[0]!.lastRequest.respond(200);
    await pending;
  });
});

describe("apnsTransport session lifecycle", () => {
  it("closes the session when the session itself errors", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const pending = apnsTransport(config, { connect }).deliver("tok", "c");
    const session = sessions[0]!;
    session.emit("error", new Error("ECONNRESET"));
    await expect(pending).rejects.toThrow(/ECONNRESET/);
    expect(session.closeCalls).toBe(1);
  });

  it("closes the session when the request errors", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const pending = apnsTransport(config, { connect }).deliver("tok", "c");
    const session = sessions[0]!;
    session.lastRequest.emit("error", new Error("stream blew up"));
    await expect(pending).rejects.toThrow(/stream blew up/);
    expect(session.closeCalls).toBe(1);
  });

  it("closes exactly once even when several failure signals race", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const pending = apnsTransport(config, { connect }).deliver("tok", "c");
    const session = sessions[0]!;
    session.lastRequest.timeoutHandler?.();
    session.emit("error", new Error("late error"));
    session.lastRequest.emit("error", new Error("late stream error"));
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(session.closeCalls).toBe(1);
  });

  it("uses a fresh session per push and closes each one", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    const transport = apnsTransport(config, { connect });
    const first = transport.deliver("tok", "c1");
    sessions[0]!.lastRequest.respond(200);
    await first;
    const second = transport.deliver("tok", "c2");
    sessions[1]!.lastRequest.respond(200);
    await second;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.closeCalls)).toEqual([1, 1]);
  });
});

describe("apnsTransport provider-JWT cache", () => {
  function authOf(req: FakeRequest): string {
    return String(req.headers["authorization"]).slice("bearer ".length);
  }

  it("mints the provider JWT once and reuses it inside the refresh window", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    let t = 1_700_000_000_000;
    const transport = apnsTransport(config, { connect, now: () => t });

    const first = transport.deliver("tok", "c1");
    sessions[0]!.lastRequest.respond(200);
    await first;

    t += 49 * 60 * 1000; // still inside the 50-minute window
    const second = transport.deliver("tok", "c2");
    sessions[1]!.lastRequest.respond(200);
    await second;

    expect(authOf(sessions[1]!.lastRequest)).toBe(authOf(sessions[0]!.lastRequest));
  });

  it("refreshes the provider JWT once the cached one reaches the refresh window", async () => {
    const { config } = testConfig();
    const { connect, sessions } = fakeConnect();
    let t = 1_700_000_000_000;
    const transport = apnsTransport(config, { connect, now: () => t });

    const first = transport.deliver("tok", "c1");
    sessions[0]!.lastRequest.respond(200);
    await first;

    t += 50 * 60 * 1000; // exactly at the refresh boundary
    const second = transport.deliver("tok", "c2");
    sessions[1]!.lastRequest.respond(200);
    await second;

    const fresh = authOf(sessions[1]!.lastRequest);
    expect(fresh).not.toBe(authOf(sessions[0]!.lastRequest));
    const claims = JSON.parse(Buffer.from(fresh.split(".")[1] ?? "", "base64url").toString());
    expect(claims.iat).toBe(Math.floor(t / 1000));
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
    const { config } = testConfig();
    const cfg = apnsConfigFromEnv(
      {
        APNS_KEY_P8_PATH: "/keys/apns.p8",
        APNS_KEY_ID: "k",
        APNS_TEAM_ID: "t",
        APNS_TOPIC: "com.cozylabs.cozychat",
        APNS_ENVIRONMENT: "production",
      },
      (p) => (p === "/keys/apns.p8" ? config.keyP8 : ""),
    );
    expect(cfg).toEqual({
      keyP8: config.keyP8,
      keyId: "k",
      teamId: "t",
      topic: "com.cozylabs.cozychat",
      environment: "production",
    });
  });

  // Startup p8 probe: a PRESENT but malformed key must scream at startup rather than reject every
  // push quietly. An ABSENT key (APNs off) must keep starting green.
  it("fails loud at startup when the .p8 is present but malformed", () => {
    expect(() =>
      apnsConfigFromEnv(
        {
          APNS_KEY_P8_PATH: "/keys/apns.p8",
          APNS_KEY_ID: "k",
          APNS_TEAM_ID: "t",
          APNS_TOPIC: "com.cozylabs.cozychat",
          APNS_ENVIRONMENT: "production",
        },
        () => "not a pem at all",
      ),
    ).toThrow(/APNS_KEY_P8_PATH/);
  });

  it("names the unreadable key path in the startup failure", () => {
    expect(() =>
      apnsConfigFromEnv(
        {
          APNS_KEY_P8_PATH: "/keys/broken.p8",
          APNS_KEY_ID: "k",
          APNS_TEAM_ID: "t",
          APNS_TOPIC: "com.cozylabs.cozychat",
          APNS_ENVIRONMENT: "production",
        },
        () => "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----\n",
      ),
    ).toThrow(/\/keys\/broken\.p8/);
  });

  it("does not probe (and never reads a key) when APNs is unconfigured, today's live posture", () => {
    let reads = 0;
    const cfg = apnsConfigFromEnv({ SOME_OTHER_VAR: "x" }, () => {
      reads += 1;
      return "not a pem at all";
    });
    expect(cfg).toBeUndefined();
    expect(reads).toBe(0);
  });
});
