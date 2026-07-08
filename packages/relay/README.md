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
