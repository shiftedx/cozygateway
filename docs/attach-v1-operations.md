# Operating Hermes attach-v1

The Hermes installer creates one native attach identity per selected Hermes
profile. Its gateway config keeps the local Dashboard control URL and uses the
profile map, not a parallel `agents[]` identity or `nativeDataPlane` rollout
entry:

```json
{
  "hermes": {
    "profiles": {
      "ops": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_OPS" }
    }
  }
}
```

Every profile gets a unique bearer token and a persistent spool at
`<profile-home>/plugin-data/cozygateway/attach-v1.sqlite`. Preserve that spool
and the gateway SQLite database during backups and recovery. Do not run two
plugin instances with the same token.

Tokens appear only in the selected profile `.env` and the gateway's mode-600
runtime env file. The attach plugin connects out to the local gateway over
loopback; it exposes no listener on a Hermes host.

Create or delete the profile with Hermes, then rerun the one-line installer;
its default `--profiles all` selection reconciles the current set. Use an
explicit `--profiles default,ops` only to narrow coverage. Do not hand-edit
token values into JSON or service units. Gateway health plus each Hermes
profile gateway status are the relevant operational checks.
