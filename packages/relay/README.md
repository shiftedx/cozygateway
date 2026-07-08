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
before the relay connects to it. Platform push transports (APNs) are planned; registering
`platform: "apns"` returns 501 until then.

## State

One SQLite file holding registrations (`pushId`, platform, token) and per-day notify
counts. Nothing else is stored.
