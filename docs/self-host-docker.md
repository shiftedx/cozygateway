# Self-hosting cozygateway with Docker

Two containers: the gateway (your agent as a chat contact) and the push relay (ciphertext-only
notification forwarder). Both build from this monorepo and store SQLite on a named volume.

Prefer not to do this by hand? `docs/agent-install.md` is the same install written as a playbook an
AI agent can execute for you, end to end, including the Hermes dashboard wiring and the pairing
code. This document stays the reference for every field it sets.

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
| `COZYGATEWAY_HERMES_URL` | (config value) | retargets the optional hermes bots bridge; ignored when no bridge is configured |
| `COZY_TLS_CERT_FILE` | (unset: plain HTTP) | PEM certificate chain; set with the key to serve HTTPS (`docs/tls.md`) |
| `COZY_TLS_KEY_FILE` | (unset: plain HTTP) | matching unencrypted PEM private key |

### Optional: the hermes bots bridge

Add a `hermes` block to the config file to turn on the bots surface (`/bots`, the `bot_roster` and
`bot_presence` frames, and the `com.cozylabs.bots` capability; see `contract/ext-bots-v1.md`):

```json
{
  "hermes": { "url": "ws://homelab:8790/api/ws", "tokenEnv": "COZYGATEWAY_HERMES_TOKEN" }
}
```

The config file carries the env var NAME, never the credential. Startup fails closed when that
variable is unset. Use `"authParam": "ticket"` when you already hold a minted ws ticket instead of
a session token.

That default (`"authMode": "token"`) is the LOOPBACK shape: it works because a loopback Hermes
injects a session token. A Hermes dashboard behind dashboard auth (a gated, non-loopback bind)
injects no token, so point the bridge at the password shape instead:

```json
{
  "hermes": {
    "url": "ws://homelab:9119/api/ws",
    "authMode": "password",
    "username": "cozybridge",
    "passwordEnv": "COZYGATEWAY_HERMES_PASSWORD"
  }
}
```

The bridge then logs in at `POST {origin}/auth/password-login`, holds the
session cookie in memory, and mints a FRESH single-use ticket at `POST {origin}/api/auth/ws-ticket`
for every connect attempt, because one ticket is good for one upgrade within 30 seconds. The HTTP
origin is derived from the WebSocket URL (`ws` to `http`, `wss` to `https`); override it with
`"baseUrl"` when the dashboard is fronted elsewhere. A stale session re-logs in transparently; a
rejected password fails closed with no retry storm.

The login names an auth provider, `basic` by default. That is the implementation Hermes bundles,
not the protocol: a dashboard that registers a different password provider (an LDAP bind, say)
needs `"provider": "its-name"` in the same block. A provider the dashboard does not know answers a
generic HTTP 404, and the bridge log says which provider it tried, so the mismatch is not mistaken
for a bad password.

The `url` must be `ws://` or `wss://`. A missing scheme is rejected at startup rather than at dial
time, so a typo can never leave the bots capability advertised over a bridge that is dead for the
life of the process.

#### A pure-bots gateway needs no agents

A gateway whose whole surface is the bots bridge takes an empty `agents` list, or none at all:

```json
{
  "name": "cozy-bots",
  "hermes": { "url": "ws://homelab:8790/api/ws", "tokenEnv": "COZYGATEWAY_HERMES_TOKEN" }
}
```

A gateway must still serve SOMETHING: a config with neither an agent nor a `hermes` block fails at
startup saying so. There is no longer any reason to keep a placeholder attach agent in the config of
a box that only serves bots.

#### Hiding profiles from the roster

Hermes profiles that are not bots anybody should chat with (automation or service profiles) can be
kept off this gateway's roster:

```json
{
  "hermes": {
    "url": "ws://homelab:8790/api/ws",
    "tokenEnv": "COZYGATEWAY_HERMES_TOKEN",
    "hiddenProfiles": ["ops-runner", "sweeper"]
  }
}
```

They stay real profiles Hermes-side, and every `/bots/:name` route still addresses them; they are
only left out of `GET /bots` and the `bot_roster` and `bot_presence` frames. Names are matched
case-insensitively, since Hermes stores profile ids lowercase.

#### Protecting the bridge's own profile

`DELETE /bots/:name` deletes a real Hermes profile, and deleting one stops that profile's gateway.
If the bridge talks to a gateway running under a named profile, tell it so and that name becomes
undeletable over the API:

```json
{
  "hermes": {
    "url": "ws://homelab:8790/api/ws",
    "tokenEnv": "COZYGATEWAY_HERMES_TOKEN",
    "profile": "ops-host"
  }
}
```

It is optional and never guessed. The JSON-RPC surface reports which profile a SESSION is routed to,
never which profile the gateway process itself was launched under, and a wrong guess would make a
real bot permanently undeletable. Leave it out and there is no guard, which is where the gateway
already stood.

Relay:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COZY_RELAY_PORT` | `8788` | listen port (compose maps and passes it to the relay CLI) |

## TLS

By default the gateway serves plaintext over `0.0.0.0` inside the container, which is correct
behind a reverse proxy and fine on a trusted LAN. Two shipped options terminate TLS without any
box-specific proxy surgery:

- `docker compose -f docker-compose.yml -f docker-compose.tls-caddy.yml up -d`: a Caddy sidecar on
  443, certificate issued and renewed for you.
- `docker compose -f docker-compose.yml -f docker-compose.tls-native.yml up -d`: the gateway
  terminates TLS itself from a cert/key pair you mount (`COZY_TLS_CERT_FILE` /
  `COZY_TLS_KEY_FILE`).

Both are overlays; naming neither leaves the deployment exactly as it was. With the TLS variables
unset the gateway serves plain HTTP; set one without the other, or set them to something unusable,
and it refuses to start rather than falling back to plaintext. See `docs/tls.md` for which to pick
and for what the app's trust-on-first-use certificate pinning expects.

Whatever you choose, do not put a plaintext gateway on the open internet.

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
