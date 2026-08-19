# cozygateway-relay

The push relay for cozygateway. It maps opaque push ids to delivery transports and
forwards encrypted notification payloads it cannot read: no keys, no message content,
no account data. See `contract/push-v0.md` for the wire contract and the exact
ciphertext construction.

## Run

    npx cozygateway-relay
    # or, from a checkout:
    node dist/cli.js --port 8788 --host 127.0.0.1 --db relay.db --daily-cap 500 \
      --max-registrations 10000

The relay binds `127.0.0.1` by default. A hosted instance runs behind its own
TLS-terminating reverse proxy; that proxy is out of scope here.

## Storage growth caps

Two independent bounds keep the sqlite file from growing without limit:

- **Registration cap** (`--max-registrations`, default 10000): a total-row cap on
  `registrations`. The reserved auth-hook middleware slot (see below) is the intended
  long-term gate on who can register at all; this cap protects the window before that
  lands, so an unauthenticated flood cannot grow the DB past a fixed size. Exceeding it
  refuses the new registration with `429 over_cap`. Refreshing an existing `pushId`
  (re-registering the same id, e.g. a future token-refresh flow) is never refused by the
  cap, since it does not add a row. There is deliberately no per-source-IP registration
  rate limit in this cap; the auth-hook slot is where that kind of finer-grained gating
  belongs once it lands.
- **`notify_counts` retention**: rows are kept for `NOTIFY_COUNT_RETENTION_DAYS` (7 UTC
  days) and then swept. The sweep is lazy: it runs inline on every `POST /notify` call
  rather than on a timer, which keeps the relay dependency-free and trivial to shut down.
  Since the daily cap only ever consults the current UTC day, 7 days is a deliberately
  generous window purely for bounding disk growth.

Both defaults are chosen to keep current self-host behavior unobtrusive: a single-user
loopback relay will never come close to either bound in normal use.

## Egress restriction

Registered webhook URLs are operator-untrusted input: a registrant can point delivery
at loopback, link-local (including the `169.254.169.254` cloud metadata address), or
RFC1918/private targets, using a hosted relay as a blind SSRF proxy against internal
infrastructure.

Restricted-egress mode closes this off. When enabled:

- `POST /register` rejects a `webhook` URL whose host is a literal IP in a blocked range
  (loopback, link-local, private, or unspecified; IPv4 and IPv6, including IPv4-mapped
  IPv6 forms) with `invalid_request`.
- Delivery resolves a hostname exactly once and refuses to connect if the resolved
  address is in a blocked range. The relay connects to the address it just vetted (it
  does not re-resolve), so a hostname cannot bypass the check by rebinding its DNS
  answer between the check and the connection.
- A refused delivery is handled like any other failed delivery: best-effort, logged, and
  `/notify` still returns 202 per the delivery contract.

**Default:** on for a non-loopback `--host` bind (a hosted relay), off for a loopback
bind (`127.0.0.1`, `::1`, or `localhost`; the self-host dev default, where the existing
unrestricted behavior is unchanged). Override either way:

    node dist/cli.js --host 0.0.0.0 --no-restrict-egress   # hosted, restriction off
    node dist/cli.js --host 127.0.0.1 --restrict-egress    # self-host, restriction on

`startRelay`/`RelayConfig` (the library entry point) takes the same `restrictEgress`
boolean directly; only the CLI computes a host-based default.

## Transports

`webhook` ships today: delivery is a `POST` of `{"ciphertext": ...}` to the registered
URL. Unrestricted mode uses `fetch`, unchanged. Restricted mode uses `node:http`/
`node:https` `request` with a vetting `lookup` so the resolved address can be checked
before the relay connects to it.

`apns` ships when the relay is configured with an APNs key (`APNS_KEY_P8_PATH`,
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_ENVIRONMENT`, all five together or
none). Delivery is an alert with `mutable-content: 1` carrying the opaque ciphertext
under the top-level custom key `c`. Registering `platform: "apns"` on a relay with no
APNs key returns 501 `unsupported_platform`.

## Push categories

A **push category** is the one piece of routing metadata the relay is allowed to see in
the clear. `POST /notify` takes an optional pair:

    { "pushId": "...", "ciphertext": "...", "category": "approval.pending", "collapseId": "<toolCallId>" }

`category` and `collapseId` are sent together or not at all (400 `invalid_request`
otherwise); omitting both is the ordinary message push, byte-identical to what shipped
before. Registered categories (cozygateway issue #19, mobile approve/deny):

| category | APNs push type | `aps.category` | fallback alert | collapse id |
| --- | --- | --- | --- | --- |
| `approval.pending` | `alert` | `approval.pending` | CozyChat / "Approval requested" | `toolCallId`, required |
| `approval.resolved` | `alert` | `approval.resolved` | CozyChat / "Approval resolved" | `toolCallId`, required |

On APNs the category becomes `aps.category` and the collapse id becomes the
`apns-collapse-id` header. On a webhook the same two fields are added to the delivered
JSON body next to `ciphertext`.

### App-side contract (what the phone implements)

- **Register the actionable category** `approval.pending` with two actions, `approve`
  and `deny` (titles "Approve" and "Deny"; `deny` is the destructive one). Category and
  action registration is the app's job; the relay only names the category.
- **Coalescing**: every push about one tool call carries `apns-collapse-id =
  toolCallId`. The `approval.resolved` push therefore REPLACES the pending banner for
  that tool call in place. The app should also drop the delivered notification for that
  `toolCallId` when it sees the resolve while running.
- **`approval.resolved` is an alert, not a silent background push.** A background
  (`content-available`) push is best-effort: iOS may throttle or drop it, and a dropped
  one leaves a stale "approve this?" banner on the lock screen for an approval that is
  already decided. An alert on the same collapse id is guaranteed to replace it, so the
  worst case is an unnoticed but correct "resolved" banner rather than a lying "pending"
  one.
- **The alert text the relay sends carries nothing.** The relay cannot read the
  ciphertext, so it emits a fixed, content-free alert per category; the Notification
  Service Extension decrypts the payload and rewrites the alert on device.

### Notification payload (inside the ciphertext)

Encrypted exactly like the message payload (same per-device `pushKey`, same HKDF /
AES-256-GCM construction, see `contract/push-v0.md`), because it is the same envelope:

    { "kind": "approval_pending",  "threadId": "...", "agentId": "...", "turnId": "...",
      "toolCallId": "...", "name": "...", "argSummary": { "command": "string" } }

    { "kind": "approval_resolved", "threadId": "...", "agentId": "...", "turnId": "...",
      "toolCallId": "...", "outcome": "approved" | "denied" | "expired" }

`argSummary` is **key names and type tags only** (`{ "command": "string" }`), never a raw
argument value. The proposal's `collabId` maps to cozygateway's `threadId` (contract v1
`Thread.id`): a cozygateway instance is one user's self-hosted gateway, so it has no
collab dimension, and the thread is the addressing unit a client resolves an approval
against.

### Redaction enforcement at the relay boundary

The relay cannot inspect `argSummary`: it is inside a ciphertext the relay has no key
for, by design. What the relay guarantees instead is that **no cleartext field describing
a tool call exists at its boundary at all**:

- `POST /notify` is a closed body (`additionalProperties: false`). A caller that sends
  `argSummary`, `name`, `toolCallId`, or a `preview` in the clear gets 400
  `invalid_request` and **nothing is delivered**. Reject rather than strip: a silently
  dropped field lets a broken producer ship a push that looks fine, and leaves the leak
  live the day a later relay version starts reading that field.
- `collapseId` is the only caller-controlled cleartext string besides the ciphertext, so
  it is bounded to an opaque-id charset (`[A-Za-z0-9_.:-]`, 1 to 64 characters). A raw
  shell command, path, quoted string, or JSON blob cannot pass it. 64 is the APNs
  `apns-collapse-id` limit; an over-long id is refused rather than truncated, since two
  ids sharing a 64-byte prefix would silently collapse into one notification, and a
  wrongly-collapsed approval is a wrongly-answered approval.
- `category` is an allowlist of the ids in the table above; anything else is 400.

Redaction of `argSummary` itself is therefore the producer's obligation (the gateway,
before it encrypts), and the relay's job is to leave it no cleartext path to fail into.

## State

One SQLite file holding registrations (`pushId`, platform, token) and per-day notify
counts. Nothing else is stored.
