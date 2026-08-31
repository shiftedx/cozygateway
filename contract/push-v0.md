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

A relay may stay private. A gateway advertising `com.cozylabs.push-proxy: 1` exposes the
authenticated registration lifecycle at `POST /push/register` and
`DELETE /push/register/:pushId`; see `contract/ext-push-proxy-v1.md`. The gateway never proxies
`POST /notify`.

## Hosted relay

The default public relay is `https://push.cozylabs.ai`. It is accountless on purpose.
The relay sees an opaque `pushId`, ciphertext, optional category and collapse id, and
the request source IP transiently for rate limiting. It never receives a push key,
message content, account identity, or device identity. Monitoring exposes only aggregate
counts, never identifiers.

The public instance applies token-bucket limits of 10 register attempts per minute per
source IP and 60 notify attempts per minute per source IP. A limit response is 429
`over_cap` with `Retry-After`. Its trusted reverse proxy supplies the source address;
the relay honors the rightmost non-empty `X-Forwarded-For` value only when started with
`--trust-forwarded`. Idle in-memory buckets expire lazily.

The source limits layer with the existing public defaults: 10000 total registrations,
500 notifications per push id per UTC day, a 30-day registration TTL, a maximum 8192
characters of ciphertext, seven days of notify-count retention, and restricted webhook
egress on a non-loopback bind. The auth middleware remains a future unlock seam, but
accounts are not part of the v0 privacy or abuse-control contract.

## Relay endpoints

All bodies are JSON. Errors use `{"error": {"code": string, "message": string}}` with
codes `invalid_request`, `not_found`, `over_cap`, `unsupported_platform`, `internal`.

### POST /register

Request: `{"platform": "webhook" | "apns", "token": string, "environment": "development" | "production"}`

`environment` is required for APNs and selects Apple's sandbox (`development`) or production
service for that registration. Webhook registrations omit it.

- `webhook`: `token` is an `http(s)` URL. Delivery is `POST <token>` with body
  `{"ciphertext": string}`. The URL is registrant-supplied and untrusted. In restricted-
  egress mode (default on for a non-loopback relay bind; see the relay README), a
  literal-IP `token` host in a blocked range (loopback, link-local, private, or
  unspecified) is rejected here with `invalid_request`; a DNS-name host is instead
  vetted at delivery time, once resolved.
- `apns`: token-based APNs (ES256 provider JWT) when the relay is configured with an APNs key
  (env: APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC); `token` is the
  hex device token. When APNs is not configured, an `apns` registration returns 501
  `unsupported_platform`. Ordinary and actionable push payloads are alerts with `mutable-content: 1`;
  the `mobile.status.wake` payload is silent/background. Both carry the opaque ciphertext under the
  top-level custom key `c`; the relay never decrypts it.

Response: 201 `{"pushId": string}`. The pushId is 16 random bytes, base64url. It is
unguessable and knowing it is the de-facto capability to notify that registration.
Registering again mints a new pushId; old ids keep working until deleted.

- Per-source limit (default 10 attempts per minute): 429 `over_cap` with `Retry-After`.
- Total-registration cap (default 10000, configurable): 429 `over_cap` once the relay's
  total registration count reaches the configured bound. Bounds an unauthenticated
  registration flood ahead of the reserved auth-hook slot.

### POST /notify

Request: `{"pushId": string, "ciphertext": string, "category"?: string, "collapseId"?: string}`
(`ciphertext` max 8192 chars). The body is CLOSED (`additionalProperties: false`): an unknown
field is 400 `invalid_request` and nothing is delivered, so no cleartext description of a tool
call can exist at the relay boundary even by accident.

`category` and `collapseId` travel together or not at all (400 `invalid_request` otherwise).
Omitting both is the ordinary uncollapsed message push, byte-identical to what shipped before.
Registered categories:

| category | APNs push type | `aps.category` | fallback alert | collapse id |
| --- | --- | --- | --- | --- |
| `message` | `alert` | `message` | CozyChat / "New message" | digest of bot name + canonical chat session, required |
| `approval.pending` | `alert` | `approval.pending` | CozyChat / "Approval requested" | `toolCallId`, required |
| `approval.resolved` | `alert` | `approval.resolved` | CozyChat / "Approval resolved" | `toolCallId`, required |
| `mobile.status.wake` | `background` | omitted | none | `mobile.status`, required |

On APNs an alert category becomes `aps.category` and the collapse id becomes the
`apns-collapse-id` header; on a webhook both fields are added to the delivered JSON body next to
`ciphertext`. Bot chat replies use category `message`; the stable collapse id coalesces a burst from one bot's
canonical chat without exposing its raw name or Hermes session id. A category outside the
allowlist is 400. `collapseId` is bounded to an opaque-id charset
(`[A-Za-z0-9_.:-]`, 1 to 64 characters), the only caller-controlled cleartext string besides the
ciphertext: a raw command, path, or JSON blob cannot pass it, and an over-long id is refused
rather than truncated, since two ids sharing a 64-byte prefix would collapse into one
notification and a wrongly-collapsed approval is a wrongly-answered approval.

`approval.resolved` is an ALERT, not a silent background push: a `content-available` push is
best-effort, and a dropped one leaves a stale "approve this?" banner for an approval that is
already decided. An alert on the same collapse id replaces it in place, so the worst case is an
unnoticed but correct "resolved" banner rather than a lying "pending" one. The alert text the
relay sends carries nothing: it cannot read the ciphertext, so it emits a fixed, content-free
alert per category and the device's notification service extension rewrites it after decrypting.

`mobile.status.wake` is the silent exception: APNs receives
`{"aps":{"content-available":1},"c":"<ciphertext>"}` with `apns-push-type: background`,
`apns-priority: 5`, and `apns-collapse-id: mobile.status`. Its `aps` dictionary contains no
alert, badge, sound, category, or `mutable-content`. Delivery is explicitly best-effort: iOS may
throttle or drop the wake, and the relay does not queue or retry it. Request, lease, chat, and
device details remain inside the ciphertext and never become relay-visible.

Response: 202 `{}` once the notify is accepted and handed to the transport. Delivery is
best-effort; the relay does not queue or retry in v0, and a delivery failure still
returns 202 and still counts against the cap. A delivery refused by restricted-egress
mode (the resolved address is in a blocked range) is handled the same way as any other
delivery failure. After APNs asynchronously rejects a delivery with HTTP 410, the relay
deletes that terminally invalid registration; the accepted request remains 202, and a
subsequent notify for the same `pushId` returns 404. Other APNs HTTP statuses and network
failures retain the registration.

- Unknown pushId: 404 `not_found`. A gateway receiving this should delete its stored
  registration for that device.
- Per-source limit (default 60 attempts per minute): 429 `over_cap` with `Retry-After`.
- Per-pushId daily cap (default 500, UTC calendar day): 429 `over_cap`.
- The relay retains per-day notify counts for 7 UTC days and prunes older rows lazily
  (inline on notify, not on a timer); this is an internal storage-growth bound and has no
  observable effect on the cap, which only ever consults the current day.

### DELETE /register/:pushId

Response: 204, idempotent.

### GET /health

Response: 200 `{"name": "cozygateway-relay", "version": string, "registrations": number,
"todaysNotifies": number}`. Counts are aggregate operator signals for the current UTC day
and never include identifiers.

## Notification ciphertext

- Plaintext: UTF-8 JSON, one of the payloads below, discriminated by `kind`.
- Key: HKDF-SHA256 with ikm = the UTF-8 bytes of the registered `pushKey` string exactly
  as received, salt = empty (zero-length), info = the ASCII string
  `cozygateway-push-v0`, output length = 32 bytes.
- Encryption: AES-256-GCM, 12-byte random nonce per notification, 16-byte tag.
- Wire form: `base64url(nonce || ciphertext || tag)`, no padding.

The same envelope carries every payload; only the plaintext differs.

**`kind: "message"`** (an agent reply committed while the device had no live socket):

```json
{ "kind": "message", "threadId": "string", "agentName": "string", "preview": "string" }
```

The gateway truncates `preview` to at most 200 characters.

`kind` is ADDITIVE and was introduced with the approval payloads below (cozygateway issue #19).
A receiver MUST treat an ABSENT `kind` as `"message"`: every gateway that shipped before this
field emits exactly that payload without it. A gateway at this revision or later always sends
`"kind": "message"` explicitly, so the discriminator is present in practice and "no kind" only
ever means "older gateway".

**`kind: "mobile_node_wake"`** (a silent request for the selected idle phone to reconnect;
category `mobile.status.wake`, collapse id `mobile.status`):

```json
{ "kind": "mobile_node_wake" }
```

The decrypted plaintext is exactly the object above. It contains no request, lease, agent, chat,
or device identifiers.

**`kind: "approval_pending"`** (a tool call is waiting on a decision; category
`approval.pending`, collapse id = `toolCallId`):

```json
{ "kind": "approval_pending", "threadId": "string", "agentId": "string", "turnId": "string",
  "toolCallId": "string", "name": "string", "argSummary": { "command": "string" } }
```

**`kind: "approval_resolved"`** (that approval reached a terminal state; category
`approval.resolved`, same collapse id, so it replaces the pending banner in place):

```json
{ "kind": "approval_resolved", "threadId": "string", "agentId": "string", "turnId": "string",
  "toolCallId": "string", "outcome": "approved" | "denied" | "expired" }
```

The fields mirror the `approval_pending` / `approval_resolved` session frames of contract v1.md
section 5a one for one, plus `agentId` (the frames do not carry it because a client already knows
the thread's agent; a notification arrives with no such context). `argSummary` is argument key
NAMES mapped to JSON type TAGS only, never a raw argument value, and redacting it is the
GATEWAY's obligation, before it encrypts: the relay cannot inspect a ciphertext it has no key
for. The proposal's `collabId` maps to `threadId` here for the reason given in section 5a of
contract v1.md: a cozygateway instance is one user's self-hosted gateway, so it has no collab
dimension, and the thread is the addressing unit a resolve is issued against.

### Test vector

The vector pins the ENVELOPE (key derivation, nonce handling, framing), so its plaintext is
frozen as-is: the pre-`kind` message payload, which stays a legal payload under the
absent-kind rule above.

- pushKey: `test-push-key`
- derived key (hex): `ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62`
- nonce (hex): `000102030405060708090a0b`
- plaintext: `{"threadId":"thread-1","agentName":"Demo Agent","preview":"Hello from the gateway"}`
- ciphertext (base64url): `AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM`

## Gateway behavior (informative)

The gateway sends one notify per registered device when an agent reply commits while no
client is connected. Outcomes are fire-and-forget: 404 prunes that device's
registration; anything else is logged and the registration kept.
