# CozyApps v1

`com.cozylabs.cozyapps: 1` is a durable, single-user library of safe, native-rendered app trees.
Gateway owns records shared by paired devices. A record has immutable `creatorBot`, user-owned
`name`, revision/timestamps, and a complete `tree`. The closed node catalog is `stack`, `section`,
`text`, `image`, `list`, `keyValue`, and `button`. IDs and action IDs are opaque bounded values.

`GET /cozyapps` returns summaries; `GET /cozyapps/:id` returns one tree; `PATCH /cozyapps/:id`
renames; `PUT /cozyapps/:id/tree` accepts `{expectedRevision,tree}` for an explicit user-triggered
on-device Foundation Models layout regeneration; `DELETE /cozyapps/:id` removes; and `POST /cozyapps/:id/actions` creates an idempotent
creator-bot action. Image sources are HTTPS but clients must use the authenticated
`/cozyapps/:id/nodes/:nodeId/image` proxy. Generated trees have depth <=12, <=200 nodes and
serialized size <=128KiB. A phone may publish a complete final tree through the same validation.

Attach-v1 negotiates the `cozyapps` lane. Plugin-originated upserts can create/update only their
own records. Their logical `appId` is deterministically namespaced by immutable creator identity
before storage, so separate bots may each use friendly ids such as `cowboys`; repeats by one bot
update the same library record. App actions are durable command/event lifecycles; they are not chat messages and do
not inherit chat approval identity. The plugin executes an action in a private app-scoped Hermes
session and reports `cozyapp_action_status` as `completed` or `failed`; it may update the app only
through `cozyapp_upsert`. Gateway bot deletion purges its apps and actions.

## CozyApps 2

`com.cozylabs.cozyapps: 2` is a document-contract version. It adds three durable record kinds
beside the v1 library and changes nothing above. Every v1 route, frame, node and action behavior
is byte identical for a peer or client that does not negotiate the new attach capability and does
not call the new routes; `CozyApp` and `CozyAppAction` gain no member, because the shipped client
decoder refuses an unknown key on both. Cross-referenced as capability row 67 in
`ext-bots-v1.md`.

The bot-side half is gated on a new attach-v1 capability literal, `cozyapps_dashboard`, negotiated
beside the flat `cozyapps` literal. The flat literal carries no version, so a second literal is
how a version is added here, following `memory_management` and `memory_ownership`. Kyle's live
bots run the Hermes cozygateway plugin, which this row does not update: a Hermes peer stays at
cozyapps 1, keeps v1 behavior unchanged, and still gets everything the gateway derives without it.

### Saved editable input value

`GET /cozyapps/:id/values` returns `{values}`. `PUT /cozyapps/:id/values/:valueId` accepts
`{expectedRevision, idempotencyKey, type, value}` and returns the stored
`{appId, valueId, type, value, revision, updatedAt}`. `type` is a product field type only:
`string`, `number`, `boolean`, `date` (epoch milliseconds) or `selection`. Nested JSON, secret
material, permissions and a bot-authored validation language are not representable, and a value
that is not what its declared type admits is `400 invalid_request`. A value carries its OWN
revision, independent of the app tree's. `expectedRevision: 0` means the writer observed no value;
a stale write is `409 conflict` carrying `current`. Replaying the idempotency key that last wrote
a value returns that prior result and writes nothing a second time. THIS IS THE ONLY WRITE PATH: a
saved value is written by the user action, and no attach frame reaches it. A bot READS values,
which ride to it on the action command below.

### Action receipt and current data

`POST /cozyapps/:id/actions` gains optional `appRevision` and `valueRevisions`, the app revision
and the saved value revisions the tap was made against. The request without them, and the `202`
body, are the pre-2 payloads unchanged. `GET /cozyapps/:id/receipts` returns `{receipts}` of
`{id, appId, creatorBot, actionId, status, appRevision?, valueRevisions?, data?, createdAt,
updatedAt}`. `status` is the public four-name lifecycle `queued`, `running`, `completed`,
`failed`, derived from the unchanged durable states: `requested` is `queued`, the internal
handoff state `delivered` is `running`, and `completed` and `failed` are themselves. There is no
parallel table. The gateway derives `queued` when it accepts the action and `running` when the
peer acknowledges the command, so a v1 peer produces both without changing. HTTP ACCEPTANCE AND
MODEL OUTPUT ARE NEVER A COMPLETED ACTION: only the peer's own terminal event settles one.

`data` is the source-attributed current-data snapshot, a map of value reference to
`{source, asOf, value, state}` where `state` is `fresh`, `stale` or `error`. It is written by the
bot over attach and by nothing else.

### The document envelope

`GET /cozyapps/:id/dashboard` returns `{id, revision, owner, creatorBot, documentVersion,
document, data, updatedAt}` or `404` for an app that has none, which is every v1 app.
`PUT /cozyapps/:id/dashboard` accepts `{expectedRevision, documentVersion, document}` for the
user-triggered on-device regeneration, the document twin of `PUT /cozyapps/:id/tree`, and answers
`409 conflict` on a stale revision. It carries no `data`. The envelope's revision is its own.

`document` is `{title, sections}`. A section is `{id, title?, components}`. A component is one
closed kind: `metric`, `text`, `list`, `chart` and `input` carry a semantic `valueRef` and labels,
and `action` carries a declared `actionId`. There is no member for a colour, font, coordinate,
HTML fragment, script, URL scheme, permission or executable tool, and `valueRef` admits no `:` or
`/`, so no URL can occupy it. Bounds are <=12 sections, <=24 components per section, <=100
components, unique ids, and <=32KiB serialized; a bounded string carries no C0/C1 control, Unicode
Format character or lone surrogate. THE GATEWAY VALIDATES STRUCTURE AND BOUNDS AND NEVER
INTERPRETS THE DOCUMENT.

### Attach frames

`cozyapp_dashboard_upsert {appId, documentVersion, document, data?}` publishes the envelope for
the sender's own app; `appId` is namespaced by immutable creator identity exactly as
`cozyapp_upsert` is, so a plugin writes only its own record, and a different creator is refused.
`cozyapp_action_receipt {appId, actionId, actionRequestId, status, data?}` reports `running`,
`completed` or `failed` with the snapshot the peer read; `appId` is the value the
`cozyapp_action` command carried, as on `cozyapp_action_status`. Both require
`cozyapps_dashboard`; a peer without it has them discarded as `capability_not_negotiated` and
stores nothing. The `cozyapp_action` command gains optional `values`, the saved input the person
had chosen, present only for a peer that negotiated the new literal.

Server schedules, notifications and thumbnails are out of scope for this version: the existing
server-owned Bot Routines path stands, and artwork is client-local presentation. Gateway bot
deletion purges the new records with the app.
