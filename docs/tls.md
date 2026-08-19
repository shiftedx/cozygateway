# TLS for the phone link

By default the gateway serves plain HTTP. That is the right default for a box that already
terminates TLS in a reverse proxy in front of it, and it is unchanged by anything on this page: a
deployment that sets none of the variables below behaves exactly as it always has.

There are two first-class ways to get HTTPS, and you pick one.

| | **A. Caddy sidecar** (`docker-compose.tls-caddy.yml`) | **B. Gateway-native TLS** (`docker-compose.tls-native.yml`) |
| --- | --- | --- |
| Who terminates | a Caddy container in front | the gateway process itself |
| Certificate | issued and renewed for you (local CA, or Let's Encrypt for a public name) | you supply the PEM pair |
| Extra container | yes | no |
| Pick it when | you want issuance and renewal handled, or you may later add other services behind the same name | you already have a certificate you must use (corporate CA, an internal PKI, a cert another tool on the box issues), or one more container is one too many |

If you already run a reverse proxy (Traefik, nginx, Cloudflare Tunnel), keep doing that: point it
at the gateway's plain-HTTP port and ignore both files. Neither is required.

## Option A: the Caddy sidecar

    cp .env.example .env        # set COZY_TLS_HOSTNAME
    docker compose -f docker-compose.yml -f docker-compose.tls-caddy.yml up -d

The overlay adds a `caddy` service on 443 and stops publishing the gateway's plaintext port to the
host, so the only way in is through TLS. The gateway itself is untouched and still speaks HTTP on
the private compose network.

`docker/Caddyfile.example` ships with `tls internal`, which makes Caddy run its own CA and issue a
certificate for whatever name you gave, with no ACME and no reachability from the internet. That is
the LAN homelab case. Delete the `tls internal` line and Caddy provisions a real Let's Encrypt
certificate instead, which needs the hostname to resolve to the machine and ports 80/443 reachable.

Keep the `caddy-data` volume. It holds the issued certificate and, for `tls internal`, the local CA
root; losing it mints a new identity, which the app will treat as a changed certificate (see the
TOFU note below).

Caddy rather than Traefik for the shipped example: `tls internal` is one directive, and the
LAN-with-no-public-name case needs no further configuration at all. Traefik's equivalent is a static
config plus an entrypoint plus a certificate resolver plus per-service labels, and on a box that
already runs Traefik as shared infrastructure a second, pasteable Traefik config is a hazard rather
than a convenience. Nothing in the gateway is Caddy-specific; any terminating proxy works.

## Option B: gateway-native TLS

Give the gateway a certificate and key and it serves HTTPS itself.

    cp .env.example .env        # set COZY_TLS_CERT_HOST_PATH and COZY_TLS_KEY_HOST_PATH
    docker compose -f docker-compose.yml -f docker-compose.tls-native.yml up -d

Outside Docker, set the paths directly:

    COZY_TLS_CERT_FILE=/etc/cozygateway/cert.pem \
    COZY_TLS_KEY_FILE=/etc/cozygateway/key.pem \
      node packages/gateway/dist/cli.js serve --config cozygateway.config.json

or put them in the config file, which the environment then overrides:

```json
{
  "tls": { "certFile": "/etc/cozygateway/cert.pem", "keyFile": "/etc/cozygateway/key.pem" }
}
```

| Variable | Meaning |
| --- | --- |
| `COZY_TLS_CERT_FILE` | path to the PEM certificate chain, leaf first |
| `COZY_TLS_KEY_FILE` | path to the matching unencrypted PEM private key |

Rules, all of them checked before the listener binds:

- **Neither set: plain HTTP, unchanged.** This is the default and it stays silent.
- **Both set and usable: HTTPS.** `/ws` and `/attach` become `wss` with it, automatically; nothing
  about the WebSocket endpoints is configured separately.
- **Set but broken: the gateway refuses to start,** naming the file and the reason. An unreadable
  path, an empty file, a garbage PEM, an encrypted key, and a key that does not match the
  certificate are all startup failures, not first-handshake failures. Half-configuring it (one
  variable, not both) is a startup failure too. The point is that a typo can never downgrade you to
  a plaintext listener on a port you believed was encrypted.

`cozygateway pair` prints a `gatewayUrl` whose scheme follows the same config, so a pairing QR from
a TLS gateway sends the phone to `https://`.

Generating a self-signed pair for a LAN box, if you have no CA:

    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -keyout key.pem -out cert.pem \
      -subj "/CN=homelab.lan" \
      -addext "subjectAltName=DNS:homelab.lan,IP:192.168.1.50"

Put every name and address the phone might dial in `subjectAltName`. Keep `key.pem` readable only
by the user the gateway runs as.

## What the app expects (TOFU pinning)

CozyChat pins the gateway's certificate on first use. At pairing time it records the certificate it
was served and refuses a different one afterwards, which is what makes a self-signed certificate a
supported posture rather than a warning to click through: the certificate does not have to chain to
a CA your phone trusts, it has to be the same certificate every time.

Consequences worth knowing before you choose:

- **Self-signed is fine, and is expected for the LAN homelab case.** Both options above produce a
  certificate the OS does not trust by default (`tls internal` in option A, your own pair in
  option B), and both work.
- **Rotating the certificate breaks the pin.** Renewing with the same key and CA is fine; a genuinely
  new certificate is not, and devices will refuse to connect until they re-pair. Persist the
  `caddy-data` volume (option A) or keep your pair (option B).
- **Verify the fingerprint once, at pairing.** TOFU only protects the connections after the first
  one. Pair on the LAN, not across an untrusted network.
- **A publicly trusted certificate still gets pinned.** Let's Encrypt renewals rotate the
  certificate, so a public-hostname deployment will hit the rotation case above; that is the tradeoff
  for not having to confirm a fingerprint.

## Does this change the install path?

No. `docs/agent-install.md` and `scripts/agent-install.sh` install the plain-HTTP gateway and are
unaffected: they set neither `COZY_TLS_CERT_FILE` nor `COZY_TLS_KEY_FILE`, so the gateway they
produce serves HTTP on the LAN exactly as before, and every health check and pairing command in
them is unchanged. Adding TLS is a follow-on step, taken from this page after the install is
working.
