# OpenClaw backend adapter: design

Status: approved 2026-07-08 (Kyle). Scope: queue item 3, the second real backend adapter. Public copy rule: "works with OpenClaw" nominative framing only; never "Claw" in our own naming; coding-agent harnesses stay unnamed in public copy.

## 1. What this is

A client-mode backend adapter: the gateway dials OUT to a running OpenClaw gateway and speaks its Gateway WS protocol v4 as an operator client. It implements the same `BackendAdapter` interface as the attach adapter (`packages/gateway/src/adapters/types.ts`) and registers as a new branch in `adapters/registry.ts`. Unlike attach (the harness dials in to us), this adapter owns the outbound connection lifecycle.

## 2. Decisions (with rationale)

1. **Token via `tokenEnv`, same as attach.** Config names an environment variable; the secret lives only in the environment. The operator token is root on the target OpenClaw gateway, so it stays out of on-disk JSON config. No inline-token path.
2. **Persistent connection with exponential-backoff reconnect; fail-fast turns.** `presence()` reports `online` only while the challenge-signature handshake has completed, `absent` otherwise. A disconnect mid-turn fails that turn immediately (attach precedent); there is no turn resume or replay across reconnects.
3. **Rich drafts via a TypeScript normalizer port.** deltaText accumulates into a buffer; each throttled flush runs a TS port of the reference plugin's markdown-to-typed-blocks normalization and emits a full-replace block list. v0 re-normalizes the full buffer per flush; the incremental prefix-stable optimization (plugin issue #6) is a filed follow-up, not v0 scope.
4. **v0 ships text-only (no tool chips).** Drafts carry an empty `toolCalls` array. The wire study did not establish whether protocol v4 exposes tool events to an operator client; the implementation plan includes a bounded study task against a live OpenClaw gateway, and chips become a follow-up issue only with evidence in hand.

## 3. Architecture

New directory `packages/gateway/src/adapters/openclaw/`:

- `client.ts`: the WS operator client. Dial, challenge-signature handshake (token from `tokenEnv`), pinned `PROTOCOL_VERSION = 4`, reconnect loop with exponential backoff and jitter, heartbeat handling as the wire requires. Exposes a small event surface (connected, disconnected, event frames) consumed by the adapter; no contract types leak into it.
- `adapter.ts`: implements `BackendAdapter`. Maps cozygateway threads to OpenClaw sessions, dispatches turns (`chat.send`), accumulates deltaText per in-flight turn, drives `onDraft`/`onCommit`/`onDone`, enforces the per-turn timeout, and fails fast on disconnect or send error.
- Registry: `adapters/registry.ts` gains an `openclaw` branch beside `attach` and `mock`.

Shared, backend-agnostic module `packages/gateway/src/markdown-blocks.ts`: the TS markdown-to-RichBlock normalizer. It lives outside the openclaw directory because any text-streaming backend needs the same mapping. Rules mirror the reference plugin's normalizer (paragraph, code fence, heading, list, table, math; blank-line block boundaries; unclosed constructs stay open until more text arrives).

## 4. Configuration

Agent entries in the gateway config:

```json
{ "name": "sage", "backend": "openclaw", "url": "wss://host:port", "tokenEnv": "OPENCLAW_TOKEN" }
```

One configured agent equals one persistent connection to one OpenClaw gateway. Multiple OpenClaw agents are simply multiple entries, each with its own connection, token env var, and presence. Missing env var at startup is a configuration error (fail fast at load, matching attach's tokenEnv behavior).

## 5. Sessions and the broadcast bug

One OpenClaw session per cozygateway thread, created lazily on the thread's first turn (attach's per-thread-memory precedent). The adapter records the session ids it has opened.

Client-side filtering is strict and is both a correctness workaround and a privacy guard: the known broadcast defect (openclaw#32579) means an operator client can receive events for sessions it did not open, and the root-scope token means those events may belong to other operators. Any inbound event whose session id is not in the adapter's own session map is dropped before any parsing beyond the envelope, never rendered, never logged at a level that includes content.

## 6. Turn lifecycle

1. `send(blocks)`: serialize outgoing blocks to text (existing `blocksToText`), issue `chat.send` for the thread's session.
2. deltaText events for that session append to the turn buffer. A throttled flush (same cadence knob shape as attach) runs the normalizer over the full buffer and calls `onDraft` with the full-replace block list and empty `toolCalls`.
3. The wire's terminal event for the turn triggers final normalization, `onCommit`, then `onDone`.
4. Failure paths, all rejecting the `send()` promise with backend-unavailable-style errors: per-turn timeout (default matches attach's `turnTimeoutSeconds`), disconnect mid-turn, send error, or an error event from the wire. No pending state survives a failed turn.

## 7. Version pinning and drift detection

`PROTOCOL_VERSION = 4` is pinned. If the server's handshake reports an incompatible protocol version, the adapter enters a failed state with a typed, logged reason and presence stays `absent`; it does not attempt best-effort parsing of an unknown wire. Drift detection is two-layered: fixture tests against recorded v4 frames run in the normal gate, and a non-gating canary script dials a real OpenClaw gateway when `OPENCLAW_CANARY_URL` (and the token env) is set, runnable manually or on a schedule. The canary does not block CI.

## 8. Security posture

- The operator token is root on the target gateway. The adapter logs a one-line caveat at startup; the README and this spec carry the same caveat. In-app copy belongs to the app phase.
- The token is never logged, never echoed into error messages, and never serialized into any frame our own clients receive.
- Session filtering (section 5) prevents cross-session content from other operators reaching our threads.

## 9. Error handling

Errors map to the adapter layer's existing taxonomy: configuration errors fail at startup; connection and handshake failures surface as presence `absent` plus logged reasons; turn-level failures reject `send()` with the same backend-unavailable message shape the attach adapter uses. Log lines carry ids and reasons, not payload content or secrets.

## 10. Testing

- Unit suite against an in-process fake OpenClaw WS server speaking recorded v4 frames: handshake success and failure, version-mismatch refusal, delta accumulation to block equivalence, broadcast-bug simulation (foreign-session events dropped), reconnect and presence transitions, mid-turn disconnect fail-fast, turn timeout.
- Normalizer parity: the reference plugin's fixture corpus (issue #6's transcripts and adversarial chunkings) is exported as JSON test vectors consumed by both the Python suite and the new TS tests, keeping the two normalizers aligned without a byte-level cross-language contract.
- Contract v1 is untouched; conformance stays 21/21.
- Live validation against a real OpenClaw gateway is required before any merge claim, same posture as the attach and push phases. The bounded tool-event study task (decision 4) rides the same live rig.

## 11. Out of scope for v0

- Tool chips for OpenClaw threads (pending the study task).
- Turn resume or replay across reconnects.
- Incremental normalization in the TS normalizer (follow-up after v0).
- Spawning or managing an OpenClaw process; the adapter only connects to a running gateway.

## 12. Next steps

Implementation plan via the standard loop (writing-plans, then subagent-driven execution): wire client, normalizer port with shared fixtures, adapter, registry and config, fake-server test suite, docs, live validation, tool-event study.
