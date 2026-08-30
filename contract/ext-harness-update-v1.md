# Hermes harness update extension v1

Capability id: `com.cozylabs.harness-update`

Version: `1`

This paired-device extension checks and applies an update to one configured Hermes harness. It is
harness-level: a request names exactly one current `:harnessId`, never a profile/scope. Every route
requires a paired-device bearer token.

## Routes

| Route | Request | Success response |
| --- | --- | --- |
| `GET /gateway/harnesses/:harnessId/update/check` | none | `HarnessUpdateCheck` |
| `POST /gateway/harnesses/:harnessId/update/start` | `HarnessUpdateStartRequest` | `202 HarnessUpdateStart` |
| `GET /gateway/harnesses/:harnessId/update/status` | none | `HarnessUpdateStatus` |

`start` MUST compare `expectedCurrentVersion` to a fresh upstream check inside the serialized start
lane. A mismatch returns `409`; the gateway never applies a confirmation for a different version.
Concurrent starts for one harness coalesce onto at most one action. Calls arriving in the same
in-flight generation share its result even when Hermes finishes before a queued caller would have
entered the serialized lane. Once the mutative POST is attempted, every transport failure or
non-authoritative response is ambiguous, including an oversized, malformed, or non-UTF-8 body.
Only Hermes' validated pinned refusal shape is a definite rejection. An ambiguous start returns
`202 state=ambiguous` and directs the client to poll `status`; it is never retried blindly.
Before the POST, Gateway snapshots Hermes' latest durable receipt. A timed-out start can become
terminal only after that fingerprint changes; timestamps are not a substitute because an older
success receipt may still be recent.

Docker, Nix/NixOS, APT, and externally managed installs report `canApply: false` with bounded generic
guidance. Starting one returns `409` without invoking an updater.

`success` is emitted only from Hermes' durable update receipt. Process exit, reconnect, liveness,
and a changed version are not success evidence. The status route can recover the latest action id
and receipt after Gateway or Hermes Dashboard restart. `partial`, `failed`, and `refused` receipts
remain distinct durable facts (`refused` projects to status `failed`). Pinned Hermes recovers action
ids from a success-only completion marker, so non-success status does not invent one: a changed
pre/post receipt fingerprint establishes newer harness state and any stale success-marker id is
discarded. An unchanged receipt or conflicting success identity stays `unknown` and directs the
client to refresh rather than retry.

One upstream limitation remains: a foreign out-of-band update can finish after Gateway's snapshot
and replace the latest non-success receipt before the requested action finishes. With no receipt
action id Hermes cannot distinguish those runs. Gateway therefore reports that changed receipt only
as the latest durable harness outcome and omits an action id; exact non-success attribution requires
Hermes to add durable per-action identity.

Gateway advertises this capability only after authenticated probes validate the pinned check,
action-status, and durable-receipt read shapes plus a side-effect-free method probe of the update
action route. The probe requires HTTP 405 and an `Allow` header containing `POST`
case-insensitively; a GET-only route is unsupported. An older or malformed Hermes build omits the
capability. Every upstream JSON response used by this extension is byte-bounded before parsing.

The extension is deliberately not an action-log proxy. Responses never include raw log lines, full
receipts, paths, commands, process ids, environment values, commit authors, or upstream error text.
