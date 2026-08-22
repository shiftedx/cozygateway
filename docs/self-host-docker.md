# Self-hosting CozyGateway with Docker

The Docker image is a Hermes-only CozyGateway. It contains no sample bot, mock backend, or Hermes
Dashboard. You mount a real Hermes configuration and pass its credentials separately. This keeps
the Dashboard control plane private while CozyGateway exposes only the phone-facing gateway.

For the normal host install, use the one-line installer instead. Docker is the advanced-operator
path for a machine that already runs Hermes and can give the gateway private reachability to its
Dashboard.

## Prepare the two operator files

Copy the Compose settings and the configuration template:

```sh
cp .env.example .env
mkdir -p local
cp docker/cozygateway.config.example.json local/cozygateway.config.json
chmod 644 local/cozygateway.config.json
```

Edit `local/cozygateway.config.json`. It is the one canonical runtime shape: a `hermes` control
connection plus one or more attach-v1 `profiles`. It contains environment variable names, never
credential values.

```json
{
  "name": "cozygateway",
  "host": "0.0.0.0",
  "port": 8787,
  "dbPath": "/data/cozygateway.db",
  "hermes": {
    "url": "ws://hermes:9119/api/ws",
    "authMode": "password",
    "username": "cozybridge",
    "passwordEnv": "COZYGATEWAY_HERMES_PASSWORD",
    "baseUrl": "http://hermes:9119",
    "profiles": {
      "sage": { "name": "Sage", "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_SAGE" }
    }
  }
}
```

Use a service name such as `hermes` when the Dashboard is on a private Compose network. The shipped
template uses `host.docker.internal` for a Dashboard deliberately reachable on the Docker host;
Compose adds the Linux `host-gateway` mapping. A Dashboard bound only to host loopback is not
reachable from an ordinary bridge container: put it on a private Docker network or bind it to a
private host interface. Never publish the Dashboard port to the internet.

Create the secret environment file named in `.env`; restrict it to the variables referenced by the
config:

```sh
umask 077
cat > local/cozygateway.env <<'EOF'
COZYGATEWAY_HERMES_PASSWORD='replace-with-the-dashboard-password'
COZYGATEWAY_ATTACH_TOKEN_SAGE='replace-with-Sage-attach-token'
EOF
chmod 600 local/cozygateway.env
```

If an environment value contains `$`, single-quote it in this file so Compose keeps it literal.
For token-based Dashboard auth instead, replace the password fields with
`"tokenEnv": "COZYGATEWAY_HERMES_TOKEN"` and add that variable to the secret file. See
[`packages/gateway/README.md`](../packages/gateway/README.md) for the control-auth variants.

## Start and pair

```sh
docker compose up --build -d
docker compose exec gateway node dist/cli.js pair \
  --config /config/cozygateway.config.json \
  --url https://gateway.example.net
```

The `--url` value is the exact origin CozyChat receives. Omit it only for a local/LAN setup where
the loopback default is intentionally correct. The gateway itself is the only service published by
the default Compose file; its SQLite state is in `gateway-data`.

The Hermes attach plugin for every configured profile points at the gateway's reachable origin and
uses that profile's `tokenEnv` value. The profile list drives both regular conversations and Bot
Mode; there is no second agent backend to configure.

For a direct `docker run`, the same rule applies: mount the config and supply the secret file.

```sh
docker build -f packages/gateway/Dockerfile -t cozygateway .
docker run --rm -p 8787:8787 \
  --add-host host.docker.internal:host-gateway \
  --env-file ./local/cozygateway.env \
  -v "$PWD/local/cozygateway.config.json:/config/cozygateway.config.json:ro" \
  -v gateway-data:/data \
  cozygateway
```

## Connectivity and TLS

The gateway's `8787` listener is the phone-facing surface. Keep the Hermes Dashboard private; it
is a control-plane dependency, not a public service. Choose your own reachability method for the
gateway (private LAN, Tailscale, or a Cloudflare Tunnel with a domain) and advertise that origin at
pair time. [`docs/connectivity.md`](connectivity.md) covers those choices and their security
boundaries.

For HTTPS termination, compose either overlay on the base file:

```sh
docker compose -f docker-compose.yml -f docker-compose.tls-caddy.yml up -d
docker compose -f docker-compose.yml -f docker-compose.tls-native.yml up -d
```

The Caddy overlay publishes only Caddy on `80`/`443`; the gateway remains private on the Compose
network. The native overlay mounts a PEM certificate and key set by `COZY_TLS_CERT_HOST_PATH` and
`COZY_TLS_KEY_HOST_PATH`. See [`docs/tls.md`](tls.md) for certificate expectations and CozyChat's
trust-on-first-use behavior.

## Push relay

By default, authenticated `/push` requests use `https://push.cozylabs.ai` with encrypted payloads.
The optional `local-push` profile is only for developers with an app signed by their own Apple team:

```sh
COZYGATEWAY_PUSH_RELAY_URL=http://relay:8788 \
  docker compose --profile local-push up --build -d
```

Set all APNs fields in `.env` and mount the `.p8` key as documented in `docker-compose.yml`; keep
the relay private to the Compose network. A self-hosted relay cannot send push notifications for
the store app because APNs credentials belong to its publisher team.
