# TLS and remote access

The Hermes one-paste installer defaults to loopback plain HTTP on
`127.0.0.1:8787`. It does not obtain certificates, configure a proxy, open a
firewall, create DNS, install Tailscale, or create a Cloudflare
Tunnel. Those are operator-owned network decisions.

For TLS directly in the gateway, configure both a certificate and key path in
the gateway environment or config as documented by the gateway runtime. Keep
the key readable only by the gateway user. The Hermes attach plugin automatically
uses `wss` when its `COZYGATEWAY_URL` is an `https://` URL.

For an internet-visible service, set `publicUrl` through the installer's `--public-url` flag and
terminate TLS at a user-managed reverse proxy or named Cloudflare Tunnel. The gateway stays on
loopback and startup refuses a non-HTTPS advertised origin or a non-loopback listener. The proxy
must preserve `/ws` upgrades and authenticated REST headers; `/attach/v1` remains separately
bearer-authenticated for backend adapters. Do not place any bearer token in a URL.

See `docs/connectivity.md` for explicit Tailscale and Cloudflare examples.
