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
