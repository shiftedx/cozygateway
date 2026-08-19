import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  MEDIA_MAX_BYTES,
  MediaRefused,
  fetchMedia,
  resolveMediaSource,
  type MediaFetch,
} from "../src/hermes-bridge/media.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** `GET /bots/:name/media`, capability 7 (contract/ext-bots-v1.md).
 *
 *  Two halves, deliberately kept apart. The SOURCE RULES are pure and are tested without a socket,
 *  because they are what stands between a bot's reply text and an authenticated fetch from inside
 *  the operator's network; a rule that only holds when a fake server cooperates is not a rule. The
 *  ROUTE is tested through the app with an injected fetch, so the status mapping is pinned without
 *  anything reaching the network. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function imageResponse(bytes: Uint8Array = PNG, type = "image/png", extra: Record<string, string> = {}): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { "content-type": type, ...extra } });
}

async function setup(mediaFetch: MediaFetch): Promise<{
  authed: (path: string) => Promise<Response>;
  request: (path: string) => Promise<Response>;
}> {
  const server = await startFakeHermesServer({});
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: () => {},
    now: () => 1_800_000_000_000,
    logSink: () => {},
  });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    mediaFetch,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 7 } },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
      storage.appendMessage(threadId, { role: "user", blocks }, 500),
    interruptThread: () => "idle",
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  return {
    authed: async (path: string) => app.request(path, { headers: { authorization: `Bearer ${deviceToken}` } }),
    request: async (path: string) => app.request(path),
  };
}

function mediaPath(src: string, bot = "scout"): string {
  return `/bots/${bot}/media?src=${encodeURIComponent(src)}`;
}

describe("media source rules", () => {
  it("accepts an ordinary https URL", () => {
    expect(resolveMediaSource("https://cdn.example.com/a/b.png?v=2").toString()).toBe(
      "https://cdn.example.com/a/b.png?v=2",
    );
  });

  // The refusal that IS the v1 contract: a bot writes local paths constantly (image_gen output,
  // screenshots) and serving them would be a file-read primitive over the whole box. Each of these
  // shapes reaches the guard by a different route, which is why they are all pinned.
  it.each([
    "/Users/kyle/Desktop/out.png",
    "./out.png",
    "../out.png",
    "~/out.png",
    "C:\\Users\\kyle\\out.png",
    "\\\\share\\out.png",
    "file:///tmp/out.png",
  ])("refuses the local path %s", (src) => {
    try {
      resolveMediaSource(src);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(MediaRefused);
      expect((err as MediaRefused).reason).toBe("local_path");
    }
  });

  it.each(["http://cdn.example.com/a.png", "data:image/png;base64,AAAA", "ftp://h/a.png", "not a url"])(
    "refuses the non-https source %s",
    (src) => {
      expect(() => resolveMediaSource(src)).toThrow(MediaRefused);
      try {
        resolveMediaSource(src);
      } catch (err) {
        expect((err as MediaRefused).reason).toBe("scheme");
      }
    },
  );

  it("refuses credentials in the URL", () => {
    try {
      resolveMediaSource("https://user:pass@cdn.example.com/a.png");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as MediaRefused).reason).toBe("credentials");
    }
  });

  // The SSRF guard. `src` comes out of model output, and the gateway sits inside the operator's
  // network with reach into it: without this the route is a LAN probe and a cloud-metadata reader.
  it.each([
    "https://localhost/a.png",
    "https://box.local/a.png",
    "https://127.0.0.1/a.png",
    "https://10.1.2.3/a.png",
    "https://172.16.0.1/a.png",
    "https://172.31.255.254/a.png",
    "https://192.168.1.10/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/a.png",
    "https://[::1]/a.png",
    "https://[fd00::1]/a.png",
    "https://[fe80::1]/a.png",
    "https://[::ffff:10.0.0.1]/a.png",
    "https://239.1.1.1/a.png",
  ])("refuses the non-public address %s", (src) => {
    try {
      resolveMediaSource(src);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as MediaRefused).reason).toBe("host");
    }
  });

  // The other side of the guard: 172.15 and 172.32 are ordinary public space, and refusing them
  // would silently break real image hosts.
  it.each(["https://172.15.0.1/a.png", "https://172.32.0.1/a.png", "https://8.8.8.8/a.png"])(
    "allows the public address %s",
    (src) => {
      expect(() => resolveMediaSource(src)).not.toThrow();
    },
  );
});

describe("media fetch", () => {
  it("streams an allowed image through", async () => {
    const media = await fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), {
      fetchImpl: async () => imageResponse(),
    });
    expect(media.contentType).toBe("image/png");
    const bytes = new Uint8Array(await new Response(media.body).arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
  });

  it("re-checks every redirect hop against the same rules", async () => {
    const seen: string[] = [];
    const fetchImpl: MediaFetch = async (url) => {
      seen.push(url);
      if (url === "https://cdn.example.com/a.png") {
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/a.png" } });
      }
      return imageResponse();
    };
    await expect(
      fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), { fetchImpl }),
    ).rejects.toMatchObject({ reason: "host" });
    // Proof the redirect was never followed, which is the whole point of following by hand.
    expect(seen).toEqual(["https://cdn.example.com/a.png"]);
  });

  it("follows a redirect to another public https host", async () => {
    const fetchImpl: MediaFetch = async (url) =>
      url === "https://cdn.example.com/a.png"
        ? new Response(null, { status: 301, headers: { location: "/moved/a.png" } })
        : imageResponse();
    const media = await fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), { fetchImpl });
    expect(media.contentType).toBe("image/png");
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    const fetchImpl: MediaFetch = async () =>
      new Response(null, { status: 302, headers: { location: `/hop${(n += 1)}.png` } });
    await expect(
      fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), { fetchImpl }),
    ).rejects.toThrow(/redirected more than/);
  });

  // SVG is a document format carrying script and external references. An `image/*` prefix test
  // would have let it through, which is exactly why the check is an allow-list.
  it.each(["image/svg+xml", "text/html", "application/octet-stream", ""])(
    "refuses the content type %s",
    async (type) => {
      await expect(
        fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), {
          fetchImpl: async () => imageResponse(PNG, type),
        }),
      ).rejects.toMatchObject({ reason: "content_type" });
    },
  );

  it("refuses a declared length over the cap and drops the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), {
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(MEDIA_MAX_BYTES + 1) },
          }),
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
    // Cancelled, not drained: a body the gateway has already decided not to serve must not be
    // pulled to completion, which for a real 200 MB upstream is the whole difference.
    expect(cancelled).toBe(true);
  });

  // The header is a claim, the body is the fact: an upstream that declares nothing (or lies) must
  // still be cut off, or the cap is decorative.
  it("cuts off a body that runs past the cap mid-stream", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const media = await fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), {
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
    });
    await expect(new Response(media.body).arrayBuffer()).rejects.toMatchObject({ reason: "too_large" });
  });

  it("reports an upstream refusal with its status", async () => {
    await expect(
      fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), {
        fetchImpl: async () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("times out an upstream that never answers", async () => {
    const fetchImpl: MediaFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      fetchMedia(resolveMediaSource("https://cdn.example.com/a.png"), { fetchImpl, timeoutMs: 20 }),
    ).rejects.toThrow(/did not answer inside/);
  });
});

describe("GET /bots/:name/media", () => {
  it("requires a device token", async () => {
    const { request } = await setup(async () => imageResponse());
    expect((await request(mediaPath("https://cdn.example.com/a.png"))).status).toBe(401);
  });

  it("serves the image with cache headers and the resolved source", async () => {
    const { authed } = await setup(async () => imageResponse());
    const res = await authed(mediaPath("https://cdn.example.com/a.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("x-cozy-media-source")).toBe("https://cdn.example.com/a.png");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(PNG.byteLength);
  });

  // The route does NOT resolve the bot against Hermes: an image already sitting on a CDN must not
  // stop loading because the bridge is having a bad day. A bot that does not exist still serves.
  it("does not require the bot to exist", async () => {
    const { authed } = await setup(async () => imageResponse());
    expect((await authed(mediaPath("https://cdn.example.com/a.png", "nobody-here"))).status).toBe(200);
  });

  it("400s a missing src", async () => {
    const { authed } = await setup(async () => imageResponse());
    const res = await authed("/bots/scout/media");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("400s an over-long src before parsing it", async () => {
    const { authed } = await setup(async () => imageResponse());
    const res = await authed(mediaPath(`https://cdn.example.com/${"a".repeat(3000)}.png`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("400s a local path with reason local_path", async () => {
    const { authed } = await setup(async () => imageResponse());
    const res = await authed(mediaPath("/Users/kyle/Desktop/out.png"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "media_refused" }, reason: "local_path" });
  });

  it("415s a content type that is not a proxied image", async () => {
    const { authed } = await setup(async () => imageResponse(PNG, "image/svg+xml"));
    const res = await authed(mediaPath("https://cdn.example.com/a.svg"));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: { code: "media_refused" }, reason: "content_type" });
  });

  it("413s a declared length over the cap", async () => {
    const { authed } = await setup(
      async () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(MEDIA_MAX_BYTES + 1) },
        }),
    );
    const res = await authed(mediaPath("https://cdn.example.com/big.png"));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
  });

  it("502s an upstream failure and says what the source said", async () => {
    const { authed } = await setup(
      async () => new Response("gone", { status: 503, headers: { "content-type": "text/plain" } }),
    );
    const res = await authed(mediaPath("https://cdn.example.com/a.png"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "backend_unavailable" }, sourceStatus: 503 });
  });
});
