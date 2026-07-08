# cozygateway push contract, v0

Status: v0, NOT frozen. This document may change until the phone app ships. The client
wire contract (`contract/v1.md`) is frozen and is not modified by this document; the
`POST /push/register` shape it defines is the gateway-side half of this flow.

## Roles

- **Gateway**: the user's self-hosted process. Knows the device's `pushKey`. Encrypts.
- **Relay**: a small forwarding service (self-hostable; a hosted instance exists). Maps an
  opaque `pushId` to a delivery transport. Never sees keys or plaintext.
- **Client**: registers with a relay, hands `pushId` + `relayUrl` + `pushKey` to its
  gateway via `POST /push/register` (contract v1), decrypts notifications on-device.

## Relay endpoints

All bodies are JSON. Errors use `{"error": {"code": string, "message": string}}` with
codes `invalid_request`, `not_found`, `over_cap`, `unsupported_platform`, `internal`.

### POST /register

Request: `{"platform": "webhook" | "apns", "token": string}`

- `webhook`: `token` is an `http(s)` URL. Delivery is `POST <token>` with body
  `{"ciphertext": string}`.
- `apns`: recognized, not yet available; returns 501 `unsupported_platform`.

Response: 201 `{"pushId": string}`. The pushId is 16 random bytes, base64url. It is
unguessable and knowing it is the de-facto capability to notify that registration.
Registering again mints a new pushId; old ids keep working until deleted.

### POST /notify

Request: `{"pushId": string, "ciphertext": string}` (`ciphertext` max 8192 chars).

Response: 202 `{}` once the notify is accepted and handed to the transport. Delivery is
best-effort; the relay does not queue or retry in v0, and a delivery failure still
returns 202 and still counts against the cap.

- Unknown pushId: 404 `not_found`. A gateway receiving this should delete its stored
  registration for that device.
- Per-pushId daily cap (default 500, UTC calendar day): 429 `over_cap`.

### DELETE /register/:pushId

Response: 204, idempotent.

### GET /health

Response: 200 `{"name": "cozygateway-relay", "version": string}`.

## Notification ciphertext

- Plaintext: UTF-8 JSON `{"threadId": string, "agentName": string, "preview": string}`.
  The gateway truncates `preview` to at most 200 characters.
- Key: HKDF-SHA256 with ikm = the UTF-8 bytes of the registered `pushKey` string exactly
  as received, salt = empty (zero-length), info = the ASCII string
  `cozygateway-push-v0`, output length = 32 bytes.
- Encryption: AES-256-GCM, 12-byte random nonce per notification, 16-byte tag.
- Wire form: `base64url(nonce || ciphertext || tag)`, no padding.

### Test vector

- pushKey: `test-push-key`
- derived key (hex): `ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62`
- nonce (hex): `000102030405060708090a0b`
- plaintext: `{"threadId":"thread-1","agentName":"Demo Agent","preview":"Hello from the gateway"}`
- ciphertext (base64url): `AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM`

## Gateway behavior (informative)

The gateway sends one notify per registered device when an agent reply commits while no
client is connected. Outcomes are fire-and-forget: 404 prunes that device's
registration; anything else is logged and the registration kept.
