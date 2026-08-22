# TLS and remote access

The Hermes one-paste installer defaults to LAN-ready plain HTTP on
`0.0.0.0:8787`. It does not obtain certificates, configure a proxy, open a
firewall, create DNS, install Tailscale, or create a Cloudflare
Tunnel. Those are operator-owned network decisions.

For TLS directly in the gateway, configure both a certificate and key path in
the gateway environment or config as documented by the gateway runtime. Keep
the key readable only by the gateway user. The Hermes attach plugin automatically
uses `wss` when its `COZYGATEWAY_URL` is an `https://` URL.

For an internet-visible service, terminate TLS at a user-managed reverse proxy
or named Cloudflare Tunnel. The gateway itself must still be reachable from the
proxy and the proxy must preserve WebSocket upgrades, `Authorization`, and
`Range` on `/attach/v1`. Do not place an attach token in a URL.

See `docs/connectivity.md` for explicit Tailscale and Cloudflare examples.
