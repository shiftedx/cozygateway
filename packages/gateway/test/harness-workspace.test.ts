import { describe, expect, it } from "vitest";
import type { GatewayHarness, Message, RichBlock } from "cozygateway-contract";

import { hashToken } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import type { HermesClient } from "../src/hermes-bridge/client.ts";
import {
  GatewayHarnessWorkspace,
  HermesWorkspaceAdapter,
  WorkspaceBusy,
  WorkspaceForbidden,
  WorkspaceUnavailable,
  WorkspaceTooLarge,
  WorkspaceRateLimited,
  WORKSPACE_LIST_MAX_BYTES,
  createWorkspaceRateLimiter,
  discoverHermesWorkspace,
  resolveWorkspaceRange,
  workspacePath,
} from "../src/hermes-bridge/workspace.ts";
import { openStorage } from "../src/storage.ts";

const ROOT = "/srv/operator/workspace";
const TOKEN = "paired-device-token";
const HARNESS: GatewayHarness = {
  id: "home",
  vendor: { id: "hermes-agent", name: "Hermes Agent", logoAsset: "hermes-agent" },
  scopes: [{ id: "sage", name: "Sage" }],
};
const CONFIG: GatewayConfig = {
  name: "workspace-test",
  port: 0,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: {
    url: "ws://127.0.0.1:1/api/ws",
    tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
    profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN" } },
  },
};

type ClientHandlers = {
  json?: (path: string) => unknown | Promise<unknown>;
  response?: (path: string, init?: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal }) => Response | Promise<Response>;
};

function client(handlers: ClientHandlers): HermesClient {
  return {
    dashboardJson: async (path: string) => handlers.json?.(path),
    dashboardResponse: async (path: string, init) => {
      if (path.startsWith("/api/files?") && handlers.json) {
        const body = JSON.stringify(await handlers.json(path));
        return new Response(body, {
          headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        });
      }
      if (!handlers.response) throw new Error("upstream unavailable");
      return handlers.response(path, init);
    },
  } as HermesClient;
}

function upstreamList(
  entries: unknown[],
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    path: ROOT,
    parent: null,
    entries,
    root: ROOT,
    locked_root: ROOT,
    can_change_path: false,
    ...overrides,
  };
}

function fileEntry(name = "report.txt", size = 6, path = `${ROOT}/${name}`) {
  return {
    name,
    path,
    is_directory: false,
    size,
    mtime: 1_700_000_000,
    mime_type: "text/plain",
  };
}

function workspace(handlers: ClientHandlers, opts: ConstructorParameters<typeof GatewayHarnessWorkspace>[1] = {}) {
  return new GatewayHarnessWorkspace(
    [new HermesWorkspaceAdapter(client(handlers), HARNESS, ROOT)],
    opts,
  );
}

function appFor(surface?: GatewayHarnessWorkspace) {
  const storage = openStorage(":memory:");
  storage.createDevice({ id: "device", name: "Phone", tokenHash: hashToken(TOKEN), createdAt: 1 });
  const app = createApp({
    storage,
    config: CONFIG,
    gatewayInfo: { name: "g", version: "test", contract: "v1" },
    ...(surface ? { harnessWorkspace: surface } : {}),
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, blocks: RichBlock[]): Message => ({
      threadId: "t", seq: 1, role: "user", blocks, createdAt: 1,
    }),
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { app, request };
}

describe("workspace path admission", () => {
  it("accepts canonical root-relative paths and rejects ambiguous or unbounded ones", () => {
    expect(workspacePath(undefined)).toBe("");
    expect(workspacePath("reports/2026.txt")).toBe("reports/2026.txt");
    for (const denied of ["/etc/passwd", "C:/secret", "../secret", "a/../secret", "a\\secret", "a//b", "a/./b", "file:///tmp/x", "bad\0name"]) {
      expect(() => workspacePath(denied)).toThrow();
    }
    expect(() => workspacePath("x".repeat(256))).toThrow(/segment/i);
    expect(() => workspacePath(`${"a/".repeat(2048)}a`)).toThrow(/long/i);
  });

  it("denies credential, config, pairing and MCP-token paths before calling Hermes", async () => {
    let calls = 0;
    const surface = workspace({ json: () => { calls += 1; return upstreamList([]); } });
    for (const path of [".env", "config/settings.json", "pairing/device.json", "mcp-tokens/github.json", ".ssh/id_rsa", "auth.json", "cert.pem"]) {
      await expect(surface.list("home", "sage", path, "device")).rejects.toBeInstanceOf(WorkspaceForbidden);
    }
    expect(calls).toBe(0);
  });

  it("resolves only one bounded byte range", () => {
    expect(resolveWorkspaceRange(undefined, 100)).toBeUndefined();
    expect(resolveWorkspaceRange("bytes=2-5", 100)).toEqual({ start: 2, end: 5 });
    expect(resolveWorkspaceRange("bytes=-3", 100)).toEqual({ start: 97, end: 99 });
    expect(resolveWorkspaceRange("bytes=0-1,4-5", 100)).toBeNull();
    expect(resolveWorkspaceRange("items=0-1", 100)).toBeNull();
  });
});

describe("locked-root discovery and privacy", () => {
  it("discovers only an immutable non-null root", async () => {
    await expect(discoverHermesWorkspace(client({ json: () => upstreamList([]) }), HARNESS)).resolves.toBeInstanceOf(HermesWorkspaceAdapter);
    await expect(discoverHermesWorkspace(client({ json: () => upstreamList([], { locked_root: null }) }), HARNESS)).resolves.toBeUndefined();
    await expect(discoverHermesWorkspace(client({ json: () => upstreamList([], { can_change_path: true }) }), HARNESS)).resolves.toBeUndefined();
    for (const root of ["/srv/secrets", "/srv/hermes/config"]) {
      await expect(discoverHermesWorkspace(client({
        json: () => upstreamList([], { path: root, root, locked_root: root }),
      }), HARNESS)).resolves.toBeUndefined();
    }
    await expect(discoverHermesWorkspace(client({ json: () => { throw new Error("timeout /private/root"); } }), HARNESS)).resolves.toBeUndefined();
  });

  it("returns relative entries, filters sensitive names, and never leaks upstream roots", async () => {
    const surface = workspace({ json: () => upstreamList([
      { name: "reports", path: `${ROOT}/reports`, is_directory: true, size: null, mtime: 1_700_000_000, mime_type: null },
      fileEntry(),
      fileEntry(".env", 30, `${ROOT}/.env`),
      fileEntry("auth.json", 30, `${ROOT}/auth.json`),
    ]) });
    const body = await surface.list("home", "sage", undefined, "device");
    expect(body).toEqual({
      path: "",
      parent: null,
      entries: [
        { name: "reports", path: "reports", kind: "directory", modifiedAt: 1_700_000_000_000 },
        { name: "report.txt", path: "report.txt", kind: "file", size: 6, modifiedAt: 1_700_000_000_000, mimeType: "text/plain" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(ROOT);
  });

  it("fails closed on a symlink-resolved escape or changed lock proof", async () => {
    await expect(workspace({ json: () => upstreamList([fileEntry("link", 4, "/etc/passwd")]) })
      .list("home", "sage", undefined, "device")).rejects.toBeInstanceOf(WorkspaceForbidden);
    await expect(workspace({ json: () => upstreamList([], { locked_root: "/srv/other", root: "/srv/other" }) })
      .list("home", "sage", undefined, "device")).rejects.toThrow(/lock proof/i);
  });

  it("rejects invalid names and paths projected beyond the full relative-path bound", async () => {
    await expect(workspace({ json: () => upstreamList([
      fileEntry("", 1, ROOT),
    ]) }).list("home", "sage", undefined, "device"))
      .rejects.toBeInstanceOf(WorkspaceUnavailable);

    const segment = "a".repeat(255);
    const parent = Array.from({ length: 16 }, () => segment).join("/");
    expect(Buffer.byteLength(parent)).toBe(4095);
    await expect(workspace({ json: () => upstreamList([
      fileEntry("b", 1, `${ROOT}/${parent}/b`),
    ]) }).list("home", "sage", parent, "device"))
      .rejects.toBeInstanceOf(WorkspaceTooLarge);
  });

  it("propagates request cancellation through directory reads", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamAborts = 0;
    const surface = workspace({
      response: (_path, init) => {
        upstreamSignal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              upstreamAborts += 1;
              controller.error(new DOMException("cancelled", "AbortError"));
            }, { once: true });
          },
        }));
      },
    });
    const requestAbort = new AbortController();
    const pending = surface.list("home", "sage", undefined, "device", requestAbort.signal);
    requestAbort.abort();
    requestAbort.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkspaceUnavailable);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamAborts).toBe(1);
  });

  it("caps the upstream JSON body before parsing it", async () => {
    const oversizedClient = {
      dashboardResponse: async () => new Response("x", {
        headers: { "content-length": String(WORKSPACE_LIST_MAX_BYTES + 1) },
      }),
    } as unknown as HermesClient;
    const surface = new GatewayHarnessWorkspace([
      new HermesWorkspaceAdapter(oversizedClient, HARNESS, ROOT),
    ]);
    await expect(surface.list("home", "sage", undefined, "device"))
      .rejects.toBeInstanceOf(WorkspaceTooLarge);
  });
});

describe("paired workspace routes", () => {
  it("requires paired auth and exact harness/scope, with no write verb", async () => {
    const { app, request } = appFor(workspace({ json: () => upstreamList([]) }));
    expect((await app.request("/gateway/harnesses/home/scopes/sage/workspace")).status).toBe(401);
    expect((await request("/gateway/harnesses/other/scopes/sage/workspace")).status).toBe(404);
    expect((await request("/gateway/harnesses/home/scopes/other/workspace")).status).toBe(404);
    expect((await request("/gateway/harnesses/home/scopes/sage/workspace", { method: "POST" })).status).toBe(404);
  });

  it("sanitizes traversal, escape, unavailable, and timeout errors without returning host paths", async () => {
    let failures = 0;
    const { request } = appFor(workspace({ json: (path) => {
      if (path.includes("escape")) return upstreamList([fileEntry("link", 1, "/Users/operator/.ssh/id_rsa")]);
      failures += 1;
      if (failures === 1) throw new Error(`connect failed at ${ROOT}`);
      throw new DOMException(`timed out reading ${ROOT}`, "TimeoutError");
    } }));
    const traversal = await request("/gateway/harnesses/home/scopes/sage/workspace?path=../secret");
    expect(traversal.status).toBe(400);
    const escape = await request("/gateway/harnesses/home/scopes/sage/workspace?path=escape");
    expect(escape.status).toBe(403);
    const unavailable = await request("/gateway/harnesses/home/scopes/sage/workspace");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(ROOT);
    const timeout = await request("/gateway/harnesses/home/scopes/sage/workspace");
    expect(timeout.status).toBe(503);
    expect(await timeout.text()).not.toContain(ROOT);
  });

  it("streams a bounded range with safe download headers", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const { request } = appFor(workspace({
      json: () => upstreamList([fileEntry()]),
      response: (_path, init) => {
        expect(init?.headers?.["range"]).toBe("bytes=1-3");
        return new Response(bytes.slice(1, 4), {
          status: 206,
          headers: { "content-length": "3", "content-range": "bytes 1-3/6" },
        });
      },
    }));
    const response = await request(
      "/gateway/harnesses/home/scopes/sage/workspace/download?path=report.txt",
      { headers: { range: "bytes=1-3" } },
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("bcd");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("report.txt");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBe("bytes 1-3/6");
  });

  it("preserves Windows path casing in the proven upstream download target", async () => {
    const root = "C:\\Data\\Workspace";
    let target: string | null = null;
    const surface = new GatewayHarnessWorkspace([
      new HermesWorkspaceAdapter(client({
        json: () => upstreamList([
          fileEntry("Report.txt", 6, "c:\\DATA\\WORKSPACE\\REPORT.TXT"),
        ], {
          path: "c:\\data\\workspace",
          root: "c:\\data\\workspace",
          locked_root: "C:\\DATA\\WORKSPACE",
        }),
        response: (path) => {
          target = new URL(path, "http://hermes.invalid").searchParams.get("path");
          return new Response("abcdef", { headers: { "content-length": "6" } });
        },
      }), HARNESS, root),
    ]);

    const opened = await surface.download(
      "home", "sage", "Report.txt", undefined, "device", new AbortController().signal,
    );
    expect(target).toBe("C:/Data/Workspace/Report.txt");
    await opened.body.cancel();
  });

  it("cancels an opened body when the locked root or entry changes during download", async () => {
    for (const mutate of [
      () => upstreamList([fileEntry()], { root: "/srv/other", locked_root: "/srv/other" }),
      () => upstreamList([fileEntry("report.txt", 5)]),
    ]) {
      let listings = 0;
      let cancelled = false;
      const surface = workspace({
        json: () => listings++ === 0 ? upstreamList([fileEntry()]) : mutate(),
        response: (path) => {
          expect(path).toContain(`path=${encodeURIComponent(`${ROOT}/report.txt`)}`);
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { cancelled = true; },
          }), { headers: { "content-length": "6" } });
        },
      });
      await expect(surface.download(
        "home", "sage", "report.txt", undefined, "device", new AbortController().signal,
      )).rejects.toBeInstanceOf(WorkspaceUnavailable);
      expect(cancelled).toBe(true);
    }
  });

  it("rejects oversized files and ranges before opening an upstream body", async () => {
    let downloads = 0;
    const { request } = appFor(workspace({
      json: () => upstreamList([fileEntry("huge.bin", 100 * 1024 * 1024 + 1)]),
      response: () => { downloads += 1; return new Response(); },
    }));
    expect((await request("/gateway/harnesses/home/scopes/sage/workspace/download?path=huge.bin")).status).toBe(413);
    expect(downloads).toBe(0);

    const rangeApp = appFor(workspace({
      json: () => upstreamList([fileEntry("big.bin", 20 * 1024 * 1024)]),
      response: () => { downloads += 1; return new Response(); },
    }));
    expect((await rangeApp.request(
      "/gateway/harnesses/home/scopes/sage/workspace/download?path=big.bin",
      { headers: { range: `bytes=0-${17 * 1024 * 1024}` } },
    )).status).toBe(413);
    expect(downloads).toBe(0);
  });
});

describe("stream resource bounds", () => {
  it("propagates consumer cancellation upstream and releases its concurrency slot", async () => {
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    const surface = workspace({
      json: () => upstreamList([fileEntry("report.txt", 6)]),
      response: (_path, init) => {
        upstreamSignal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new Uint8Array([1])); },
          cancel() { cancelled = true; },
        }), { headers: { "content-length": "6" } });
      },
    });
    const opened = await surface.download("home", "sage", "report.txt", undefined, "device", new AbortController().signal);
    await opened.body.cancel("client left");
    expect(cancelled).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("holds concurrent slots through repeated aborts until upstream cancellation settles", async () => {
    const pendingCancels: Array<() => void> = [];
    const never = () => new ReadableStream<Uint8Array>({
      pull() {},
      cancel: () => new Promise<void>((resolve) => pendingCancels.push(resolve)),
    });
    const surface = workspace({
      json: () => upstreamList([fileEntry()]),
      response: () => new Response(never(), { headers: { "content-length": "6" } }),
    });
    const requestAborts = Array.from({ length: 4 }, () => new AbortController());
    const streams = await Promise.all(requestAborts.map((controller) =>
      surface.download("home", "sage", "report.txt", undefined, "device", controller.signal)));
    await expect(surface.download("home", "sage", "report.txt", undefined, "device", new AbortController().signal))
      .rejects.toBeInstanceOf(WorkspaceBusy);
    for (const controller of requestAborts) {
      controller.abort();
      controller.abort();
    }
    await expect(surface.download("home", "sage", "report.txt", undefined, "device", new AbortController().signal))
      .rejects.toBeInstanceOf(WorkspaceBusy);
    const cancellations = Promise.all(streams.map((stream) => stream.body.cancel()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingCancels).toHaveLength(4);
    await expect(surface.download("home", "sage", "report.txt", undefined, "device", new AbortController().signal))
      .rejects.toBeInstanceOf(WorkspaceBusy);
    for (const settle of pendingCancels.splice(0)) settle();
    await cancellations;
    const replacement = await surface.download(
      "home", "sage", "report.txt", undefined, "device", new AbortController().signal,
    );
    const replacementCancellation = replacement.body.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingCancels).toHaveLength(1);
    pendingCancels.pop()!();
    await replacementCancellation;
  });

  it("rate-limits each paired device independently", async () => {
    const rate = workspace(
      { json: () => upstreamList([]) },
      { rate: createWorkspaceRateLimiter({ capacity: 1, refillMs: 10_000 }), now: () => 0 },
    );
    await rate.list("home", "sage", undefined, "one-device");
    await expect(rate.list("home", "sage", undefined, "one-device")).rejects.toBeInstanceOf(WorkspaceRateLimited);
    await expect(rate.list("home", "sage", undefined, "another-device")).resolves.toBeDefined();
  });
});
