---
title: OpenClaw tool chips (issue #13) design
date: 2026-07-09
status: approved
---

# OpenClaw tool chips: design

Issue [#13](https://github.com/shiftedx/cozygateway/issues/13). The OpenClaw backend adapter
(v0, PR #12) is text-only: it emits `toolCalls: []` on every draft. This design maps OpenClaw
tool activity on the operator wire to cozygateway tool chips so openclaw threads show
running/ok/error chips while a turn is in flight, exactly like attach threads do.

Decisions made with Kyle during scoping (2026-07-09):

1. **Chips carry the tool name only.** `ToolCall.detail` stays unset in this slice. The wire's
   human strings (`title`, `meta`, `error`) embed argument-derived content (file names, full
   filesystem paths) from a root-token wire and are never forwarded.
2. **Tool calls only.** `lifecycle`, `assistant`, and `compaction` streams stay ignored; no
   synthetic "thinking" chips.
3. **Capture first.** The wire shapes below were pinned by live capture BEFORE this spec was
   written, not inherited from protocol docs.

## Pinned wire facts (live capture, 2026-07-09)

Captured against a real local gateway (`openclaw@2026.6.11`, protocol v4) backed by a
tool-capable local model, driving genuine tool-using turns with OpenClaw's own
`GatewayClient` on an `operator.read`/`operator.write` connection.

**Fact 1: tool activity rides `event:"agent"` with `stream:"item"` and `data.kind:"tool"`.**
The issue's starting evidence hypothesized `stream:"tool"` and `session.tool` events (from the
protocol docs). Neither appeared in live traffic across two tool-using turns; every tool
call/result arrived as an `item`-stream pair. `session.tool` remains advertised in
`hello-ok.features.events` but was never observed and is NOT parsed by this design.

**Fact 2: a tool call is a start/end pair keyed by `toolCallId`, with `sessionKey` on the
payload.** Success capture (model reading a workspace file), verbatim except elision:

```json
{"type":"event","event":"agent","payload":{
  "runId":"cabc10f1-...","sessionKey":"agent:main:dashboard:b8400f2f-...","stream":"item",
  "data":{"itemId":"tool:790639779","phase":"start","kind":"tool",
          "title":"read from magic-number.txt","status":"running","name":"read",
          "meta":"from magic-number.txt","toolCallId":"790639779","startedAt":1783629483750},
  "seq":3,"ts":1783629483751,"isHeartbeat":false},"seq":4}

{"type":"event","event":"agent","payload":{
  "runId":"cabc10f1-...","sessionKey":"agent:main:dashboard:b8400f2f-...","stream":"item",
  "data":{"itemId":"tool:790639779","phase":"end","kind":"tool",
          "title":"read from magic-number.txt","status":"completed","name":"read",
          "meta":"from magic-number.txt","toolCallId":"790639779",
          "startedAt":1783629483750,"endedAt":1783629483774},
  "seq":5,"ts":1783629483774,"isHeartbeat":false},"seq":5}
```

**Fact 3: a failed tool call ends with `status:"failed"` and an `error` string.** Failure
capture (model reading a nonexistent file):

```json
{"type":"event","event":"agent","payload":{
  "runId":"94db939b-...","sessionKey":"agent:main:dashboard:915e18f1-...","stream":"item",
  "data":{"itemId":"tool:851613655","phase":"end","kind":"tool",
          "title":"read from totally-missing-xyz.txt","status":"failed","name":"read",
          "meta":"from totally-missing-xyz.txt","toolCallId":"851613655",
          "startedAt":1783629574561,"endedAt":1783629574578,
          "error":"ENOENT: no such file or directory, access '/private/tmp/.../workspace/totally-missing-xyz.txt'"},
  "seq":5,"ts":1783629574578,"isHeartbeat":false},"seq":5}
```

Note the `error` string carries full host filesystem paths: confirmation that chip content
must stay name-only.

## Mapping

Contract v1 is FROZEN and already sufficient: `DraftFrame.toolCalls` carries
`ToolCall {id, name, status: running|ok|error, detail?}` and the committed `Message` schema
has no toolCalls field. Chips are therefore draft-only and vanish at commit, matching attach
threads. No contract change, no conformance change, no UI/relay/iOS work.

| OpenClaw wire | cozygateway chip |
|---|---|
| `data.toolCallId` (fallback `data.itemId`; frame ignored if both missing) | `id` |
| `data.name` | `name` |
| `phase:"start"` | `status:"running"` |
| `phase:"end"` with `status:"failed"` OR an `error` field present | `status:"error"` |
| `phase:"end"` otherwise (including unknown future statuses) | `status:"ok"` |
| `title`, `meta`, `error` | never forwarded; `detail` unset |

## Design

Approach (chosen over an adapter-side fold): the client accumulates chip snapshots per
session subscription, mirroring how it already owns text accumulation (`accumulateDelta`),
so subscription-equals-turn semantics, the done-guard, and the privacy gate are reused
unchanged.

### protocol.ts

- New `AgentEventSchema`: `{type:"event", event:"agent", payload:{sessionKey: string,
  stream: string, data?: open record, ...open}}`. Added to `ServerFrame` as `kind:"agent"`
  and recognized by `parseServerFrame`. Non-matching agent frames keep falling through to
  "unrecognized frame shape" as today.
- New narrowing helper `toolItemOf(frame)`: returns
  `{toolCallId: string, name: string, phase: "start"|"end", failed: boolean} | undefined`.
  Returns a value only when `payload.stream === "item"` and `payload.data.kind === "tool"`;
  `failed` is `data.status === "failed" || data.error !== undefined`. This helper is the ONE
  named site that owns the newly pinned wire fact, with a comment citing the live capture
  (openclaw@2026.6.11, 2026-07-09). Everything else in the frame stays unread.

### client.ts

- `SessionHandlers` gains a required `onToolCalls(toolCalls: SessionToolCall[]): void`.
  `SessionToolCall` is a neutral exported type `{id: string, name: string,
  status: "running"|"ok"|"error"}` so the wire client keeps zero dependency on the
  cozygateway contract package.
- `SessionSubscriptionState` gains `toolCalls: Map<string, SessionToolCall>` (insertion
  order preserved, so chips render in first-seen order).
- `handleMessage` gains `case "agent"`: look up `payload.sessionKey` in
  `sessionSubscriptions` BEFORE reading anything else (the same openclaw#32579 broadcast-bug
  guard and cross-operator privacy guard the `chat` path enforces; the root operator token
  can see other operators' traffic). Unsubscribed agent frames drop SILENTLY, unlike chat's
  logged drop: agent frames arrive several per turn and the chat drop line already flags
  foreign traffic. For a live subscription: if `sub.done`, ignore; if `toolItemOf` yields
  nothing (lifecycle/assistant/compaction/non-tool items), ignore; otherwise fold
  (start writes `{id, name, status:"running"}`, end overwrites status to `"error"` or
  `"ok"`) and call `handlers.onToolCalls([...sub.toolCalls.values()])` with a fresh array.
- Tool names and ids are wire content: they never appear in any log line, matching the
  existing no-content logging stance.

### adapter.ts

- Per-turn chip state alongside `snapshot`: the `onToolCalls` handler stores the mapped
  contract `ToolCall[]` (identity mapping plus `detail` left unset) and calls
  `scheduleFlush()`, so chip transitions ride the existing 120ms trailing draft throttle.
- The flush dedupe extends from text-only (`lastFlushedSnapshot`) to text+chips, so a
  `running -> ok` transition with no new text still emits a draft.
- `onDone` and commit behavior unchanged: pending draft flushed before commit, commit
  carries blocks only, empty-reply turns still fail. Chips die with the turn.
- `openclaw-canary.mjs` gets a no-op `onToolCalls` handler plus an opt-in assertion mode
  (env-gated) that drives a tool-using prompt and asserts a chip reached a terminal status.

### Docs

- `docs/specs/2026-07-08-openclaw-wire-study.md` gets an addendum correcting section (e):
  observed tool events use `stream:"item"` + `data.kind:"tool"`; `stream:"tool"` and
  `session.tool` were never observed live.

## Edge cases

- **Tool frame for an unsubscribed session:** dropped before content is read, never logged
  with content (privacy invariant).
- **Tool frame after the turn's terminal chat event:** ignored via the existing `sub.done`
  guard; a settled adapter turn also ignores late `onToolCalls` via its `settled` flag.
- **Missing `toolCallId` and `itemId`:** frame ignored (no stable chip key).
- **Unknown `phase` value:** ignored (only `start`/`end` fold).
- **Turn that uses tools but streams no text:** unchanged v0 behavior, the turn fails with
  "finished the turn without any reply content"; chips were visible only in drafts.
- **Reconnect mid-turn:** unchanged; the existing subscription `onError` path fails the turn
  and chip state dies with the subscription.

## Testing

- **Fixtures:** the captured frames above, verbatim, as test vectors.
- **protocol tests:** `AgentEventSchema` parse; `toolItemOf` narrowing (wrong stream, wrong
  kind, missing ids, failed vs completed vs unknown status, error-field-only failure).
- **client tests (fake server):** start-then-end folds running -> ok; failed end folds to
  error; multiple concurrent tool calls keep insertion order and distinct keys; agent frames
  for unsubscribed sessions are dropped silently with no content logged; frames after done
  are ignored; each `onToolCalls` snapshot is a fresh array.
- **adapter tests (fake client):** drafts carry current chips; a chip-only transition (no
  text delta) produces a new draft; the pre-commit flush carries final chip states; commit
  carries no chips; late tool events after settle are ignored.
- **Gate:** full `pnpm check` green (gateway, conformance 21/21, contract, relay). No
  contract changes.
- **Live verification (mandatory before any ship claim):** against a real local OpenClaw
  gateway (the Task 8 recipe), drive the same read-file turn through OUR client/adapter and
  observe a chip go running -> ok in emitted drafts, plus the failure prompt producing a
  running -> error chip.

## Non-goals

- No `detail` content on chips (follow-up candidate once redaction rules are designed).
- No parsing of `session.tool` or `stream:"tool"` (never observed live).
- No lifecycle/compaction/assistant chips.
- No persistence of chips (contract: draft-only) and no contract bump.
