---
title: OpenClaw gateway wire study (Task 8 assumption resolution)
date: 2026-07-09
status: resolved
---

# OpenClaw gateway wire study

This document resolves the three device-auth / chat-stream assumptions the OpenClaw
adapter coded behind `// ASSUMPTION (Task 8 to verify)` comments. It was filled from a
live study against a real OpenClaw gateway (`openclaw@2026.6.11`, protocol v4) run
locally, cross-checked against the gateway's own shipped protocol source and builders.

## How it was verified

1. Installed `openclaw@2026.6.11` (MIT, github.com/openclaw/openclaw) and ran a real
   gateway locally (`openclaw gateway --port 18789`), backed by an OpenAI-compatible
   local model so a `chat.send` produces a genuine streamed reply with no cloud creds.
2. Connected as an OPERATOR using OpenClaw's own `GatewayClient` (fresh device identity
   + gateway token, scopes `operator.read`/`operator.write`), drove
   `sessions.create -> chat.send`, and logged every frame verbatim. A fresh self-minted
   operator device is accepted with the gateway token alone: **no pairing/approval step
   is required** for an operator connection.
3. Read the authoritative shapes from the shipped package:
   `gateway-protocol` schemas (`ChatEventSchema`, `ChatSendParamsSchema`,
   `SessionsCreateParams`) and the device-auth builders
   (`buildDeviceAuthPayloadV3`, `deriveDeviceIdFromPublicKey`, `verifyDeviceSignature`).

## Resolved facts

### (a) Delta event name + session-identifying field (was ASSUMED, now PINNED)

- The streamed assistant output rides an event named **`chat`** (advertised in
  `hello-ok.features.events`, confirmed live). It is NOT a `chat.delta`/`chat.final`
  name; the single `chat` event is discriminated by **`payload.state`**.
- The session-identifying field is **`sessionKey`** (present on every `chat`/`agent`
  event). This matches what the adapter already read, so `sessionKeyOf` is unchanged.
- Delta payload (live capture, model replying "PONG"):
  ```json
  {"type":"event","event":"chat","payload":{
    "runId":"...","sessionKey":"agent:main:dashboard:...","agentId":"main",
    "seq":2,"state":"delta","deltaText":"P",
    "message":{"role":"assistant","content":[{"type":"text","text":"P"}],"timestamp":...}}}
  ```
- `message` is an **object** (the cumulative assistant message struct), NOT a cumulative
  text string. The running assistant text is the concatenation of `deltaText`
  (`replace:true` replaces instead of appends). The prior assumption that `message` was
  a required cumulative string was WRONG; accumulation now uses `deltaText` only.

### (b) Reply-end signal (was ASSUMED as `payload.done === true`, now PINNED)

- A reply ends with a `chat` event whose **`payload.state === "final"`** (also `"error"`
  and `"aborted"` are terminal states). There is no `payload.done` flag. Live capture:
  ```json
  {"type":"event","event":"chat","payload":{
    "runId":"...","sessionKey":"...","seq":5,"state":"final","stopReason":"stop",
    "message":{...}}}
  ```
- `isReplyEnd` now treats `state` in {`final`, `error`, `aborted`} as end-of-turn.

### (c) Device-auth v3 signature byte construction (was ASSUMED, now PINNED)

Canonical payload (OpenClaw `buildDeviceAuthPayloadV3`), pipe-delimited, 11 fields:

```
v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes,joined>|<signedAtMs>|<token>|<nonce>|<platform>|<deviceFamily>
```

- separator is **`|`** (was `\n`); `scopes` joined by `,`; `token` empty-string when absent.
- `platform`/`deviceFamily` are trim + lowercased (`normalizeDeviceMetadataForAuth`).
- **`deviceId = sha256(rawEd25519PublicKeyBytes).hex`** (was a random UUID). The wire
  `device.publicKey` is **base64url of the raw 32-byte Ed25519 key** (not SPKI DER).
- `device.signature` is **base64url** of the Ed25519 signature over the UTF-8 payload.
- `device.signedAt` (= the `signedAtMs` signed into the payload) must be within
  **120_000 ms** of the server clock (`DEVICE_SIGNATURE_SKEW_MS`).
- The signature covers `client.id` (`clientId`), `client.mode` (`clientMode`),
  `client.platform`, `client.deviceFamily`, and the server-normalized `scopes`. The
  operator client therefore connects as a valid client (`id: "gateway-client"`,
  `mode: "backend"`) rather than `mode: "operator"` (not a valid client mode).

Deterministic cross-implementation parity vector (generated from OpenClaw's own
`buildDeviceAuthPayloadV3` + `deriveDeviceIdFromPublicKey`, seed = 32 bytes of 0x07;
`verifyDeviceSignature` returns true). Frozen as a regression test:

```
deviceId : fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889
pubB64url: 6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw
payload  : v3|fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889|gateway-client|backend|operator|operator.read,operator.write|1783000000000|example-operator-token|fixed-nonce-abc123|server|server
```

### (d) sessions.create response + chat.send params

- `sessions.create` returns the session key under **`key`** (not `sessionKey`); the same
  value is what `chat.send.params.sessionKey` and the `chat`/`agent` events carry. Live:
  ```json
  {"ok":true,"key":"agent:main:dashboard:...","sessionId":"...","runStarted":false}
  ```
- `chat.send` requires `sessionKey`, `message`, and `idempotencyKey`; it returns
  `{runId, status:"started"}` immediately and the reply streams as `chat` events.

### (e) Tool events on the operator wire

- `hello-ok.features.events` on an `operator.read` connection advertises `agent`,
  `chat`, `session.tool`, `session.message`, etc. (captured live). Tool-call/tool-result
  frames require at least `operator.read`, so tool events DO reach this operator wire.
  v0 of this adapter is deliberately text-only (`toolCalls: []`); surfacing tool chips
  for OpenClaw threads is a ready-to-file follow-up (see below), not shipped here.

## Follow-up (ready to file once the branch is pushed)

**OpenClaw tool chips.** The operator wire surfaces tool activity (`session.tool` events,
`agent` `stream:"tool"`/`tool-result` frames) on an `operator.read` connection, confirmed
by the live `hello-ok.features.events` capture. The adapter currently emits `toolCalls: []`
for OpenClaw threads. Follow-up: map the OpenClaw tool frames to cozygateway tool chips, with
the recorded event names as the starting evidence.

## Evidence

Raw capture (hello-ok, sessions.create, streamed `chat` deltas + final) and the parity
vector generator output were recorded during the live study on 2026-07-09.

## Addendum (2026-07-09): tool events as actually observed

The tool-chips live study (docs/specs/2026-07-09-openclaw-tool-chips-design.md) corrected
section (e)'s hypothesis. Across real tool-using turns against the same gateway version:

- Tool activity rides `event:"agent"` with `stream:"item"` and `data.kind:"tool"`, as a
  start/end pair keyed by `data.toolCallId` (`phase:"start"` with `status:"running"`, then
  `phase:"end"` with `status:"completed"`, or `status:"failed"` plus an `error` string).
- `stream:"tool"` was never observed. `session.tool` remains advertised in
  `hello-ok.features.events` but never fired; neither is parsed by the adapter.
- The item's `title`, `meta`, and `error` strings carry argument-derived content (file names,
  full host paths) and are never forwarded to chips.
