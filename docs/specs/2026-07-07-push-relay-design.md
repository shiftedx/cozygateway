# Push relay + gateway push origination: design

Date: 2026-07-07. Status: approved. Implements queue item 2 from the Phases 1-2 plan
(docs/plans/2026-07-06-contract-v1-and-gateway-core.md, "later phases"): the push relay
service and the gateway-side push origination that replaces `nullNotifier`.

## 1. Goal and non-goals

A phone client that is not connected to its gateway still learns that an agent replied.
The gateway already fires a `Notifier` on every committed agent message when no live
client is connected (`TurnRunner` in `packages/gateway/src/turns.ts`); today that
notifier is `nullNotifier`. This phase ships:

1. **`packages/relay`**: the push relay, a small separately-deployable service
   (npm name `cozygateway-relay`). It maps opaque push ids to delivery transports and
   forwards ciphertext it cannot read.
2. **Gateway push origination**: a `RelayNotifier` that encrypts a notification payload
   per registered device and posts it to that device's relay.
3. **`contract/push-v0.md`**: the relay wire contract and the exact ciphertext
   construction, with a test vector, so a client notification extension can be written
   against it without reading our code.

Non-goals (explicitly out of scope, see section 9): APNs/FCM delivery, paid-unlock
gating, per-device presence targeting, TLS termination for the relay.

## 2. Decisions (design authority: Kyle, 2026-07-07)

| # | Decision | Why |
|---|----------|-----|
| 1 | Delivery ships as a pluggable transport seam; this phase implements a `webhook` transport only. `apns` is a recognized platform that returns 501 until the phone app exists. | A real APNs push has no receiver yet and needs vendor credentials tied to the future app bundle. The webhook shape doubles as the UnifiedPush shape, so the Android path later is nearly free. |
| 2 | Relay access: open endpoints with abuse caps (per-push-id daily cap, default 500/day). A single auth middleware slot is reserved for the future unlock check. | The purchase/receipt story belongs to the app phase; caps match the reference shape for this kind of service. |
| 3 | Payload cipher: AES-256-GCM via `node:crypto`; key derived with HKDF-SHA256 from the registered `pushKey` string. | Zero new dependencies on the gateway; the platform crypto library on the client side has both primitives. HKDF keeps the frozen contract v1 valid: `pushKey` is any minLength-1 string there, and the conformance suite registers with `pushKey: "k"`. |
| 4 | Relay state: SQLite via `node:sqlite`, same pattern as the gateway. | Registrations must survive a redeploy of the hosted instance, or every device silently stops receiving pushes until its app next launches. |
| 5 | The relay is its own workspace package, not part of the gateway. | It deploys separately (one hosted canonical instance serves many self-hosted gateways) and must stay ignorant of gateway internals. |
| 6 | No gateway-side relay configuration. Each device registration already carries `relayUrl`; the notifier is per-registration. | The registration is the source of truth; a gateway-level relay URL would drift from it. With zero registrations the notifier is a no-op. |

## 3. Relay service (`packages/relay`)

Single Node process: hono + `@hono/node-server`, TypeBox schemas, `node:sqlite`
storage, pure ESM, `.ts` imports with `erasableSyntaxOnly`, MIT. Listens on
`127.0.0.1` by default with `--host` override (the hosted instance runs behind its own
TLS-terminating proxy, same reachability posture as the gateway).

### Endpoints

All bodies JSON. Errors use the same envelope as the gateway:
`{"error": {"code": string, "message": string}}` with codes from a small fixed set
(`invalid_request`, `not_found`, `over_cap`, `unsupported_platform`, `internal`).

- `POST /register` `{platform: "webhook" | "apns", token: string}` returns 201
  `{pushId: string}`.
  - `pushId` is 16 random bytes, base64url (unguessable; knowing a pushId is the
    de-facto capability to notify that device, matching decision 2).
  - `platform: "webhook"`: `token` must be an `http(s)` URL. The transport delivers a
    notification by `POST <token>` with body `{"ciphertext": string}`.
  - `platform: "apns"`: recognized but unimplemented, returns 501
    `unsupported_platform`. Listing it in the schema now freezes the request shape the
    phone app will use.
  - Registering again always mints a new pushId (no dedupe; the old id keeps working
    until deleted or pruned).
- `POST /notify` `{pushId: string, ciphertext: string}` returns 202 `{}` after handing
  the ciphertext to the transport.
  - Unknown pushId: 404 `not_found` (the gateway prunes its registration on this).
  - Daily cap exceeded: 429 `over_cap`. Cap counts accepted notifies (every 202,
    whether or not delivery succeeds) per pushId per UTC day, default 500,
    configurable (`--daily-cap`).
  - Transport delivery failure (webhook unreachable, non-2xx): the notify still counts
    against the cap and returns 202. Delivery is best-effort by design; the relay does
    not queue or retry in v0.
  - `ciphertext` max length 8192 characters; larger returns 400 (bounds abuse and is
    far above any real payload).
- `DELETE /register/:pushId` returns 204, idempotent (unknown id also 204).

### Transport seam

```ts
interface Transport {
  deliver(token: string, ciphertext: string): Promise<void>;
}
```

Transports are selected by the registration's `platform`. This phase ships
`webhookTransport` (global `fetch`, 10 s timeout, no retry). The APNs transport plugs
in here in the app phase without touching routes or storage.

### Storage

`node:sqlite`, one file (`--db` flag, default `relay.db` in the working directory):

```sql
CREATE TABLE IF NOT EXISTS registrations (
  push_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_counts (
  push_id TEXT NOT NULL,
  day TEXT NOT NULL,            -- UTC YYYY-MM-DD
  count INTEGER NOT NULL,
  PRIMARY KEY (push_id, day)
);
```

The relay never stores keys, plaintext, or anything derived from message content.

### Auth hook

One hono middleware slot applied to `/register` and `/notify`, shipped as a no-op
pass-through with a comment naming its purpose (future unlock check). Not configurable
in v0; it exists so the hosted instance can add gating without a route rewrite.

## 4. Gateway push origination

### Storage read API

`Storage.pushRegistrations(): Array<{deviceId, pushId, relayUrl, pushKey}>` (all rows;
one per device, upsert semantics already exist) and
`Storage.deletePushRegistration(deviceId: string): void`.

### RelayNotifier

Implements the existing `Notifier` interface; replaces `nullNotifier` in
`createServer` (`server.ts`). `nullNotifier` remains exported for tests.

On `notify({threadId, agentName, preview})`:

1. Read all push registrations. None: return.
2. Truncate `preview` to 200 characters (keeps the eventual platform push comfortably
   inside its size budget).
3. For each registration, encrypt the payload (section 5) under that registration's
   `pushKey` and `POST <relayUrl>/notify` with `{pushId, ciphertext}` (10 s timeout).
   `relayUrl` is treated as a base URL; a trailing slash is tolerated.
4. Outcome handling, per registration, strictly fire-and-forget:
   - 2xx: done.
   - 404: delete that device's registration (the relay no longer knows the id).
   - Anything else (429, 5xx, network error, timeout): log to stderr and keep the
     registration.

`notify()` returns `void` today and stays synchronous at the call site: the notifier
starts the async work internally and guarantees it never rejects (same "never rejects"
discipline as `TurnRunner.#runTurn`, enforced by test). A turn can never fail, hang, or
slow down because of push delivery.

The notifier takes `fetch` as an injectable dependency for tests.

## 5. Ciphertext construction (goes in `contract/push-v0.md`)

- Plaintext: UTF-8 JSON `{"threadId": string, "agentName": string, "preview": string}`.
- Key: `HKDF-SHA256(ikm = UTF-8 bytes of the registered pushKey string, salt = empty,
  info = "cozygateway-push-v0", length = 32)`.
- Encrypt: AES-256-GCM, 12-byte random nonce per notification, 16-byte tag.
- Wire form: `base64url(nonce || ciphertext || tag)`, no padding.

Test vector (verified by round-trip):

- pushKey: `test-push-key`
- derived key (hex): `ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62`
- nonce (hex): `000102030405060708090a0b`
- plaintext: `{"threadId":"thread-1","agentName":"Demo Agent","preview":"Hello from the gateway"}`
- ciphertext (base64url): `AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM`

`contract/push-v0.md` carries the same explicit status header as `contract/attach-v0.md`:
v0, NOT frozen, may change until the phone app ships. Contract v1 is untouched.

## 6. Package and repo layout

```
packages/relay/
  src/{schemas,storage,transports,http,server,cli}.ts + index.ts
  test/*.test.ts
contract/push-v0.md
docs/specs/2026-07-07-push-relay-design.md   (this file)
docs/plans/2026-07-07-push-relay.md          (implementation plan, next step)
```

Root `pnpm check` picks the new package up like the others (build before
typecheck/test in CI, root script order already handles this).

## 7. Testing

- Relay unit/route tests: register (both platforms, bad URL, bad body), notify (happy
  path to a local webhook receiver, unknown id 404, cap boundary at 500 then 429, UTC
  day rollover via injected clock, oversized ciphertext 400, webhook failure still
  202 + counted), delete idempotency, persistence across a storage reopen.
- Gateway notifier tests: encryption round-trip decrypted by an independent test-side
  implementation of section 5 (not the notifier's own code), multi-registration
  fan-out, 404 prunes exactly that registration, 429/5xx/network error keeps it, never
  rejects and never throws into the caller, preview truncation, trailing-slash
  relayUrl.
- Cross-package e2e (in the gateway package, mirroring `attach-e2e.test.ts`): real
  gateway + real relay + local webhook receiver; message submitted with no WS client
  connected; assert the webhook body decrypts to the expected payload. Also: with a WS
  client connected, no push.
- Contract: a test locks the section 5 test vector (derives, encrypts with the fixed
  nonce, compares bytes) so the doc and the code cannot drift.

Live validation (phone-less, full wire): local gateway with the Phase 3 attach agent +
relay as a separate process + a throwaway local webhook listener; agent replies while
no client is connected; the listener receives a POST whose ciphertext decrypts to the
expected preview. Second check: connect a WS client, repeat, assert no push.

## 8. Follow-up seams this phase deliberately leaves

- APNs transport (app phase): plugs into the `Transport` interface; `/register`
  already accepts `platform: "apns"`.
- Unlock gating (app phase): fills the auth middleware slot.
- Per-device targeting: `Notifier` fires on the global `hub.hasClients()`; notifying
  only devices without a live socket needs per-device connection tracking in the hub.
  Not needed while the hub treats clients uniformly.
- Relay delivery retries/queueing: v0 is fire-and-forget end to end.

## 9. Out of scope

APNs and FCM sending, UnifiedPush formal compliance, purchase/receipt validation,
relay TLS termination (deploy-time proxy concern), Android client, notification
read/dismiss sync, delivery receipts.
