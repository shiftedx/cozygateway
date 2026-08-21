# cozy-frontdoor

The shared reachability front door for Cozy Private Network. It assigns pooled relay hostnames
to household boxes, accepts outbound agent connections, and forwards HTTP and WebSocket traffic
to the assigned box. The front door does not decrypt the tunneled payload.

Requires Node.js >= 24.

## Run

```sh
FRONTDOOR_POOL=relay-01.cozylabs.ai,relay-02.cozylabs.ai \
  node dist/cli.js
```

The service listens on `0.0.0.0:8790` by default and stores its SQLite database at
`/data/frontdoor.db`. `FRONTDOOR_POOL` is required. The full endpoint and frame contract is in
[`contract/frontdoor-v0.md`](../../contract/frontdoor-v0.md).

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `FRONTDOOR_PORT` | `8790` | Listener port. |
| `FRONTDOOR_HOST` | `0.0.0.0` | Listener address. |
| `FRONTDOOR_DB` | `/data/frontdoor.db` | SQLite database path. |
| `FRONTDOOR_POOL` | required | Comma-separated relay hostnames assigned to households. |
| `FRONTDOOR_API_HOSTNAMES` | `relay.cozylabs.ai` | Hostnames serving `/provision` and `/healthz`. |
| `FRONTDOOR_MAX_HOUSEHOLDS` | `500` | Total household cap. |
| `FRONTDOOR_PROVISIONS_PER_HOUR` | `5` | Provision limit per source IP per sliding hour. |

`POST /provision` returns a household id, one-time credential, and assigned hostname. The
credential is used by `cozy-frontdoor-agent` to establish the outbound connection.

## Docker

The image is built from the monorepo root:

```sh
docker build -f packages/frontdoor/Dockerfile .
```

Mount `/data` for the SQLite database and provide `FRONTDOOR_POOL` at runtime.

## License

MIT
