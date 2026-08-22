# cozygateway vendor extension: com.cozylabs.push-proxy, v1

Status: draft. Versioned independently of `contract/v1.md`, which stays frozen. This optional
surface lets a phone use the gateway's public origin for push relay registration while the relay
remains reachable only from the gateway's private network.

The configured relay origin is shared with the gateway's own `POST /notify` calls. When it is
present, it takes precedence over the `relayUrl` stored in a core `PushRegisterRequest`, so both
registration lifecycle calls and notification delivery reach the same private relay.

## Discovery

A gateway with a private push relay target configured advertises:

```json
"capabilities": { "com.cozylabs.push-proxy": 1 }
```

The value is the extension version. A client compares `>= 1`, not `=== 1`. A gateway without a
relay target omits the capability and answers 404 for the extension routes.

## Authentication

Every route in this extension requires the same `Authorization: Bearer <deviceToken>` header as
the gateway's other device routes. A missing or unknown token returns the ordinary gateway 401
response. Authentication completes before any relay request is made. The gateway device token is
not forwarded to the relay.

## Routes

### POST /push/register

For a relay registration body, the gateway sends the request body unchanged to `POST /register`
on its configured relay. The relay's response status and body pass back unchanged. The relay wire
body remains the one in `contract/push-v0.md`:

```json
{ "platform": "webhook" | "apns" | "apns-liveactivity", "token": "string", "environment"?: "development" | "production" }
```

`environment` is valid only for either APNs platform and identifies the Apple Push Notification
service that issued the device token. It lets one relay serve locally signed development builds and
production/TestFlight builds without treating a sandbox token as a production token. Clients that
omit it retain the relay's configured default for compatibility.

The frozen core contract already uses `POST /push/register` for `PushRegisterRequest`. That body is
distinct and keeps its existing local gateway behavior:

```json
{ "pushId": "string", "relayUrl": "string", "pushKey": "string" }
```

A body that validates as `PushRegisterRequest` is stored by the gateway. Every other body is sent
unchanged to the relay, which remains responsible for validating its own registration contract.

### DELETE /push/register/:pushId

The gateway sends the request to `DELETE /register/:pushId` on its configured relay. The response
status and body pass back unchanged. Relay deletion is idempotent and normally returns 204.

### POST /push/live-activities/register

Registers or rotates one ActivityKit push token, scoped to the authenticated device and activity:

```json
{
  "activityId": "ActivityKit id", "runId": "client run id", "conversationId": "gateway id",
  "bot": "canonical bot name", "token": "lowercase hex", "environment": "development" | "production"
}
```

The gateway registers the raw token with its private relay as `apns-liveactivity`, stores only the
opaque relay push id, and deletes the replaced relay registration. Canonical bot state, tool and
delta frames drive coarse `thinking`, `usingTools`, and `writing` updates. Only an authoritative
terminal `bot_chat_state` ends an activity; transcript/history snapshots never do. Payloads contain
no prompt, response text, tool names, arguments, or results. Normal updates use APNs priority 5 and
the ordinary encrypted completion notification remains the sole alert.

### DELETE /push/live-activities/:activityId

Removes the authenticated device's activity registration and its opaque relay registration. It is
idempotent and returns 204.

## Routes that are not proxied

`POST /notify` is gateway-internal. There is no `POST /push/notify` route, and a request to that
path returns 404 even with a valid device token. This rule prevents the device surface from
becoming a notification-sending oracle.

`GET /health` is an operator probe, not a route a client uses for registration lifecycle work. It
is not mirrored under `/push`. The complete client-facing relay proxy surface is POST registration
and DELETE registration.
