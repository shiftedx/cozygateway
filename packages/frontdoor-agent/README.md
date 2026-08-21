# cozy-frontdoor-agent

An outbound connector for a Cozy Private Network household box. It opens and maintains the
authenticated WebSocket connection to `cozy-frontdoor`, then forwards HTTP and WebSocket traffic
to a local target service. The connection is outbound from the household box.

Requires Node.js >= 24.

## Run

```sh
FRONTDOOR_URL=https://frontdoor.example \
FRONTDOOR_CREDENTIAL=fdc_... \
  node dist/cli.js
```

`FRONTDOOR_URL` and `FRONTDOOR_CREDENTIAL` are required. The agent reconnects with backoff when
the front door connection closes and prints `agent connected` after the first successful attach.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `FRONTDOOR_URL` | required | Front door HTTP origin. |
| `FRONTDOOR_CREDENTIAL` | required | Credential returned by `POST /provision`. |
| `TARGET_HOST` | `127.0.0.1` | Local service address. |
| `TARGET_PORT` | `8099` | Local service port. |

The front door carries the target's HTTP and `ts2021` WebSocket bytes as JSON frames with
base64-encoded data. See [`contract/frontdoor-v0.md`](../../contract/frontdoor-v0.md).

## License

MIT
