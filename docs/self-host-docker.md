# Self-hosting cozygateway with Docker

Two containers: the gateway (your agent as a chat contact) and the push relay (ciphertext-only
notification forwarder). Both build from this monorepo and store SQLite on a named volume.

## Try it in one command (reference echo backend)

    docker build -f packages/gateway/Dockerfile -t cozygateway .
    docker run --rm -p 8787:8787 -e COZYGATEWAY_HOST=0.0.0.0 cozygateway

The image ships a default `mock` ("echo") agent. In another terminal, mint a pairing code:

    docker exec <container> node dist/cli.js pair --config /app/cozygateway.config.json

## Full deployment (gateway + relay via compose)

    cp .env.example .env      # then edit COZYGATEWAY_ATTACH_TOKEN
    docker compose up --build

- The gateway listens on `8787`, the relay on `8788` (override the relay port with
  `COZY_RELAY_PORT`).
- The mounted `docker/cozygateway.config.json` selects the `attach` backend; point your agent
  harness's plugin at `http://<host>:8787/attach` with `COZYGATEWAY_TOKEN` equal to
  `COZYGATEWAY_ATTACH_TOKEN`.
- SQLite persists in the `gateway-data` and `relay-data` named volumes.

## Environment

Gateway:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COZYGATEWAY_HOST` | `127.0.0.1` (image sets `0.0.0.0`) | bind address |
| `COZYGATEWAY_PORT` | `8787` | listen port |
| `COZYGATEWAY_DB_PATH` | `cozygateway.db` (image sets `/data/cozygateway.db`) | SQLite path |
| `COZYGATEWAY_ATTACH_TOKEN` | (required for the attach config) | bearer token the plugin presents on `/attach` |

Relay:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COZY_RELAY_PORT` | `8788` | listen port (compose maps and passes it to the relay CLI) |

## Security note

The gateway serves plaintext over `0.0.0.0` inside the container. Keep it on a trusted network
(the homelab LAN) or behind your own TLS-terminating reverse proxy; TLS with certificate pinning
for the phone link is planned upstream.

## Push over APNs (optional)

The relay is webhook-only by default. To deliver real iOS push, configure APNs token auth and
mount your `.p8` key:

1. In the Apple developer portal, create an APNs auth key (`.p8`), and note the key id, your team
   id, and the app bundle id (`com.cozylabs.cozychat`).
2. Put the `.p8` on the host and uncomment the relay `.p8` volume in `docker-compose.yml`.
3. Set in `.env`: `APNS_KEY_P8_HOST_PATH`, `APNS_KEY_P8_PATH=/keys/apns.p8`, `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_TOPIC=com.cozylabs.cozychat`, `APNS_ENVIRONMENT` (`development` for a dev
   build, `production` for TestFlight/App Store).

Relay APNs environment:

| Variable | Meaning |
| --- | --- |
| `APNS_KEY_P8_PATH` | in-container path to the mounted `.p8` (e.g. `/keys/apns.p8`) |
| `APNS_KEY_ID` | the APNs auth key id |
| `APNS_TEAM_ID` | your Apple developer team id |
| `APNS_TOPIC` | the app bundle id (`com.cozylabs.cozychat`) |
| `APNS_ENVIRONMENT` | `development` or `production` |

When any of these is set they must all be set, or the relay fails to start.
