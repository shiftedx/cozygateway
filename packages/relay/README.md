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
