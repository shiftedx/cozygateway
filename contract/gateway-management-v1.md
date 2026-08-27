# CozyGateway device management v1

Capability: `com.cozylabs.gateway-management: 1`.

The capability is advertised only when the running gateway was started from a known writable
config path. Both routes require the ordinary device bearer token. A programmatic gateway without
such a path answers `409 invalid_request`; it never pretends an edit was persisted.

## `GET /gateway/settings`

Returns `{ "name": string, "hermesEndpoints": HermesEndpointSetting[] }`.

## `PUT /gateway/settings`

Full replacement with the same shape. Returns that persisted shape plus
`"restartRequired": true`. The gateway writes atomically in the source file's directory and
preserves its permission bits. The running process keeps its startup snapshot until restarted.

Each endpoint is:

```json
{
  "id": "home",
  "label": "Home Mac",
  "url": "ws://127.0.0.1:8790/api/ws",
  "authMode": "token",
  "tokenEnv": "HERMES_SESSION_TOKEN",
  "profiles": { "sage": { "tokenEnv": "SAGE_ATTACH_TOKEN", "name": "Sage" } }
}
```

`id` is a stable lowercase slug. `label` is optional presentation text. The remaining optional
fields mirror the file config: `authParam`, `username`, `passwordEnv`, `provider`, `baseUrl`,
`hiddenProfiles`, `profile`, `seedBlankSlateBots`, `blankSlateSkillsOn`, and `chatSuggestion`.

Only environment-variable **names** are representable (`tokenEnv`, `passwordEnv`, and each
profile's `tokenEnv`). Inline `token`, `password`, `secret`, or any other unknown field is rejected;
GET never resolves or returns environment values.

## Stable bot identity

Every profile from `hermesEndpoints` is app-facing as `<endpoint-id>:<normalized-profile-id>`.
The colon is part of the opaque bot id and is percent-encoded when necessary in URL paths. This
always-on namespace means adding a second endpoint or a duplicate profile later cannot rename an
existing bot. Legacy files with one `hermes` object retain their historical bare profile ids. The
first successful PUT migrates that legacy object to endpoint id `default` and therefore returns
`default:<profile-id>` after the required restart.

Roster reads are best-effort across endpoints: an unavailable endpoint makes `/ready` fail and the
aggregate roster stale, while healthy endpoint rows and the failed endpoint's last cached rows
remain visible. Conversation and control routes dispatch solely from the stable endpoint prefix.
