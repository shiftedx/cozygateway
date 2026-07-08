# Push Relay + Gateway Push Origination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The push relay service (`packages/relay`) plus a gateway-side `RelayNotifier` that replaces `nullNotifier`, so a phone that is not connected still learns an agent replied, per docs/specs/2026-07-07-push-relay-design.md.

**Architecture:** The relay is a separately-deployable hono + `node:sqlite` service that maps opaque push ids to delivery transports and forwards ciphertext it cannot read (webhook transport in v0; APNs is a recognized platform that 501s). The gateway encrypts `{threadId, agentName, preview}` with AES-256-GCM under an HKDF-SHA256 key derived from each device's registered pushKey and posts it to that device's registered relay, strictly fire-and-forget. The wire contract for both is `contract/push-v0.md` (v0, not frozen).

**Tech Stack:** TypeScript, pure ESM, hono + @hono/node-server, TypeBox, `node:sqlite`, `node:crypto`, vitest.

## Global Constraints

- Node >= 24; on this machine prefix every node/pnpm command with `PATH=/opt/homebrew/opt/node@26/bin:$PATH`.
- Every shell command starts with `cd /Users/kmcdowell/Documents/repos/cozygateway && ...` (the shell cwd resets between calls).
- Pure ESM, `.ts`-extension relative imports, `erasableSyntaxOnly` (no enums, no namespaces, no parameter properties), strictest tsconfig.
- Never fabricate test data with `as` casts. Allowed narrowing: `as const`, parsed `unknown` after a schema/`Value.Check` pass, post-`instanceof`, and the established `.all() as unknown as Row[]` sqlite row pattern.
- No em-dashes anywhere in this repo's copy. Public copy never names the private codebase or any specific agent harness product. Do not promise unbuilt features (APNs is "planned", never "supported").
- The client wire contract v1 (`contract/v1.md`) is FROZEN. This plan adds `contract/push-v0.md` (v0, explicitly not frozen). No client-facing frame or REST shape changes; the conformance suite must stay 21/21.
- The relay package must not import from `cozygateway-contract` or `cozygateway` (the gateway): it stays independently deployable and ignorant of both. The gateway gains a devDependency on `cozygateway-relay` for the e2e test only.
- Gate order matters: `pnpm check` runs build THEN typecheck THEN test. Run a full `PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check` once before Task 1 so every `dist/` exists.
- Tests: TDD, `:memory:` DBs except where persistence itself is under test (then `mkdtempSync(join(tmpdir(), ...))`), ephemeral ports (`port: 0`), pristine vitest exit (close every server and socket, no stray timers).
- Keys and secrets never ride config files, examples, tests with real values, or git history. Test pushKeys are obvious dummies (`"test-push-key"`).
- Branch: `feat/push-relay` (already exists; the design spec is committed on it). No pushes until the final gate passes. Subagents: stay on this branch, no branch creation or switching, no push, never touch any other repository checkout.

## File Structure

Create:
- `packages/relay/package.json`, `packages/relay/tsconfig.json`, `packages/relay/tsconfig.build.json`
- `packages/relay/src/schemas.ts`: TypeBox request schemas, error codes, error envelope helper.
- `packages/relay/src/storage.ts`: `RelayStorage` (registrations + daily notify counts), `utcDay`.
- `packages/relay/src/transports.ts`: `Transport` interface + `webhookTransport`.
- `packages/relay/src/http.ts`: `createRelayApp` (register/notify/delete routes, auth hook slot, caps).
- `packages/relay/src/server.ts`: `startRelay` process assembly.
- `packages/relay/src/cli.ts`: `cozy-push-relay` executable.
- `packages/relay/src/index.ts`: public exports.
- `packages/relay/README.md`
- `packages/relay/test/storage.test.ts`, `transports.test.ts`, `routes.test.ts`, `server.test.ts`, `cli.test.ts`
- `contract/push-v0.md`: relay wire contract + ciphertext construction + test vector.
- `packages/gateway/src/push-crypto.ts`: HKDF derivation + AES-256-GCM payload encryption.
- `packages/gateway/src/push-notifier.ts`: `RelayNotifier`.
- `packages/gateway/test/push-crypto.test.ts`, `push-notifier.test.ts`, `push-e2e.test.ts`

Modify:
- `packages/gateway/src/storage.ts`: add `pushRegistrations()` + `deletePushRegistration()`.
- `packages/gateway/src/server.ts`: wire `RelayNotifier` in place of `nullNotifier`.
- `packages/gateway/package.json`: devDependency `cozygateway-relay: workspace:*`.
- `README.md` (root): status section, push relay moves from planned to shipped.

## Design decisions (traceable to docs/specs/2026-07-07-push-relay-design.md, section 2)

1. Transport seam now, webhook only; `apns` recognized, 501 until the phone app phase.
2. Open endpoints + per-push-id daily cap (default 500/day UTC); a no-op auth middleware slot marks where unlock gating lands later.
3. AES-256-GCM, key = HKDF-SHA256(pushKey string, salt empty, info `"cozygateway-push-v0"`, 32 bytes). HKDF keeps frozen contract v1's `pushKey: minLength 1` valid.
4. Relay state in SQLite via `node:sqlite` (registrations survive redeploys).
5. Relay is its own workspace package.
6. No gateway-side relay config: each registration carries its own `relayUrl`; zero registrations = no-op notifier.

---

### Task 1: Relay package scaffold, schemas, and storage

**Files:**
- Create: `packages/relay/package.json`, `packages/relay/tsconfig.json`, `packages/relay/tsconfig.build.json`
- Create: `packages/relay/src/schemas.ts`, `packages/relay/src/storage.ts`
- Test: `packages/relay/test/storage.test.ts` (also exercises schemas)

**Interfaces:**
- Consumes: nothing from other packages (relay is standalone).
- Produces (later tasks import exactly these names):
  - schemas.ts: `RELAY_ERROR_CODES`, `type RelayErrorCode`, `interface RelayErrorBody`, `relayError(code, message): RelayErrorBody`, `RegisterRequestSchema`, `type RegisterRequest`, `NotifyRequestSchema`, `type NotifyRequest`, `CIPHERTEXT_MAX_LENGTH`
  - storage.ts: `class RelayStorage` with `saveRegistration({pushId, platform, token, createdAt})`, `registrationByPushId(pushId): RegistrationRow | undefined`, `deleteRegistration(pushId): void`, `notifyCount(pushId, day): number`, `incrementNotifyCount(pushId, day): void`, `close()`; `openRelayStorage(dbPath): RelayStorage`; `utcDay(epochMs): string`; `interface RegistrationRow {pushId; platform; token}`

- [ ] **Step 1: Scaffold the package**

`packages/relay/package.json`:

```json
{
  "name": "cozygateway-relay",
  "version": "0.1.0",
  "description": "Push relay for cozygateway: maps opaque push ids to delivery transports and forwards encrypted notification payloads it cannot read.",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/shiftedx/cozygateway.git",
    "directory": "packages/relay"
  },
  "engines": { "node": ">=24" },
  "bin": { "cozy-push-relay": "dist/cli.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@sinclair/typebox": "^0.34.0",
    "hono": "^4.6.0"
  }
}
```

`packages/relay/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/relay/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

Then link the workspace:

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm install`
Expected: succeeds; `packages/relay` appears in the workspace.

- [ ] **Step 2: Write the failing test**

`packages/relay/test/storage.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
  CIPHERTEXT_MAX_LENGTH,
  NotifyRequestSchema,
  RegisterRequestSchema,
  relayError,
} from "../src/schemas.ts";
import { openRelayStorage, utcDay, type RelayStorage } from "../src/storage.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function memoryStorage(): RelayStorage {
  const storage = openRelayStorage(":memory:");
  cleanups.push(() => storage.close());
  return storage;
}

describe("schemas", () => {
  it("accepts a webhook register request and rejects unknown platforms", () => {
    expect(Value.Check(RegisterRequestSchema, { platform: "webhook", token: "https://x.example/hook" })).toBe(true);
    expect(Value.Check(RegisterRequestSchema, { platform: "apns", token: "abc" })).toBe(true);
    expect(Value.Check(RegisterRequestSchema, { platform: "smoke-signal", token: "abc" })).toBe(false);
    expect(Value.Check(RegisterRequestSchema, { platform: "webhook", token: "" })).toBe(false);
  });

  it("bounds notify ciphertext length", () => {
    expect(Value.Check(NotifyRequestSchema, { pushId: "p", ciphertext: "c" })).toBe(true);
    expect(Value.Check(NotifyRequestSchema, { pushId: "p", ciphertext: "x".repeat(CIPHERTEXT_MAX_LENGTH + 1) })).toBe(false);
  });

  it("builds the error envelope", () => {
    expect(relayError("not_found", "nope")).toEqual({ error: { code: "not_found", message: "nope" } });
  });
});

describe("relay storage", () => {
  it("saves, fetches, and deletes registrations; delete is idempotent", () => {
    const storage = memoryStorage();
    storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 111 });
    expect(storage.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "https://x.example/hook" });
    expect(storage.registrationByPushId("missing")).toBeUndefined();
    storage.deleteRegistration("p1");
    expect(storage.registrationByPushId("p1")).toBeUndefined();
    storage.deleteRegistration("p1");
  });

  it("counts notifies per push id per day", () => {
    const storage = memoryStorage();
    expect(storage.notifyCount("p1", "2026-07-07")).toBe(0);
    storage.incrementNotifyCount("p1", "2026-07-07");
    storage.incrementNotifyCount("p1", "2026-07-07");
    storage.incrementNotifyCount("p1", "2026-07-08");
    storage.incrementNotifyCount("p2", "2026-07-07");
    expect(storage.notifyCount("p1", "2026-07-07")).toBe(2);
    expect(storage.notifyCount("p1", "2026-07-08")).toBe(1);
    expect(storage.notifyCount("p2", "2026-07-07")).toBe(1);
  });

  it("persists registrations across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-storage-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "relay.db");
    const first = openRelayStorage(dbPath);
    first.saveRegistration({ pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 1 });
    first.close();
    const second = openRelayStorage(dbPath);
    cleanups.push(() => second.close());
    expect(second.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "https://x.example/hook" });
  });

  it("formats UTC days", () => {
    expect(utcDay(Date.UTC(2026, 6, 7, 0, 0, 1))).toBe("2026-07-07");
    expect(utcDay(Date.UTC(2026, 6, 7, 23, 59, 59))).toBe("2026-07-07");
    expect(utcDay(Date.UTC(2026, 6, 8, 0, 0, 0))).toBe("2026-07-08");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/storage.test.ts`
Expected: FAIL (cannot resolve `../src/schemas.ts` / `../src/storage.ts`).

- [ ] **Step 4: Implement schemas and storage**

`packages/relay/src/schemas.ts`:

```ts
import { type Static, Type } from "@sinclair/typebox";

export const RELAY_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "over_cap",
  "unsupported_platform",
  "internal",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export interface RelayErrorBody {
  error: { code: RelayErrorCode; message: string };
}

export function relayError(code: RelayErrorCode, message: string): RelayErrorBody {
  return { error: { code, message } };
}

export const RegisterRequestSchema = Type.Object({
  platform: Type.Union([Type.Literal("webhook"), Type.Literal("apns")]),
  token: Type.String({ minLength: 1, maxLength: 2048 }),
});
export type RegisterRequest = Static<typeof RegisterRequestSchema>;

/** Far above any real payload; bounds abuse (design spec, section 3). */
export const CIPHERTEXT_MAX_LENGTH = 8192;

export const NotifyRequestSchema = Type.Object({
  pushId: Type.String({ minLength: 1 }),
  ciphertext: Type.String({ minLength: 1, maxLength: CIPHERTEXT_MAX_LENGTH }),
});
export type NotifyRequest = Static<typeof NotifyRequestSchema>;
```

`packages/relay/src/storage.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registrations (
  push_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notify_counts (
  push_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (push_id, day)
) STRICT, WITHOUT ROWID;
`;

export interface RegistrationRow {
  pushId: string;
  platform: string;
  token: string;
}

/** UTC calendar day, "YYYY-MM-DD". The daily cap rolls over at midnight UTC. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export class RelayStorage {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  saveRegistration(reg: { pushId: string; platform: string; token: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO registrations (push_id, platform, token, created_at) VALUES (?, ?, ?, ?)")
      .run(reg.pushId, reg.platform, reg.token, reg.createdAt);
  }

  registrationByPushId(pushId: string): RegistrationRow | undefined {
    return this.#db
      .prepare("SELECT push_id AS pushId, platform, token FROM registrations WHERE push_id = ?")
      .get(pushId) as RegistrationRow | undefined;
  }

  deleteRegistration(pushId: string): void {
    this.#db.prepare("DELETE FROM registrations WHERE push_id = ?").run(pushId);
  }

  notifyCount(pushId: string, day: string): number {
    const row = this.#db
      .prepare("SELECT count FROM notify_counts WHERE push_id = ? AND day = ?")
      .get(pushId, day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  incrementNotifyCount(pushId: string, day: string): void {
    this.#db
      .prepare(
        `INSERT INTO notify_counts (push_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(push_id, day) DO UPDATE SET count = count + 1`,
      )
      .run(pushId, day);
  }

  close(): void {
    this.#db.close();
  }
}

export function openRelayStorage(dbPath: string): RelayStorage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return new RelayStorage(db);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/storage.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/relay pnpm-lock.yaml && git commit -m "feat(relay): package scaffold, request schemas, sqlite storage"
```

---

### Task 2: Transports and the relay HTTP app

**Files:**
- Create: `packages/relay/src/transports.ts`, `packages/relay/src/http.ts`
- Test: `packages/relay/test/transports.test.ts`, `packages/relay/test/routes.test.ts`

**Interfaces:**
- Consumes (Task 1): `RegisterRequestSchema`, `NotifyRequestSchema`, `relayError` from `./schemas.ts`; `RelayStorage`, `utcDay` from `./storage.ts`.
- Produces:
  - transports.ts: `interface Transport { deliver(token: string, ciphertext: string): Promise<void> }`, `webhookTransport(fetchImpl?: typeof fetch): Transport`, `DELIVERY_TIMEOUT_MS`
  - http.ts: `createRelayApp(deps: RelayAppDeps): Hono` where `interface RelayAppDeps { storage: RelayStorage; transports: Readonly<Record<string, Transport | undefined>>; dailyCap: number; version: string; now: () => number; log?: (message: string) => void }`

- [ ] **Step 1: Write the failing transports test**

`packages/relay/test/transports.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { webhookTransport } from "../src/transports.ts";

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe("webhook transport", () => {
  it("POSTs {ciphertext} to the token URL", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await webhookTransport(fetchImpl).deliver("https://x.example/hook", "CIPHER");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://x.example/hook");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ ciphertext: "CIPHER" });
  });

  it("throws on a non-2xx response", async () => {
    await expect(webhookTransport(fetchReturning(500)).deliver("https://x.example/hook", "C")).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("throws when fetch rejects", async () => {
    const failing = (async () => {
      throw new Error("connect refused");
    }) as typeof fetch;
    await expect(webhookTransport(failing).deliver("https://x.example/hook", "C")).rejects.toThrow("connect refused");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/transports.test.ts`
Expected: FAIL (cannot resolve `../src/transports.ts`).

- [ ] **Step 3: Implement transports**

`packages/relay/src/transports.ts`:

```ts
export const DELIVERY_TIMEOUT_MS = 10_000;

/** A delivery transport. The APNs transport plugs in here in the phone-app phase without
 *  touching routes or storage (design spec, section 3). */
export interface Transport {
  deliver(token: string, ciphertext: string): Promise<void>;
}

/** Delivers by POSTing {ciphertext} to the registered URL. This is also the shape a
 *  UnifiedPush-style endpoint consumes, so a generic push server can be pointed at directly. */
export function webhookTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async deliver(token: string, ciphertext: string): Promise<void> {
      const res = await fetchImpl(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ciphertext }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
    },
  };
}
```

- [ ] **Step 4: Run the transports test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/transports.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing routes test**

`packages/relay/test/routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { createRelayApp } from "../src/http.ts";
import { openRelayStorage, type RelayStorage } from "../src/storage.ts";
import type { Transport } from "../src/transports.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Delivery {
  token: string;
  ciphertext: string;
}

function harness(overrides?: {
  dailyCap?: number;
  failDelivery?: boolean;
  nowRef?: { value: number };
}): { app: ReturnType<typeof createRelayApp>; storage: RelayStorage; deliveries: Delivery[] } {
  const storage = openRelayStorage(":memory:");
  cleanups.push(() => storage.close());
  const deliveries: Delivery[] = [];
  const transport: Transport = {
    deliver: async (token, ciphertext) => {
      if (overrides?.failDelivery === true) throw new Error("delivery boom");
      deliveries.push({ token, ciphertext });
    },
  };
  const nowRef = overrides?.nowRef ?? { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
  const app = createRelayApp({
    storage,
    transports: { webhook: transport },
    dailyCap: overrides?.dailyCap ?? 500,
    version: "test",
    now: () => nowRef.value,
    log: () => {},
  });
  return { app, storage, deliveries };
}

async function register(app: ReturnType<typeof createRelayApp>, body: unknown): Promise<Response> {
  return app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function notify(app: ReturnType<typeof createRelayApp>, body: unknown): Promise<Response> {
  return app.request("/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registeredPushId(app: ReturnType<typeof createRelayApp>): Promise<string> {
  const res = await register(app, { platform: "webhook", token: "https://x.example/hook" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { pushId: string };
  return body.pushId;
}

describe("POST /register", () => {
  it("registers a webhook and mints an unguessable push id", async () => {
    const { app } = harness();
    const first = await registeredPushId(app);
    const second = await registeredPushId(app);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(21);
  });

  it("rejects a malformed body", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "webhook" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a webhook token that is not an http(s) URL", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "webhook", token: "ftp://x.example/hook" });
    expect(res.status).toBe(400);
  });

  it("501s the recognized-but-unimplemented apns platform", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "apns", token: "device-token" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_platform");
  });
});

describe("POST /notify", () => {
  it("delivers ciphertext through the transport and 202s", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "CIPHER" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([{ token: "https://x.example/hook", ciphertext: "CIPHER" }]);
  });

  it("404s an unknown push id", async () => {
    const { app } = harness();
    const res = await notify(app, { pushId: "nope", ciphertext: "C" });
    expect(res.status).toBe(404);
  });

  it("still 202s and counts when delivery fails", async () => {
    const { app, storage, deliveries } = harness({ failDelivery: true });
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toHaveLength(0);
    expect(storage.notifyCount(pushId, "2026-07-07")).toBe(1);
  });

  it("enforces the daily cap, which rolls over at midnight UTC", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
    const { app } = harness({ dailyCap: 2, nowRef });
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    const capped = await notify(app, { pushId, ciphertext: "C" });
    expect(capped.status).toBe(429);
    const cappedBody = (await capped.json()) as { error: { code: string } };
    expect(cappedBody.error.code).toBe("over_cap");
    nowRef.value = Date.UTC(2026, 6, 8, 0, 0, 1);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
  });

  it("rejects oversized ciphertext", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "x".repeat(8193) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /register/:pushId", () => {
  it("deletes and is idempotent", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    expect((await app.request(`/register/${pushId}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/register/${pushId}`, { method: "DELETE" })).status).toBe(204);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(404);
  });
});

describe("envelope faults", () => {
  it("404s unknown routes with the error envelope", async () => {
    const { app } = harness();
    const res = await app.request("/bogus");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("serves /health", async () => {
    const { app } = harness();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "cozygateway-relay", version: "test" });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/routes.test.ts`
Expected: FAIL (cannot resolve `../src/http.ts`).

- [ ] **Step 7: Implement the HTTP app**

`packages/relay/src/http.ts`:

```ts
import { randomBytes } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

import { NotifyRequestSchema, RegisterRequestSchema, relayError } from "./schemas.ts";
import { utcDay, type RelayStorage } from "./storage.ts";
import type { Transport } from "./transports.ts";

export interface RelayAppDeps {
  storage: RelayStorage;
  /** Keyed by platform. A platform with no transport is recognized but unavailable (501). */
  transports: Readonly<Record<string, Transport | undefined>>;
  dailyCap: number;
  version: string;
  now: () => number;
  log?: (message: string) => void;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createRelayApp(deps: RelayAppDeps): Hono {
  const log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const app = new Hono();

  // Auth hook: the hosted instance's future unlock check lands in this single middleware slot.
  // v0 ships open with abuse caps only (design spec, section 2, decision 2).
  const authHook = createMiddleware(async (_c, next) => {
    await next();
  });
  app.use("/register", authHook);
  app.use("/notify", authHook);

  const readBody = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  const parseBody = <S extends TSchema>(schema: S, body: unknown): Static<S> | undefined =>
    Value.Check(schema, body) ? (body as Static<S>) : undefined;

  app.get("/health", (c) => c.json({ name: "cozygateway-relay", version: deps.version }));

  app.post("/register", async (c) => {
    const parsed = parseBody(RegisterRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed register body"), 400);
    if (deps.transports[parsed.platform] === undefined) {
      return c.json(
        relayError("unsupported_platform", `platform "${parsed.platform}" is not available on this relay yet`),
        501,
      );
    }
    if (parsed.platform === "webhook" && !isHttpUrl(parsed.token)) {
      return c.json(relayError("invalid_request", "webhook token must be an http(s) URL"), 400);
    }
    const pushId = randomBytes(16).toString("base64url");
    deps.storage.saveRegistration({
      pushId,
      platform: parsed.platform,
      token: parsed.token,
      createdAt: deps.now(),
    });
    return c.json({ pushId }, 201);
  });

  app.post("/notify", async (c) => {
    const parsed = parseBody(NotifyRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed notify body"), 400);
    const registration = deps.storage.registrationByPushId(parsed.pushId);
    if (registration === undefined) return c.json(relayError("not_found", "unknown push id"), 404);
    const day = utcDay(deps.now());
    if (deps.storage.notifyCount(registration.pushId, day) >= deps.dailyCap) {
      return c.json(relayError("over_cap", "daily notification cap reached for this push id"), 429);
    }
    deps.storage.incrementNotifyCount(registration.pushId, day);
    const transport = deps.transports[registration.platform];
    if (transport === undefined) {
      log(`push id ${registration.pushId}: no transport for platform "${registration.platform}"`);
      return c.json({}, 202);
    }
    // Delivery is best-effort and never blocks or fails the response (design spec, section 3):
    // the notify counts against the cap whether or not delivery succeeds.
    void transport.deliver(registration.token, parsed.ciphertext).catch((err: unknown) => {
      log(`push id ${registration.pushId}: delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return c.json({}, 202);
  });

  app.delete("/register/:pushId", (c) => {
    deps.storage.deleteRegistration(c.req.param("pushId"));
    return c.body(null, 204);
  });

  app.notFound((c) => c.json(relayError("not_found", "no such route"), 404));
  app.onError((err, c) => {
    log(`unexpected relay fault: ${err.message}`);
    return c.json(relayError("internal", "unexpected relay fault"), 500);
  });

  return app;
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run`
Expected: PASS (storage, transports, routes).

- [ ] **Step 9: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/relay && git commit -m "feat(relay): webhook transport and register/notify/delete routes with daily cap"
```

---

### Task 3: Relay server, CLI, contract doc, and README

**Files:**
- Create: `packages/relay/src/server.ts`, `packages/relay/src/cli.ts`, `packages/relay/src/index.ts`
- Create: `contract/push-v0.md`, `packages/relay/README.md`
- Test: `packages/relay/test/server.test.ts`, `packages/relay/test/cli.test.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `createRelayApp`, `openRelayStorage`, `webhookTransport`.
- Produces:
  - server.ts: `RELAY_VERSION`, `DEFAULT_DAILY_CAP` (500), `interface RelayConfig {port; host; dbPath; dailyCap}`, `interface RunningRelay {url; port; storage; close(): Promise<void>}`, `startRelay(config: RelayConfig): Promise<RunningRelay>`
  - cli.ts: `parseCliConfig(argv: string[]): RelayConfig`, `runCli(argv: string[]): Promise<number>`
  - index.ts re-exports; Task 6's e2e imports `startRelay`, `type RunningRelay` from `cozygateway-relay`.

- [ ] **Step 1: Write the failing server test**

`packages/relay/test/server.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DAILY_CAP, RELAY_VERSION, startRelay, type RunningRelay } from "../src/server.ts";

let relay: RunningRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("startRelay", () => {
  it("serves the app over real HTTP on an ephemeral port", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: ":memory:", dailyCap: DEFAULT_DAILY_CAP });
    expect(relay.url).toBe(`http://127.0.0.1:${relay.port}`);
    const health = await fetch(`${relay.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ name: "cozygateway-relay", version: RELAY_VERSION });
    const res = await fetch(`${relay.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "webhook", token: "https://x.example/hook" }),
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/server.test.ts`
Expected: FAIL (cannot resolve `../src/server.ts`).

- [ ] **Step 3: Implement server, CLI, and index**

`packages/relay/src/server.ts`:

```ts
import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { createRelayApp } from "./http.ts";
import { openRelayStorage, type RelayStorage } from "./storage.ts";
import { webhookTransport } from "./transports.ts";

export const RELAY_VERSION = "0.1.0";
export const DEFAULT_DAILY_CAP = 500;

export interface RelayConfig {
  port: number;
  host: string;
  dbPath: string;
  dailyCap: number;
}

export interface RunningRelay {
  url: string;
  port: number;
  storage: RelayStorage;
  close(): Promise<void>;
}

export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const storage = openRelayStorage(config.dbPath);
  const app = createRelayApp({
    storage,
    transports: { webhook: webhookTransport() },
    dailyCap: config.dailyCap,
    version: RELAY_VERSION,
    now: () => Date.now(),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
      resolve(s as Server);
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;
  return {
    url: `http://${config.host}:${port}`,
    port,
    storage,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      storage.close();
    },
  };
}
```

`packages/relay/src/cli.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";

import { DEFAULT_DAILY_CAP, RELAY_VERSION, startRelay, type RelayConfig } from "./server.ts";

const USAGE = "usage: cozy-push-relay [--port 8788] [--host 127.0.0.1] [--db relay.db] [--daily-cap 500]";

export function parseCliConfig(argv: string[]): RelayConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "8788" },
      host: { type: "string", default: "127.0.0.1" },
      db: { type: "string", default: "relay.db" },
      "daily-cap": { type: "string", default: String(DEFAULT_DAILY_CAP) },
    },
  });
  const port = Number(values.port);
  const dailyCap = Number(values["daily-cap"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port "${values.port}"`);
  if (!Number.isInteger(dailyCap) || dailyCap < 1) throw new Error(`invalid --daily-cap "${values["daily-cap"]}"`);
  return { port, host: values.host, dbPath: values.db, dailyCap };
}

export async function runCli(argv: string[]): Promise<number> {
  let config: RelayConfig;
  try {
    config = parseCliConfig(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 1;
  }
  const relay = await startRelay(config);
  console.log(`cozygateway-relay ${RELAY_VERSION} listening on ${relay.url}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await relay.close();
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") === true || process.argv[1]?.endsWith("cli.ts") === true;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
```

`packages/relay/src/index.ts`:

```ts
export {
  DEFAULT_DAILY_CAP,
  RELAY_VERSION,
  startRelay,
  type RelayConfig,
  type RunningRelay,
} from "./server.ts";
export { createRelayApp, type RelayAppDeps } from "./http.ts";
export { openRelayStorage, utcDay, RelayStorage, type RegistrationRow } from "./storage.ts";
export { webhookTransport, DELIVERY_TIMEOUT_MS, type Transport } from "./transports.ts";
export {
  CIPHERTEXT_MAX_LENGTH,
  RELAY_ERROR_CODES,
  relayError,
  NotifyRequestSchema,
  RegisterRequestSchema,
  type NotifyRequest,
  type RegisterRequest,
  type RelayErrorBody,
  type RelayErrorCode,
} from "./schemas.ts";
```

- [ ] **Step 4: Write the CLI parse test**

`packages/relay/test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseCliConfig } from "../src/cli.ts";

describe("parseCliConfig", () => {
  it("applies defaults", () => {
    expect(parseCliConfig([])).toEqual({ port: 8788, host: "127.0.0.1", dbPath: "relay.db", dailyCap: 500 });
  });

  it("parses overrides", () => {
    expect(parseCliConfig(["--port", "0", "--host", "0.0.0.0", "--db", ":memory:", "--daily-cap", "5"])).toEqual({
      port: 0,
      host: "0.0.0.0",
      dbPath: ":memory:",
      dailyCap: 5,
    });
  });

  it("rejects a non-numeric port and a zero cap", () => {
    expect(() => parseCliConfig(["--port", "abc"])).toThrow("invalid --port");
    expect(() => parseCliConfig(["--daily-cap", "0"])).toThrow("invalid --daily-cap");
  });
});
```

- [ ] **Step 5: Run the package tests to verify everything passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run`
Expected: PASS (all files).

- [ ] **Step 6: Write the contract doc**

`contract/push-v0.md` (complete file):

```markdown
# cozygateway push contract, v0

Status: v0, NOT frozen. This document may change until the phone app ships. The client
wire contract (`contract/v1.md`) is frozen and is not modified by this document; the
`POST /push/register` shape it defines is the gateway-side half of this flow.

## Roles

- **Gateway**: the user's self-hosted process. Knows the device's `pushKey`. Encrypts.
- **Relay**: a small forwarding service (self-hostable; a hosted instance exists). Maps an
  opaque `pushId` to a delivery transport. Never sees keys or plaintext.
- **Client**: registers with a relay, hands `pushId` + `relayUrl` + `pushKey` to its
  gateway via `POST /push/register` (contract v1), decrypts notifications on-device.

## Relay endpoints

All bodies are JSON. Errors use `{"error": {"code": string, "message": string}}` with
codes `invalid_request`, `not_found`, `over_cap`, `unsupported_platform`, `internal`.

### POST /register

Request: `{"platform": "webhook" | "apns", "token": string}`

- `webhook`: `token` is an `http(s)` URL. Delivery is `POST <token>` with body
  `{"ciphertext": string}`.
- `apns`: recognized, not yet available; returns 501 `unsupported_platform`.

Response: 201 `{"pushId": string}`. The pushId is 16 random bytes, base64url. It is
unguessable and knowing it is the de-facto capability to notify that registration.
Registering again mints a new pushId; old ids keep working until deleted.

### POST /notify

Request: `{"pushId": string, "ciphertext": string}` (`ciphertext` max 8192 chars).

Response: 202 `{}` once the notify is accepted and handed to the transport. Delivery is
best-effort; the relay does not queue or retry in v0, and a delivery failure still
returns 202 and still counts against the cap.

- Unknown pushId: 404 `not_found`. A gateway receiving this should delete its stored
  registration for that device.
- Per-pushId daily cap (default 500, UTC calendar day): 429 `over_cap`.

### DELETE /register/:pushId

Response: 204, idempotent.

### GET /health

Response: 200 `{"name": "cozygateway-relay", "version": string}`.

## Notification ciphertext

- Plaintext: UTF-8 JSON `{"threadId": string, "agentName": string, "preview": string}`.
  The gateway truncates `preview` to at most 200 characters.
- Key: HKDF-SHA256 with ikm = the UTF-8 bytes of the registered `pushKey` string exactly
  as received, salt = empty (zero-length), info = the ASCII string
  `cozygateway-push-v0`, output length = 32 bytes.
- Encryption: AES-256-GCM, 12-byte random nonce per notification, 16-byte tag.
- Wire form: `base64url(nonce || ciphertext || tag)`, no padding.

### Test vector

- pushKey: `test-push-key`
- derived key (hex): `ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62`
- nonce (hex): `000102030405060708090a0b`
- plaintext: `{"threadId":"thread-1","agentName":"Demo Agent","preview":"Hello from the gateway"}`
- ciphertext (base64url): `AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM`

## Gateway behavior (informative)

The gateway sends one notify per registered device when an agent reply commits while no
client is connected. Outcomes are fire-and-forget: 404 prunes that device's
registration; anything else is logged and the registration kept.
```

- [ ] **Step 7: Write the relay README**

`packages/relay/README.md` (complete file):

```markdown
# cozygateway-relay

The push relay for cozygateway. It maps opaque push ids to delivery transports and
forwards encrypted notification payloads it cannot read: no keys, no message content,
no account data. See `contract/push-v0.md` for the wire contract and the exact
ciphertext construction.

## Run

    npx cozygateway-relay
    # or, from a checkout:
    node dist/cli.js --port 8788 --host 127.0.0.1 --db relay.db --daily-cap 500

The relay binds `127.0.0.1` by default. A hosted instance runs behind its own
TLS-terminating reverse proxy; that proxy is out of scope here.

## Transports

`webhook` ships today: delivery is a `POST` of `{"ciphertext": ...}` to the registered
URL. Platform push transports (APNs) are planned; registering `platform: "apns"`
returns 501 until then.

## State

One SQLite file holding registrations (`pushId`, platform, token) and per-day notify
counts. Nothing else is stored.
```

- [ ] **Step 8: Run the full relay package check**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/relay && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm build && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: build clean, typecheck clean, all tests PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/relay contract/push-v0.md && git commit -m "feat(relay): server assembly, cli, push-v0 contract doc"
```

---

### Task 4: Gateway push crypto and storage read API

**Files:**
- Create: `packages/gateway/src/push-crypto.ts`
- Modify: `packages/gateway/src/storage.ts` (add two methods + one interface, after `savePushRegistration`)
- Test: `packages/gateway/test/push-crypto.test.ts`; extend `packages/gateway/test/storage.test.ts`

**Interfaces:**
- Consumes: existing `Storage` and `push_registrations` table (columns `device_id`, `push_id`, `relay_url`, `push_key`).
- Produces:
  - push-crypto.ts: `PUSH_HKDF_INFO` (`"cozygateway-push-v0"`), `interface PushPayload {threadId: string; agentName: string; preview: string}`, `derivePushKey(pushKey: string): Buffer`, `encryptPushPayload(pushKey: string, payload: PushPayload, nonce?: Buffer): string`
  - storage.ts: `interface PushRegistrationRow {deviceId: string; pushId: string; relayUrl: string; pushKey: string}`, `Storage.pushRegistrations(): PushRegistrationRow[]`, `Storage.deletePushRegistration(deviceId: string): void`

- [ ] **Step 1: Write the failing crypto test**

`packages/gateway/test/push-crypto.test.ts`. The decrypt helper is deliberately an
independent implementation of contract/push-v0.md (it must not call push-crypto code),
so the test catches a drift between the doc and the implementation:

```ts
import { createDecipheriv, hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PUSH_HKDF_INFO, derivePushKey, encryptPushPayload } from "../src/push-crypto.ts";

/** Independent decrypt per contract/push-v0.md; intentionally does NOT reuse push-crypto. */
function independentDecrypt(pushKey: string, wire: string): unknown {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(pushKey, "utf8"),
      Buffer.alloc(0),
      Buffer.from("cozygateway-push-v0", "utf8"),
      32,
    ),
  );
  const raw = Buffer.from(wire, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

describe("push crypto", () => {
  it("locks the contract/push-v0.md test vector byte for byte", () => {
    expect(PUSH_HKDF_INFO).toBe("cozygateway-push-v0");
    expect(derivePushKey("test-push-key").toString("hex")).toBe(
      "ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62",
    );
    const nonce = Buffer.from("000102030405060708090a0b", "hex");
    const wire = encryptPushPayload(
      "test-push-key",
      { threadId: "thread-1", agentName: "Demo Agent", preview: "Hello from the gateway" },
      nonce,
    );
    expect(wire).toBe(
      "AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM",
    );
  });

  it("round-trips through an independent decrypt with a random nonce", () => {
    const payload = { threadId: "t9", agentName: "Agent", preview: "hi there" };
    const wire = encryptPushPayload("another key, any string works", payload);
    expect(independentDecrypt("another key, any string works", wire)).toEqual(payload);
  });

  it("produces a fresh nonce per call", () => {
    const payload = { threadId: "t", agentName: "A", preview: "p" };
    expect(encryptPushPayload("k", payload)).not.toBe(encryptPushPayload("k", payload));
  });

  it("fails to decrypt under the wrong key (tag mismatch)", () => {
    const wire = encryptPushPayload("right-key", { threadId: "t", agentName: "A", preview: "p" });
    expect(() => independentDecrypt("wrong-key", wire)).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/push-crypto.test.ts`
Expected: FAIL (cannot resolve `../src/push-crypto.ts`).

- [ ] **Step 3: Implement push-crypto**

`packages/gateway/src/push-crypto.ts`:

```ts
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

/** HKDF info string, fixed by contract/push-v0.md. */
export const PUSH_HKDF_INFO = "cozygateway-push-v0";

export interface PushPayload {
  threadId: string;
  agentName: string;
  preview: string;
}

/** Contract v1 froze pushKey as ANY minLength-1 string, so the AES key is derived rather
 *  than decoded: HKDF-SHA256(ikm = utf8(pushKey), salt = empty, info = PUSH_HKDF_INFO, 32). */
export function derivePushKey(pushKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(pushKey, "utf8"), Buffer.alloc(0), Buffer.from(PUSH_HKDF_INFO, "utf8"), 32),
  );
}

/** base64url(nonce(12) || ciphertext || tag(16)) per contract/push-v0.md. The nonce
 *  parameter exists for the contract test vector; production callers omit it. */
export function encryptPushPayload(pushKey: string, payload: PushPayload, nonce: Buffer = randomBytes(12)): string {
  const key = derivePushKey(pushKey);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
}
```

- [ ] **Step 4: Run the crypto test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/push-crypto.test.ts`
Expected: PASS. If the vector assertion fails, the implementation is wrong (the vector
was verified by round-trip when the spec was written); fix the code, never the vector.

- [ ] **Step 5: Extend the storage test (failing first)**

Append to the existing describe block in `packages/gateway/test/storage.test.ts` (match
the file's existing setup helpers; it already tests `savePushRegistration` upsert
semantics or has an equivalent setup for devices):

```ts
it("lists and deletes push registrations", () => {
  // Reuse the file's existing storage + device setup pattern. Two devices, two registrations:
  storage.createDevice({ id: "d1", name: "phone", tokenHash: "h1", createdAt: 1 });
  storage.createDevice({ id: "d2", name: "tablet", tokenHash: "h2", createdAt: 2 });
  storage.savePushRegistration("d1", { pushId: "p1", relayUrl: "https://r.example", pushKey: "k1" });
  storage.savePushRegistration("d2", { pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" });
  expect(storage.pushRegistrations()).toEqual([
    { deviceId: "d1", pushId: "p1", relayUrl: "https://r.example", pushKey: "k1" },
    { deviceId: "d2", pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" },
  ]);
  storage.deletePushRegistration("d1");
  expect(storage.pushRegistrations()).toEqual([
    { deviceId: "d2", pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" },
  ]);
  storage.deletePushRegistration("d1");
});
```

If the existing file constructs storage differently (for example a fresh `openStorage(":memory:")`
per test), follow the file's local convention; the assertions above are the requirement.

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/storage.test.ts`
Expected: FAIL (`pushRegistrations is not a function`).

- [ ] **Step 6: Implement the storage additions**

In `packages/gateway/src/storage.ts`, add next to the existing `ThreadRow` exports:

```ts
export interface PushRegistrationRow {
  deviceId: string;
  pushId: string;
  relayUrl: string;
  pushKey: string;
}
```

and inside `class Storage`, directly after `savePushRegistration`:

```ts
pushRegistrations(): PushRegistrationRow[] {
  return this.#db
    .prepare(
      `SELECT device_id AS deviceId, push_id AS pushId, relay_url AS relayUrl, push_key AS pushKey
       FROM push_registrations ORDER BY device_id`,
    )
    .all() as unknown as PushRegistrationRow[];
}

deletePushRegistration(deviceId: string): void {
  this.#db.prepare("DELETE FROM push_registrations WHERE device_id = ?").run(deviceId);
}
```

- [ ] **Step 7: Run the gateway tests**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/storage.test.ts test/push-crypto.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/src/push-crypto.ts packages/gateway/src/storage.ts packages/gateway/test/push-crypto.test.ts packages/gateway/test/storage.test.ts && git commit -m "feat(gateway): push payload crypto (hkdf + aes-256-gcm) and registration read api"
```

---

### Task 5: RelayNotifier and server wiring

**Files:**
- Create: `packages/gateway/src/push-notifier.ts`
- Modify: `packages/gateway/src/server.ts` (notifier wiring only)
- Test: `packages/gateway/test/push-notifier.test.ts`

**Interfaces:**
- Consumes: `Notifier` from `./turns.ts`; `Storage`, `PushRegistrationRow` from `./storage.ts`; `encryptPushPayload`, `PushPayload` from `./push-crypto.ts`.
- Produces: `PREVIEW_MAX_CHARS` (200), `class RelayNotifier implements Notifier` with `constructor(deps: {storage: Storage; fetchImpl?: typeof fetch; log?: (message: string) => void})`. `notify()` returns void, never throws; all async work is internal and never surfaces a rejection.

- [ ] **Step 1: Write the failing notifier test**

`packages/gateway/test/push-notifier.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/push-notifier.test.ts`
Expected: FAIL (cannot resolve `../src/push-notifier.ts`).

- [ ] **Step 3: Implement the notifier**

`packages/gateway/src/push-notifier.ts`:

```ts
import type { Storage, PushRegistrationRow } from "./storage.ts";
import type { Notifier } from "./turns.ts";
import { encryptPushPayload, type PushPayload } from "./push-crypto.ts";

export const PREVIEW_MAX_CHARS = 200;
const NOTIFY_TIMEOUT_MS = 10_000;

export interface RelayNotifierDeps {
  storage: Storage;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** Posts encrypted notification payloads to each registered device's relay.
 *  Fire-and-forget by contract: notify() never throws, never rejects, and never blocks
 *  the turn that triggered it (design spec, section 4). */
export class RelayNotifier implements Notifier {
  readonly #storage: Storage;
  readonly #fetch: typeof fetch;
  readonly #log: (message: string) => void;

  constructor(deps: RelayNotifierDeps) {
    this.#storage = deps.storage;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  }

  notify(event: { threadId: string; agentName: string; preview: string }): void {
    let registrations: PushRegistrationRow[];
    try {
      registrations = this.#storage.pushRegistrations();
    } catch (err) {
      this.#log(`push: reading registrations failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (registrations.length === 0) return;
    const payload: PushPayload = {
      threadId: event.threadId,
      agentName: event.agentName,
      preview: event.preview.slice(0, PREVIEW_MAX_CHARS),
    };
    for (const registration of registrations) {
      void this.#send(registration, payload).catch((err: unknown) => {
        this.#log(
          `push: notify failed for device ${registration.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async #send(registration: PushRegistrationRow, payload: PushPayload): Promise<void> {
    const ciphertext = encryptPushPayload(registration.pushKey, payload);
    const url = `${registration.relayUrl.replace(/\/+$/, "")}/notify`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: registration.pushId, ciphertext }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The relay no longer knows this id; the registration is dead weight (push-v0). Prune it.
      this.#storage.deletePushRegistration(registration.deviceId);
      return;
    }
    if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
  }
}
```

- [ ] **Step 4: Run the notifier test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/push-notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the server**

In `packages/gateway/src/server.ts`:

- Change the import line `import { TurnRunner, nullNotifier } from "./turns.ts";` to
  `import { TurnRunner } from "./turns.ts";`
- Add `import { RelayNotifier } from "./push-notifier.ts";` with the other relative imports.
- Change the runner construction from `notifier: nullNotifier` to:

```ts
const runner = new TurnRunner({
  storage,
  hub,
  adapters,
  notifier: new RelayNotifier({ storage }),
  now: () => Date.now(),
});
```

`nullNotifier` stays exported from `turns.ts` (tests use it). Do not change `index.ts`.

- [ ] **Step 6: Run the full gateway suite**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run`
Expected: PASS (every existing test still green; server tests exercise the new wiring
with zero registrations, which is a no-op).

- [ ] **Step 7: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/src/push-notifier.ts packages/gateway/src/server.ts packages/gateway/test/push-notifier.test.ts && git commit -m "feat(gateway): RelayNotifier replaces nullNotifier for push origination"
```

---

### Task 6: Cross-package e2e, README status, full gate

**Files:**
- Modify: `packages/gateway/package.json` (add devDependency)
- Create: `packages/gateway/test/push-e2e.test.ts`
- Modify: `README.md` (root, status section)

**Interfaces:**
- Consumes: `startRelay`, `type RunningRelay` from `cozygateway-relay`; `startGateway`, `type RunningGateway` from `../src/server.ts`; the mock backend (`backend: "mock"`).

- [ ] **Step 1: Add the dev dependency**

In `packages/gateway/package.json`, add:

```json
"devDependencies": {
  "@types/ws": "^8.5.0",
  "cozygateway-relay": "workspace:*"
}
```

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm install && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm build`
Expected: install links the workspace package; build produces `packages/relay/dist` (the
gateway test imports resolve `cozygateway-relay` via its dist exports).

- [ ] **Step 2: Write the failing e2e test**

`packages/gateway/test/push-e2e.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startRelay, type RunningRelay } from "cozygateway-relay";
import { startGateway, type RunningGateway } from "../src/server.ts";

/** Independent decrypt per contract/push-v0.md. */
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

const PUSH_KEY = "e2e-push-key";

let gateway: RunningGateway;
let relay: RunningRelay;
let receiver: Server;
let receiverUrl: string;
let received: string[];
let receivedResolvers: Array<(ciphertext: string) => void>;
const sockets: WebSocket[] = [];

function nextDelivery(): Promise<string> {
  return new Promise((resolve) => {
    if (received.length > 0) {
      resolve(received.shift() ?? "");
      return;
    }
    receivedResolvers.push(resolve);
  });
}

beforeEach(async () => {
  received = [];
  receivedResolvers = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ciphertext: string };
      const resolver = receivedResolvers.shift();
      if (resolver !== undefined) resolver(body.ciphertext);
      else received.push(body.ciphertext);
      res.writeHead(200).end();
    });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const addr = receiver.address();
  if (addr === null || typeof addr !== "object") throw new Error("no receiver address");
  receiverUrl = `http://127.0.0.1:${addr.port}/push`;

  relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: ":memory:", dailyCap: 500 });
  gateway = await startGateway({
    name: "push-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "echo", name: "Echo", backend: "mock" }],
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  await gateway.close();
  await relay.close();
  await new Promise<void>((resolve, reject) => receiver.close((err) => (err ? reject(err) : resolve())));
});

async function pairDevice(): Promise<string> {
  const code = gateway.issueSetupCode();
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceToken: string };
  return body.deviceToken;
}

async function registerForPush(deviceToken: string): Promise<void> {
  const reg = await fetch(`${relay.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "webhook", token: receiverUrl }),
  });
  expect(reg.status).toBe(201);
  const { pushId } = (await reg.json()) as { pushId: string };
  const res = await fetch(`${gateway.url}/push/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ pushId, relayUrl: relay.url, pushKey: PUSH_KEY }),
  });
  expect(res.status).toBe(200);
}

async function createThread(deviceToken: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ agentId: "echo", title: "e2e" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function sendMessage(deviceToken: string, threadId: string, text: string): Promise<void> {
  const res = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ blocks: [{ type: "paragraph", text }] }),
  });
  expect(res.status).toBe(200);
}

describe("push e2e: gateway -> relay -> webhook", () => {
  it("delivers a decryptable push when no client is connected", async () => {
    const deviceToken = await pairDevice();
    await registerForPush(deviceToken);
    const threadId = await createThread(deviceToken);
    const delivery = nextDelivery();
    await sendMessage(deviceToken, threadId, "ping from e2e");
    const ciphertext = await delivery;
    const payload = decrypt(PUSH_KEY, ciphertext);
    expect(payload.threadId).toBe(threadId);
    expect(payload.agentName).toBe("Echo");
    expect(payload.preview.length).toBeGreaterThan(0);
  });

  it("does not push while a client is connected", async () => {
    const deviceToken = await pairDevice();
    await registerForPush(deviceToken);
    const threadId = await createThread(deviceToken);

    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
    // Wait for the agent turn to finish: collect frames until "done" for our thread.
    const doneSeen = new Promise<void>((resolve) => {
      ws.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as { type: string; threadId?: string };
        if (frame.type === "done" && frame.threadId === threadId) resolve();
      });
    });
    await sendMessage(deviceToken, threadId, "ping while connected");
    await doneSeen;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(0);
  });
});
```

NOTE for the implementer: check the auth/handshake shape against an existing client WS
test (`packages/gateway/test/ws-hub.test.ts` or `server.test.ts`) before running: the
first client frame MUST match what the hub expects (contract v1: `{"type":"auth","token"}`,
optionally followed by `{"type":"sync","threads":{}}`). If the hub requires a sync frame
before broadcasting, send `{ type: "sync", threads: {} }` right after auth. Adjust only
that handshake portion; the assertions stand.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm vitest run test/push-e2e.test.ts`
Expected: the first test FAILS before the implementation is complete ONLY if Tasks 4-5
are unmerged; on a branch where Tasks 1-5 are done this should PASS on the first run.
If it fails, debug the seam it names (this is the integration gate, not new code).

- [ ] **Step 4: Update the root README status**

In the root `README.md` Status section: move the push relay from planned to shipped.
Replace the "next up (planned)" sentence so it reads (adjust surrounding punctuation to
match the file):

- Shipped: contract v1 (frozen), reference gateway, conformance suite, attach backend
  adapter, push relay + encrypted push origination (`contract/push-v0.md`).
- Planned: the phone app, platform push transports (APNs), TLS for the phone link,
  additional backend adapters.

Also add `packages/relay` to the repo-layout bullets with a one-line description:
"`packages/relay`: the push relay service (opaque push ids in, ciphertext through)."

Honest-copy rule applies: no promised features beyond "planned", no harness names.

- [ ] **Step 5: Run the FULL workspace gate**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: build 4/4 packages, typecheck 4/4, tests all green including conformance
21/21 and the new relay + push suites.

- [ ] **Step 6: Hygiene greps**

Run:

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && grep -rn $'—' packages/relay contract/push-v0.md packages/gateway/src/push-crypto.ts packages/gateway/src/push-notifier.ts docs/plans/2026-07-07-push-relay.md README.md | grep -v Binary || echo "no em-dashes"
cd /Users/kmcdowell/Documents/repos/cozygateway && grep -rni "hermes\|cozylabs\|openclaw\|claude" packages/relay contract/push-v0.md packages/gateway/src/push-crypto.ts packages/gateway/src/push-notifier.ts README.md || echo "copy clean"
```

Expected: `no em-dashes` and `copy clean`.

- [ ] **Step 7: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/package.json packages/gateway/test/push-e2e.test.ts README.md pnpm-lock.yaml && git commit -m "test(gateway): push e2e through a real relay; README status for the push relay"
```

---

## After the tasks (executor, not subagents)

1. Live validation per the design spec, section 7: gateway + relay as separate
   processes, the Phase 3 attach agent, a local webhook listener, agent reply with no
   client connected, decrypt and verify; then repeat with a client connected and assert
   no push. Write findings to `.superpowers/sdd/live-validation-push-2026-07-07.md`.
2. Final whole-branch review (opus), fixes, re-gate.
3. Merge `feat/push-relay` to main with `--no-ff`; full gate on main; push only with
   Kyle's approval.
