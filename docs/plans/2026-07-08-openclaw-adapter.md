# OpenClaw Backend Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-mode backend adapter so the cozygateway gateway can dial OUT to a running OpenClaw gateway (Gateway WS protocol v4, operator role) and serve its agents as cozygateway threads, streaming rich drafts.

**Architecture:** A new `packages/gateway/src/adapters/openclaw/` directory holds the WS operator client (`client.ts`), typed wire frames (`protocol.ts`), and the `BackendAdapter` implementation (`adapter.ts`). A new backend-agnostic `packages/gateway/src/markdown-blocks.ts` ports the reference plugin's markdown-to-RichBlock normalizer so any text-streaming backend produces the same rich drafts. Registry and config gain an `openclaw` branch. Verified unknowns in the v4 wire (reply-end signal, device-auth signature bytes, per-event session id) are resolved by a bounded live-study task, not guessed in code; the design's decisions govern everything else.

**Tech Stack:** TypeScript (pure ESM, `.ts` import specifiers, erasableSyntaxOnly), `ws ^8.18.0` (already a gateway dependency), `@sinclair/typebox` for wire-frame schemas + the shared `check()` guard, Vitest (no config file; tests are `packages/gateway/test/*.test.ts`), Node crypto for device-auth signing. Python stdlib for the fixture-export test.

## Global Constraints

- Contract v1 (`contract/v1.md`) is FROZEN; the conformance suite must stay 21/21; no change to any client-facing WS/REST frame.
- Pure ESM, `.ts` import specifiers, `erasableSyntaxOnly`; no `enum`, no parameter properties.
- No em-dashes anywhere in code, comments, docs, or copy.
- Public/copy rule: "works with OpenClaw" nominative framing ONLY; never "Claw" in our own naming; never name a coding-agent harness in public copy.
- The OpenClaw operator token is ROOT on the target gateway: it rides `tokenEnv` (an env var name in config `options`), never inline in config; it is never logged, never echoed into error messages, never serialized into any frame our own clients receive.
- Test convention: `(await res.json()) as {shape}` and typed literal test data; do not fabricate data with broad `as` casts.
- `PROTOCOL_VERSION = 4` is pinned; a version-incompatible handshake fails closed (presence `absent`, logged reason), never best-effort-parses an unknown wire.
- Node via `PATH=/opt/homebrew/opt/node@26/bin:$PATH` on every pnpm command. Package test: `cd packages/gateway && pnpm test`. Full gate from repo root: `pnpm check`.
- Every task ends green on the full gate before it is considered done.
- Adapter must implement `BackendAdapter`/`BackendSession` from `packages/gateway/src/adapters/types.ts` exactly; drafts are full-replace; a failed turn REJECTS the `send()` promise (no onCommit/onDone).

## Verified wire facts (from https://docs.openclaw.ai/gateway/protocol, protocol v4)

Frames are JSON text. Envelopes: request `{type:"req", id, method, params}`; response `{type:"res", id, ok, payload}` or `{type:"res", id, ok:false, error:{details:{code, reason}}}`; event `{type:"event", event, payload, seq?, stateVersion?}`.

- **connect** (first frame, operator): `{type:"req", id, method:"connect", params:{minProtocol:4, maxProtocol:4, client:{id, version, platform, mode:"operator"}, role:"operator", scopes:["operator.read","operator.write"], auth:{token}, device?:{id, publicKey, signature, signedAt, nonce}}}`.
- **connect.challenge** (server event, before connect completes): `{type:"event", event:"connect.challenge", payload:{nonce, ts}}`. The client signs a payload binding device/client/role/scopes/token/nonce (+ platform/deviceFamily in v3) and echoes `nonce` in `connect.params.device.nonce`.
- **hello-ok** (connect response): `{type:"res", id, ok:true, payload:{type:"hello-ok", protocol:4, server:{version, connId}, features:{methods, events}, auth:{role, scopes}, policy:{maxPayload, maxBufferedBytes, tickIntervalMs}}}`.
- **chat.send**: `{type:"req", id, method:"chat.send", params:{sessionKey, text}}`; response correlates by `id`, `ok` boolean.
- **sessions.create**: creates a session entry, returns a `sessionKey` (exact response field confirmed by the live-study task; see Task 8).
- **chat delta events**: carry `deltaText`; `message` is the cumulative assistant snapshot; `replace:true` means `deltaText` replaces the snapshot rather than appends.
- **tick**: periodic keepalive event; `policy.tickIntervalMs` (default pre-handshake 30000). Silence beyond `tickIntervalMs * 2` closes with code **4000**.
- Tool events exist on the operator wire behind `operator.read` scope (kept for a follow-up, not v0).

**Unknowns the docs do not fully pin (resolved by Task 8 live study before any merge claim; coded with a documented assumption + fallback):** (a) the exact event name(s) for streamed assistant deltas and the precise field carrying the session id on each event, (b) how a reply's END is signaled, (c) the device-auth signature byte construction and key type. Where code must assume, it isolates the assumption behind a single named constant/function and a `// ASSUMPTION (Task 8 to verify):` comment.

---

## File Structure

- Create `packages/gateway/src/markdown-blocks.ts` - backend-agnostic `normalizeMarkdownToBlocks(text: string): RichBlock[]`, TS port of the plugin normalizer.
- Create `packages/gateway/test/markdown-blocks.test.ts` - parity tests against exported Python vectors + unit cases.
- Create `packages/gateway/test/fixtures/markdown-blocks-vectors.json` - shared vectors (generated from the Python normalizer).
- Create `integrations/attach-plugin/tests/test_export_vectors.py` - regenerates + asserts the JSON vectors stay in sync with the Python normalizer.
- Create `packages/gateway/src/adapters/openclaw/protocol.ts` - TypeBox schemas + `check()` guards for v4 frames, `PROTOCOL_VERSION`, `TICK_TIMEOUT_CLOSE_CODE`.
- Create `packages/gateway/src/adapters/openclaw/client.ts` - `OpenClawClient` operator WS client (dial, handshake, reconnect, tick, chat.send, event routing).
- Create `packages/gateway/src/adapters/openclaw/device-auth.ts` - challenge-response signing (isolated; Task 8 verifies bytes).
- Create `packages/gateway/src/adapters/openclaw/adapter.ts` - `createOpenClawAdapter` implementing `BackendAdapter`.
- Create `packages/gateway/test/openclaw-client.test.ts`, `packages/gateway/test/openclaw-adapter.test.ts`, `packages/gateway/test/support/fake-openclaw-server.ts`.
- Modify `packages/gateway/src/adapters/registry.ts` - add the `"openclaw"` branch.
- Modify `packages/gateway/src/server.ts` - construct OpenClaw adapters, wire presence to the hub, fail closed on missing token env before the listener opens.
- Modify `packages/gateway/README.md` - "Backends" section documenting the OpenClaw backend + root-token caveat.
- Create `packages/gateway/scripts/openclaw-canary.mjs` - non-gating live canary gated by `OPENCLAW_CANARY_URL`.
- Create `docs/specs/2026-07-08-openclaw-wire-study.md` - the bounded study checklist Task 8 fills in.

---

### Task 1: Shared markdown-to-blocks normalizer with cross-language parity vectors

**Files:**
- Create: `packages/gateway/src/markdown-blocks.ts`
- Create: `integrations/attach-plugin/tests/test_export_vectors.py`
- Create: `packages/gateway/test/fixtures/markdown-blocks-vectors.json`
- Test: `packages/gateway/test/markdown-blocks.test.ts`

**Interfaces:**
- Produces: `export function normalizeMarkdownToBlocks(text: string): RichBlock[]` - full re-normalization of accumulated text into contract `RichBlock[]`. v0 is non-incremental (re-normalizes the whole buffer per call); the incremental optimization is out of scope (spec section 11).

**Normalizer rules (transcribe exactly from the reference; the parity vectors are the correctness gate).** Dispatch order per line: blank, fence, math, heading, table, list, paragraph.
- blank (`line.trim() === ""`): flush the current paragraph; a top-level blank is a boundary.
- fence (`/^```(.*)$/`): capture verbatim until a line starting with ``` ``` ``` or end of buffer; emit `{type:"code", code: body.join("\n"), language: lang || undefined}` (unclosed fence at buffer end still emits a code block).
- math (`line.trim() === "$$"`): capture until the next `$$` line or end of buffer; emit `{type:"math", latex: body.join("\n").trim()}` (unclosed still emits).
- heading (`/^(#{1,6})\s+(.*)$/`): emit `{type:"heading", level: Math.min(hashes.length, 3) as 1|2|3, text: rest.trim()}`.
- table (current line has `|` and is non-blank, AND next line matches separator `/^\|?[\s:|-]+\|?$/` and contains `-`): consume header + separator + following pipe-rows; emit `{type:"table", header: cells, rows: [...] }` (cells split on `|` with outer pipes stripped and each cell trimmed). A pipe-row with no following separator stays a paragraph.
- list (`/^\s*[-*+]\s+(.*)$/` or `/^\s*\d+[.)]\s+(.*)$/`): consume the consecutive run; emit `{type:"list", items: ListItem[], ordered: boolean}` where `ordered` reflects the LAST consumed marker; each item is `{text}` unless it matches `/^\[([ xX])\]\s+(.*)$/`, then `{text: rest, checked: char.toLowerCase() === "x"}`.
- paragraph (fallthrough): accumulate lines; on any boundary join with `"\n"`, trim, and if non-empty emit `{type:"paragraph", text}`.

- [ ] **Step 1: Export the parity vectors from the Python normalizer**

Create `integrations/attach-plugin/tests/test_export_vectors.py`. It imports the plugin's `normalize_text_to_blocks` and the `FIXTURES` dict from `test_text_blocks_incremental.py`, serializes `{name: {"text": text, "blocks": [block-as-dict...]}}` to `packages/gateway/test/fixtures/markdown-blocks-vectors.json` (relative path resolved from the repo root), and asserts the on-disk file already matches (so the test fails if the JSON drifts from the Python output). Block dicts use the contract field names (`type`, `text`, `code`, `language`, `level`, `items`, `ordered`, `header`, `rows`, `latex`; omit absent optionals). Provide a `--write` argv branch to regenerate.

```python
import json, sys, pathlib
from cozygateway.text_blocks import normalize_text_to_blocks
from tests.test_text_blocks_incremental import FIXTURES

VECTORS = pathlib.Path(__file__).resolve().parents[3] / "packages/gateway/test/fixtures/markdown-blocks-vectors.json"

def block_to_dict(b):
    # Map each dataclass block to the contract JSON shape; omit absent optionals.
    ...  # transcribe per block type

def build():
    return {name: {"text": text, "blocks": [block_to_dict(b) for b in normalize_text_to_blocks(text)]} for name, text in sorted(FIXTURES.items())}

def test_vectors_in_sync():
    current = json.loads(VECTORS.read_text())
    assert current == build(), "vectors drifted; run: python -m tests.test_export_vectors --write"

if __name__ == "__main__" and "--write" in sys.argv:
    VECTORS.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n")
```

- [ ] **Step 2: Generate the vectors file and run the Python suite**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/integrations/attach-plugin && python3 -m tests.test_export_vectors --write && python3 -m unittest discover -s tests`
Expected: JSON file written; full plugin suite green including the new `test_vectors_in_sync`.

- [ ] **Step 3: Write the failing TS parity test**

`packages/gateway/test/markdown-blocks.test.ts`: load the JSON vectors, and for each named fixture assert `normalizeMarkdownToBlocks(text)` deep-equals `blocks`. Also add three direct unit cases with typed literals: a fenced code block, an unclosed trailing fence (still a code block), and a task list (`- [x] done` yields `{type:"list", items:[{text:"done", checked:true}], ordered:false}`).

```ts
import { describe, it, expect } from "vitest";
import vectors from "./fixtures/markdown-blocks-vectors.json" with { type: "json" };
import { normalizeMarkdownToBlocks } from "../src/markdown-blocks.ts";
import type { RichBlock } from "cozygateway-contract";

describe("normalizeMarkdownToBlocks parity", () => {
  for (const [name, v] of Object.entries(vectors as Record<string, { text: string; blocks: RichBlock[] }>)) {
    it(`matches the reference normalizer: ${name}`, () => {
      expect(normalizeMarkdownToBlocks(v.text)).toEqual(v.blocks);
    });
  }
});
```

- [ ] **Step 4: Run it and confirm it fails** (`Cannot find module ../src/markdown-blocks.ts`).

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test markdown-blocks`
Expected: FAIL (module missing).

- [ ] **Step 5: Implement `normalizeMarkdownToBlocks`** per the rule table above, importing `RichBlock`/`ListItem` types from `cozygateway-contract`. Split on `/\r\n?/`-normalized `\n`; single-pass line dispatch; helper functions per construct.

- [ ] **Step 6: Run parity + unit tests to green.**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway/packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test markdown-blocks`
Expected: PASS (all fixtures + 3 unit cases). Iterate the implementation until byte-parity holds.

- [ ] **Step 7: Full gate + commit.**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
```bash
git add packages/gateway/src/markdown-blocks.ts packages/gateway/test/markdown-blocks.test.ts packages/gateway/test/fixtures/markdown-blocks-vectors.json integrations/attach-plugin/tests/test_export_vectors.py
git commit -m "feat(gateway): shared markdown-to-RichBlock normalizer with cross-language parity vectors"
```

---

### Task 2: OpenClaw v4 wire frames (typed schemas + guards)

**Files:**
- Create: `packages/gateway/src/adapters/openclaw/protocol.ts`
- Test: `packages/gateway/test/openclaw-protocol.test.ts`

**Interfaces:**
- Produces: `export const PROTOCOL_VERSION = 4;` `export const TICK_TIMEOUT_CLOSE_CODE = 4000;`
- Produces TypeBox schemas + derived types + `check()`-based guards for the frames in "Verified wire facts": `ConnectChallengeEvent`, `HelloOkResponse`, `ResponseFrame` (ok + error variants), `ChatDeltaEvent`, `TickEvent`, and a top-level `ServerFrame` union guard `parseServerFrame(raw: unknown): ServerFrame | undefined`.
- Produces builders for outbound frames: `buildConnectRequest`, `buildChatSendRequest`, `buildSessionsCreateRequest` returning typed objects with a caller-supplied `id`.

- [ ] **Step 1: Write failing tests** (`openclaw-protocol.test.ts`): `parseServerFrame` accepts a real hello-ok payload and returns it typed; accepts a `connect.challenge` event; accepts a chat delta event with `deltaText`+`message`+`replace`; tolerates unknown extra fields (open objects); returns `undefined` for a frame with an unknown `type`; `buildConnectRequest({token, nonce, device})` places the token at `params.auth.token` and `minProtocol===maxProtocol===4` and `role==="operator"`.

```ts
it("parses a hello-ok response and exposes the tick interval", () => {
  const frame = parseServerFrame({ type: "res", id: "1", ok: true, payload: { type: "hello-ok", protocol: 4, server: { version: "x", connId: "c" }, features: { methods: [], events: [] }, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 15000 } } });
  expect(frame?.kind).toBe("hello-ok");
  if (frame?.kind === "hello-ok") expect(frame.payload.policy.tickIntervalMs).toBe(15000);
});
```

- [ ] **Step 2: Run, confirm fail** (module missing). Run: `pnpm test openclaw-protocol`.
- [ ] **Step 3: Implement** `protocol.ts` with TypeBox schemas mirroring the verified facts; `parseServerFrame` discriminates on `type` then on `event`/`payload.type`, returning a tagged union (`{kind:"hello-ok"|"challenge"|"response"|"delta"|"tick", ...}`) or `undefined`; builders return typed request objects. Objects stay open (unknown fields ignored), discriminants closed.
- [ ] **Step 4: Run to green.** Run: `pnpm test openclaw-protocol`.
- [ ] **Step 5: Full gate + commit** (`feat(gateway): typed OpenClaw v4 wire frames and guards`).

---

### Task 3: Device-auth challenge signing (isolated, study-verified)

**Files:**
- Create: `packages/gateway/src/adapters/openclaw/device-auth.ts`
- Test: `packages/gateway/test/openclaw-device-auth.test.ts`

**Interfaces:**
- Produces: `export interface DeviceIdentity { id: string; publicKey: string; privateKey: string; }`
- Produces: `export function generateDeviceIdentity(): DeviceIdentity` (Ed25519 keypair via `node:crypto`, keys base64).
- Produces: `export function signChallenge(input: { identity: DeviceIdentity; nonce: string; token: string; role: string; scopes: string[]; platform: string; }): { signature: string; signedAt: number; nonce: string; }` - builds the canonical payload string and signs it.

Rationale: token-only operator auth requires an explicit trust path server-side (`allowInsecureAuth`/`trusted-proxy`), so the general path signs a device challenge. The exact byte construction is a documented ASSUMPTION isolated here; Task 8 verifies it against `buildDeviceAuthPayloadV3` on a live gateway and, if it differs, only this file changes.

- [ ] **Step 1: Write failing tests**: `generateDeviceIdentity` returns distinct base64 keys; `signChallenge` is deterministic for a fixed identity+nonce (sign twice, equal signatures) and its signature verifies against the public key with `crypto.verify(null, payloadBytes, publicKey, sigBytes)`; changing the nonce changes the signature.
- [ ] **Step 2: Run, confirm fail.** Run: `pnpm test openclaw-device-auth`.
- [ ] **Step 3: Implement** using `crypto.generateKeyPairSync("ed25519")` and `crypto.sign(null, Buffer.from(payload), privateKey)`. The payload is a single ASSUMPTION-commented function `buildAuthPayloadV3(input)` concatenating `device.id, client fields, role, scopes.join(","), token, nonce, platform, deviceFamily` in a fixed, documented order with a version tag prefix `"v3"`; keep it one function so Task 8 can correct it in isolation.

```ts
// ASSUMPTION (Task 8 to verify against buildDeviceAuthPayloadV3 on a live gateway):
// canonical payload = ["v3", identity.id, "operator", scopes.join(","), token, nonce, platform, "server"].join("\n")
```

- [ ] **Step 4: Run to green.** Run: `pnpm test openclaw-device-auth`.
- [ ] **Step 5: Full gate + commit** (`feat(gateway): OpenClaw device-auth challenge signing (isolated, study-verified)`).

---

### Task 4: OpenClaw operator client - connection, handshake, reconnect, tick

**Files:**
- Create: `packages/gateway/src/adapters/openclaw/client.ts`
- Create: `packages/gateway/test/support/fake-openclaw-server.ts`
- Test: `packages/gateway/test/openclaw-client.test.ts`

**Interfaces:**
- Consumes: `protocol.ts` (Task 2), `device-auth.ts` (Task 3).
- Produces:
```ts
export interface OpenClawClientOptions {
  url: string;
  token: string;
  identity: DeviceIdentity;
  protocolVersion?: number;        // default PROTOCOL_VERSION
  reconnect?: { minMs: number; maxMs: number }; // default { minMs: 500, maxMs: 15000 }
  now?: () => number;              // injectable clock for tests
}
export type ClientState = "connecting" | "online" | "absent";
export interface OpenClawClient {
  state(): ClientState;
  request(method: string, params: unknown): Promise<unknown>; // resolves on matching res.ok, rejects on res.ok:false or disconnect
  onEvent(handler: (frame: ServerFrame) => void): void;       // delta/tick/other events after hello-ok
  onStateChange(handler: (state: ClientState) => void): void;
  start(): void;   // begins the connect+reconnect loop
  close(): Promise<void>;
}
export function createOpenClawClient(opts: OpenClawClientOptions): OpenClawClient;
```
- Produces the fake server: `export function startFakeOpenClawServer(behavior): Promise<{ url: string; close(): Promise<void>; ... }>` speaking recorded v4 frames, with knobs to send a version-mismatch hello, drop the socket mid-turn, and go silent (no ticks) to trigger the 4000 close.

- [ ] **Step 1: Write failing tests** against the fake server: (a) `start()` performs connect->challenge->signed-connect->hello-ok and reaches `online`; (b) a hello-ok reporting `protocol: 3` leaves the client `absent` with no retbut-storm (fails closed, logged); (c) after `online`, a server-initiated socket drop transitions to `connecting` then `online` again with backoff (assert via injected clock that the delay grows, capped at `maxMs`); (d) `request("chat.send", ...)` resolves on the matching `res.ok:true` and rejects when the socket drops before the response; (e) silence beyond `tickIntervalMs*2` closes with 4000 and triggers reconnect; (f) token never appears in any thrown error message or log line captured via an injected log sink.
- [ ] **Step 2: Run, confirm fail.** Run: `pnpm test openclaw-client`.
- [ ] **Step 3: Implement `client.ts`**: one `ws` WebSocket, a state machine, an outstanding-request `Map<id, {resolve, reject}>` correlated by `id` (`randomUUID`), a tick-timeout timer reset on any inbound frame (using `policy.tickIntervalMs*2`), exponential backoff with jitter between `minMs` and `maxMs`, and a fail-all-pending step on every disconnect. All logging goes through an injected sink defaulting to `process.stderr.write`; never log token/payload content. `close()` is idempotent and cancels the reconnect loop.
- [ ] **Step 4: Run to green.** Run: `pnpm test openclaw-client`.
- [ ] **Step 5: Full gate + commit** (`feat(gateway): OpenClaw operator client with handshake, reconnect, tick timeout`).

---

### Task 5: Chat send, delta accumulation, session filtering, reply-end detection

**Files:**
- Modify: `packages/gateway/src/adapters/openclaw/client.ts`
- Test: `packages/gateway/test/openclaw-client.test.ts` (extend)

**Interfaces:**
- Produces (added to the client): `subscribeSession(sessionKey: string, handlers: { onDelta(snapshot: string): void; onDone(): void; onError(message: string): void }): () => void` - registers interest in one session; returns an unsubscribe. The client drops any delta/end event whose session id is not currently subscribed (the openclaw#32579 broadcast-bug guard and the cross-operator privacy guard), before any parsing beyond the envelope.
- Produces: an internal `accumulateDelta(prev, event)` applying `replace ? event.deltaText : prev + event.deltaText`, preferring the cumulative `message` snapshot when present.

- [ ] **Step 1: Write failing tests**: (a) two subscribed sessions each receive only their own deltas; an event for an UNsubscribed session id is dropped (never delivered, never logged with content); (b) `replace:true` replaces the accumulated snapshot, `replace` absent/false appends; (c) when `message` (cumulative) is present it wins over local accumulation (they agree in the happy path; assert the snapshot equals `message`); (d) the reply-end signal (ASSUMPTION: a terminal event field; see below) fires `onDone` exactly once and further deltas after it are ignored.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Add a `Map<sessionKey, handlers>` to the client; in `onEvent`, extract the session id from the delta payload via a single ASSUMPTION-commented accessor `sessionKeyOf(event)` and drop non-subscribed sessions immediately. Reply-end detection lives in one ASSUMPTION-commented predicate `isReplyEnd(event)`:

```ts
// ASSUMPTION (Task 8 to verify): a streamed reply ends when an event for the
// session carries a terminal marker (e.g. payload.done === true or a distinct
// "chat.final"/state value). Until verified, treat the first event bearing this
// marker as end-of-turn; the fake server sends the same shape the study records.
```

- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Full gate + commit** (`feat(gateway): OpenClaw chat delta accumulation and per-session filtering`).

---

### Task 6: OpenClaw adapter implementing BackendAdapter

**Files:**
- Create: `packages/gateway/src/adapters/openclaw/adapter.ts`
- Test: `packages/gateway/test/openclaw-adapter.test.ts`

**Interfaces:**
- Consumes: `client.ts` (Tasks 4-5), `markdown-blocks.ts` (Task 1), `blocksToText` from `../attach/blocks-to-text.ts`, `BackendAdapter`/`BackendSession`/`TurnHandlers` from `../types.ts`.
- Produces:
```ts
export const DEFAULT_TURN_TIMEOUT_SECONDS = 600;
export interface OpenClawAdapterDeps {
  agentId: string;
  client: OpenClawClient;   // injected so tests use a fake client
  turnTimeoutMs: number;
  draftFlushMs?: number;    // default 120; throttle for re-normalizing the buffer
}
export function createOpenClawAdapter(deps: OpenClawAdapterDeps): BackendAdapter;
```

Behavior: `presence()` maps client state (`online`->"online", else "absent"). `startSession(threadId)` lazily calls `client.request("sessions.create", ...)` once per thread, caches `threadId->sessionKey`, and subscribes the session. `session.send(blocks, handlers)`: reject immediately if `client.state() !== "online"` with `` `agent "${agentId}" is not attached" `` (match the attach taxonomy); else `client.request("chat.send", {sessionKey, text: blocksToText(blocks)})`, start a per-turn timeout (`turnTimeoutMs`, `.unref()`, message `` `turn timed out after ${turnTimeoutMs/1000}s` ``), and on each throttled delta flush call `handlers.onDraft({ blocks: normalizeMarkdownToBlocks(snapshot), toolCalls: [] })`; on reply-end normalize the final snapshot, reject if empty with `"the agent finished the turn without any reply content"`, else `onCommit({blocks})` then `onDone()`; on client disconnect mid-turn or an error event reject with `"the openclaw connection dropped mid-turn"`.

- [ ] **Step 1: Write failing tests** with a fake `OpenClawClient` (plain object implementing the interface, driving delta/end/drop callbacks): (a) a full turn yields throttled rich drafts then one commit+done, drafts carry `toolCalls: []`; (b) send while `absent` rejects with `/not attached/` and issues no `chat.send`; (c) client drop mid-turn rejects with `/dropped mid-turn/` and leaves no pending timer (`vi.getTimerCount()===0`); (d) an empty final reply rejects with `/without any reply content/`; (e) two threads get two distinct `sessions.create` calls and their deltas do not cross; (f) turn timeout fires with fake timers.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement `adapter.ts`** following the attach adapter's `settle`/`failTurn`/timeout structure (`packages/gateway/src/adapters/attach/adapter.ts` is the pattern reference) adapted to the client callbacks; throttle drafts with a trailing timer so the last snapshot always flushes before commit.
- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Full gate + commit** (`feat(gateway): OpenClaw backend adapter (BackendAdapter, rich drafts, fail-fast)`).

---

### Task 7: Config parsing, registry branch, server wiring (fail closed on missing token)

**Files:**
- Modify: `packages/gateway/src/adapters/registry.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `packages/gateway/src/adapters/openclaw/config.ts` (parse + validate options)
- Test: `packages/gateway/test/openclaw-config.test.ts`, extend `packages/gateway/test/server.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (open `options` bag), `createOpenClawAdapter`, `createOpenClawClient`, `generateDeviceIdentity`.
- Produces: `export function parseOpenClawOptions(agent: AgentConfig, env: NodeJS.ProcessEnv): { url: string; token: string; turnTimeoutMs: number; protocolVersion: number }` throwing typed startup errors (fail closed) for: missing/empty `options.url`; missing/empty `options.tokenEnv` (name of the env var); env var named but unset/empty; non-positive `options.turnTimeoutSeconds`. Error strings mirror the attach taxonomy, e.g. `` `agent "${agent.id}": the openclaw backend requires options.tokenEnv, the NAME of an environment variable holding the operator token` `` and `` `agent "${agent.id}": environment variable "${tokenEnv}" is not set; the operator token rides the environment, never the config file` ``.

Config shape (agent entry): `{ "id": "sage", "name": "Sage", "backend": "openclaw", "options": { "url": "wss://host:port", "tokenEnv": "OPENCLAW_TOKEN", "turnTimeoutSeconds": 600, "protocolVersion": 4 } }`.

- [ ] **Step 1: Write failing config tests**: valid options parse; each missing/invalid field throws the exact message; token value never appears in the thrown error (only the env var NAME does).
- [ ] **Step 2: Run, confirm fail.** Run: `pnpm test openclaw-config`.
- [ ] **Step 3: Implement `config.ts`.**
- [ ] **Step 4: Registry branch.** In `registry.ts`, add `else if (agent.backend === "openclaw")`: parse options, create one `OpenClawClient` (generate a per-agent `DeviceIdentity`), `client.start()`, build the adapter, and (like attach) register it. Add an `openclaw?` wiring param to `buildAdapters` mirroring the attach wiring so `server.ts` owns process.env and client lifecycle. Unknown-backend error message unchanged.
- [ ] **Step 5: Server wiring.** In `server.ts`: collect openclaw agents, resolve their tokens BEFORE the listener opens (fail closed, same placement as `collectAttachTokens`), construct clients/adapters via the registry, route each client's `onStateChange` to `hub.broadcast({type:"presence", agentId, state})` (state maps online->"online" else "absent") and include openclaw adapters in the `presenceOf` pull map. On shutdown, close openclaw clients alongside `attachIngress`.
- [ ] **Step 6: Extend `server.test.ts`**: a config with one openclaw agent whose token env is unset fails `startGateway` before binding (no open port); with the env set and a fake server URL, startup succeeds and REST presence reports the agent (online or absent, not "unknown"-by-missing-adapter). Keep conformance untouched.
- [ ] **Step 7: Run to green + full gate.** Run: `pnpm test openclaw-config server` then `pnpm check`.
- [ ] **Step 8: Commit** (`feat(gateway): wire OpenClaw backend into config, registry, and server (fail closed on token)`).

---

### Task 8: Docs, live canary, and bounded wire study (resolve the assumptions)

**Files:**
- Modify: `packages/gateway/README.md`
- Create: `packages/gateway/scripts/openclaw-canary.mjs`
- Create: `docs/specs/2026-07-08-openclaw-wire-study.md`

**Interfaces:** none (docs + ops). This task is the honest close on the coded ASSUMPTIONs and MUST run against a real OpenClaw gateway before any merge/ship claim (spec section 7/10).

- [ ] **Step 1: README "Backends" section.** Document the openclaw backend, the config shape, and the root-token caveat verbatim: an operator token is root on the target gateway; it rides `tokenEnv`; the gateway logs a one-line caveat at startup. Nominative "works with OpenClaw" copy only; no em-dashes. Note tool chips are not yet surfaced for openclaw threads.
- [ ] **Step 2: Startup caveat log.** Confirm (add if missing) that constructing an openclaw client logs one line at startup naming the agent and the root-token caveat, token value absent. Add a test asserting the caveat text and that the token is absent from it.
- [ ] **Step 3: Canary script.** `openclaw-canary.mjs`: if `OPENCLAW_CANARY_URL` and the token env are set, dial a real gateway, complete the handshake, `sessions.create`, `chat.send "ping"`, and assert a non-empty streamed reply; print PASS/FAIL and exit non-zero on failure. It is NOT part of `pnpm check` (non-gating); it is runnable manually or on a schedule.
- [ ] **Step 4: Wire-study doc + assumption resolution.** `docs/specs/2026-07-08-openclaw-wire-study.md` is a checklist to fill from a live session: (a) exact delta event name(s) and the field carrying the session id; (b) the reply-end signal; (c) the device-auth v3 payload byte construction; (d) whether tool events appear for `operator.read`. For each resolved item, update the single isolated site (`sessionKeyOf`/`isReplyEnd` in `client.ts`, `buildAuthPayloadV3` in `device-auth.ts`) and its fake-server frames + tests. File a follow-up issue for tool chips if (d) is positive, with the recorded evidence.
- [ ] **Step 5: Live validation.** Run the canary against a real gateway; record the outcome in the study doc. Do not claim the adapter shippable until the canary passes and the assumptions are marked verified.
- [ ] **Step 6: Full gate + commit** (`docs(gateway): OpenClaw backend docs, live canary, and wire-study resolution`).

---

## Self-Review

- **Spec coverage:** section 2 decisions -> tokenEnv (Task 7), persistent+backoff+fail-fast (Tasks 4/6), TS normalizer rich drafts (Tasks 1/6), text-only chips + study (Tasks 6/8); section 3 architecture files -> Tasks 1-7; section 4 config -> Task 7; section 5 session filtering/broadcast bug -> Task 5; section 6 turn lifecycle -> Task 6; section 7 version pinning + canary -> Tasks 2/4/8; section 8 security -> Tasks 3/4/7/8; section 9 error taxonomy -> Tasks 6/7; section 10 testing (fake server + shared vectors + live) -> Tasks 1/4/8; section 11 out-of-scope respected (no incremental normalizer, no chips, no process spawn). Covered.
- **Assumptions isolated:** every unverified wire detail sits behind one named function/constant with an `ASSUMPTION (Task 8 to verify)` comment, and Task 8 is a hard pre-merge gate. No code guesses silently.
- **Type consistency:** `OpenClawClient`, `DeviceIdentity`, `createOpenClawAdapter`, `parseOpenClawOptions`, `normalizeMarkdownToBlocks`, `PROTOCOL_VERSION`, `DEFAULT_TURN_TIMEOUT_SECONDS` used consistently across tasks; error strings mirror the attach adapter taxonomy verbatim.
- **Frozen surfaces:** contract v1 and conformance untouched; only additive gateway internals + new files.
