# cozygateway front door contract, v0

Status: v0, NOT frozen until the installer (plan B) ships against it.

This document describes the shared front door and its outbound household agent. The front door
is a routing service, not a gateway for user content. It assigns a pooled hostname to a household
and carries the target connection through an authenticated agent link.

## Roles

- **Front door**: the shared listener. It owns the hostname pool, provisions household grants,
  authenticates agents, and routes streams. It stores a hash of each credential.
- **Agent**: the household-side process. It dials the front door, authenticates with its
  credential, and connects each received stream to the local target service.
- **Control client**: the installer or operator client. It calls `POST /provision`, stores the
  returned grant, and gives the credential and hostname to the household setup.

The front door's API hostnames serve the control endpoints. A provisioned pool hostname serves
the household's forwarded traffic. The pool and API hostname lists are operator configuration.

## HTTP endpoints

All JSON errors use this shape:

```json
{ "error": { "code": "string", "message": "string" } }
```

### POST /provision

Request body: optional and ignored. The v0 implementation does not parse or validate it. An empty
JSON object is conventional, but empty-body and non-JSON requests are also accepted.

```json
{}
```

Response: `200` with a newly assigned grant.

```json
{
  "householdId": "hh_0123456789ab",
  "credential": "fdc_...",
  "hostname": "relay-01.cozylabs.ai",
  "protocol": "frontdoor-v0"
}
```

The credential is returned at provisioning time and is not returned by later endpoints. One free
pool hostname is assigned to each grant. A hostname stays assigned after the agent disconnects.

Errors:

| Status | Code | Meaning |
| --- | --- | --- |
| `429` | `rate_limited` | This source IP has reached the configured sliding one-hour provision limit. |
| `503` | `pool_exhausted` | No unassigned hostname remains in the configured pool. |
| `503` | `over_cap` | The configured total household cap has been reached. |

### GET /healthz

Response: `200`.

```json
{ "ok": true, "households": 1 }
```

`households` is the number of provisioned households in the front door database.

## Agent attach

The agent opens a WebSocket connection with `GET /agent`. The request must carry the credential
in the authorization header:

```text
Authorization: Bearer fdc_...
```

The front door answers `401 Unauthorized` and closes the upgrade when the header is missing or
the credential does not match a provisioned household. There is no application hello frame after
the WebSocket upgrade. The authenticated connection is identified by the credential's household.

There is one live connection per household. If a newer authenticated connection arrives, the front
door closes the older connection and routes new streams to the newer one. The older connection's
in-flight streams are aborted during cleanup. This is newest-connection-wins behavior.

## Frames

Frames are JSON text WebSocket messages. `sid` identifies one HTTP request or upgraded stream and
is unique for the lifetime of a front door process. Binary payloads are represented as standard
base64 in `b64`.

### `open`

Direction: front door to agent. Starts a request or an HTTP upgrade.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | literal `"open"` | Frame discriminator. |
| `sid` | number | Stream id. |
| `method` | string | Incoming HTTP method. |
| `path` | string | Incoming request target, including its path and query. |
| `headers` | `Record<string, string[]>` | Incoming raw headers grouped by lowercase name. |
| `upgrade` | boolean | True when the client requested an HTTP upgrade. |

### `head`

Direction: agent to front door. Sends the target response head.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | literal `"head"` | Frame discriminator. |
| `sid` | number | Stream id. |
| `status` | number | HTTP response status. |
| `headers` | `Record<string, string[]>` | Response headers grouped by lowercase name. |

### `data`

Direction: both sides. Carries a chunk of request or response bytes.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | literal `"data"` | Frame discriminator. |
| `sid` | number | Stream id. |
| `b64` | string | Base64-encoded bytes. The decoded bytes are opaque to the front door. |

### `end`

Direction: both sides. Marks the sending side's end of stream.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | literal `"end"` | Frame discriminator. |
| `sid` | number | Stream id. |

### `abort`

Direction: both sides. Terminates a stream before a normal end.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | literal `"abort"` | Frame discriminator. |
| `sid` | number | Stream id. |
| `reason` | string, optional | Short diagnostic reason. It is not a protocol decision or user content. |

Unknown or malformed JSON frames are ignored by the WebSocket endpoints. A decoded frame for a
known stream is checked against the stream state rules below.

## Stream lifecycle

For ordinary HTTP traffic the front door sends `open`, then zero or more request `data` frames,
then request `end`. The agent connects the request to the configured target. The agent sends
exactly one `head`, followed by zero or more response `data` frames, then response `end`.

For an HTTP upgrade, `open` has `upgrade: true`. The front door can send initial upgrade bytes in a
`data` frame. After a successful `101` head, both sides exchange opaque data frames until one side
ends or aborts the stream.

The lifecycle rules are:

- Each stream has exactly one response `head` from the agent.
- A response `head` must precede every response `data` or response `end` frame.
- `abort` is terminal. Either side may send it, and the other side destroys its local stream.
- A second `head`, `data` or `end` before `head`, or any other invalid response transition while
  the stream is active, causes the front door to abort that stream. Once a stream is removed from
  the active stream table, later frames for its `sid` are ignored.
- If an agent WebSocket dies, the front door aborts all streams owned by that agent.
- If the client closes its response or upgraded socket, the front door sends one `abort` frame for
  that stream, exactly once. A completed or already-aborted stream sends no second abort.
- A non-`101` upgrade response is written to the client and the stream ends without a second abort.

## Security notes

- Credentials have the `fdc_` prefix and are random. The front door stores only their SHA-256
  hashes, never the credential strings.
- The expected `ts2021` payload is Noise-encrypted ciphertext. The front door carries that
  ciphertext and does not decrypt it or inspect the application bytes.
- A front door compromise can observe routing metadata, refuse or interrupt connections, and
  consume the finite provisioning pool. It cannot recover a credential from storage or read the
  Noise-encrypted payload. Compromise impact is denial of service only for the protected tunneled
  content.
- Provisioning is intentionally bounded by a per-source-IP rate limit and a total household cap.

## Future wire format

The JSON plus base64 representation is a deliberate v0 control-path simplification. A binary frame
encoding is a v1 candidate if the control path needs lower overhead.
