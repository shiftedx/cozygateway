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
mkdir -p local/config local/secrets
cp docker/cozygateway.config.example.json local/config/cozygateway.config.json
sudo chown -R 1000:1000 local/config
chmod 750 local/config
chmod 640 local/config/cozygateway.config.json
```

The image runs as the `node` user (UID 1000), which must be able to create a sibling temporary file
in `local/config` and rename it over the configuration. That directory is mounted writable so
authenticated gateway renames remain atomic and survive restarts. Do not replace it with a
single-file bind mount: Docker cannot atomically replace a bind-mounted file. Keep secrets in the
separate `local/secrets` directory, which is not mounted into the container.

Edit `local/config/cozygateway.config.json`. It is the one canonical runtime shape: a `hermes` control
connection plus one or more attach-v1 `profiles`. It contains environment variable names, never
credential values.

```json
{
  "name": "cozygateway",
  "host": "0.0.0.0",
  "port": 8787,
  "dbPath": "/data/cozygateway.db",
  "hermesEndpoints": [{
    "id": "default",
    "url": "ws://hermes:9119/api/ws",
    "authMode": "password",
    "username": "cozybridge",
    "passwordEnv": "COZYGATEWAY_HERMES_PASSWORD",
    "baseUrl": "http://hermes:9119",
    "profiles": {
      "sage": { "name": "Sage", "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_SAGE" }
    }
  }]
}
```

### A CozyAgents-only gateway (no Hermes)

`hermesEndpoints` is optional from capability 52. A gateway whose bots all run on paired CozyAgents
runners omits it entirely:

```json
{
  "name": "cozygateway",
  "host": "127.0.0.1",
  "port": 8787,
  "dbPath": "/data/cozygateway.db"
}
```

Such a gateway starts, serves `/bots` and `/runners` from its own rows, and advertises
`com.cozylabs.bots`. It advertises no Hermes-shaped capability, and `/health` and `/ready` report
`bridges: {"hermes": "absent"}` with `/ready` answering `200`: there is no bridge to alarm on. Pair
a computer to it with `cozygateway pair --kind runner` and hand the code to the CozyAgents
installer. Revoke one with `DELETE /runners/:id`, which closes that runner's socket.

Use a service name such as `hermes` when the Dashboard is on a private Compose network. The shipped
template uses `host.docker.internal` for a Dashboard deliberately reachable on the Docker host;
Compose adds the Linux `host-gateway` mapping. A Dashboard bound only to host loopback is not
reachable from an ordinary bridge container: put it on a private Docker network or bind it to a
private host interface. Never publish the Dashboard port to the internet.

Create the secret environment file named in `.env`; restrict it to the variables referenced by the
config:

```sh
umask 077
cat > local/secrets/cozygateway.env <<'EOF'
COZYGATEWAY_HERMES_PASSWORD='replace-with-the-dashboard-password'
COZYGATEWAY_ATTACH_TOKEN_SAGE='replace-with-Sage-attach-token'
EOF
chmod 600 local/secrets/cozygateway.env
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
the default Compose file, and it is published on `127.0.0.1:8787` only; its SQLite state is in
`gateway-data`. To deliberately expose plaintext on a trusted LAN, compose the LAN overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d
```

Do not use that overlay for an internet-facing deployment. Use one of the TLS overlays below and
pair using its HTTPS origin instead.

The Hermes attach plugin for every configured profile points at the gateway's reachable origin and
uses that profile's `tokenEnv` value. The profile list drives both regular conversations and Bot
Mode; there is no second agent backend to configure.

For a direct `docker run`, the same rule applies: mount the config and supply the secret file.

```sh
docker build -f packages/gateway/Dockerfile -t cozygateway .
docker run --rm -p 8787:8787 \
  --add-host host.docker.internal:host-gateway \
  --env-file ./local/secrets/cozygateway.env \
  -v "$PWD/local/config:/config:rw" \
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
`COZY_TLS_KEY_HOST_PATH`; combine it with `docker-compose.lan.yml` when the TLS listener needs to
be reachable off-host. See [`docs/tls.md`](tls.md) for certificate expectations and CozyChat's
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
