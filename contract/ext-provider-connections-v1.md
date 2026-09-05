# Provider connections extension v1

Capability id: `com.cozylabs.provider-connections`, version `1`.

Settings presents a central Providers & Models destination. Each connection belongs to a harness
configuration scope; the actual harness owns its credentials and performs discovery. Chat pickers
consume the resulting model catalog and never edit provider credentials.

Paired-device routes are available under both `/bots/:name/provider-connections` and
`/gateway/harnesses/:harnessId/scopes/:scopeId/provider-connections`:

| Method | Suffix | Behavior |
| --- | --- | --- |
| GET | none | Return `{ connections: [...] }` with safe metadata |
| POST | none | Save a new named OpenAI-compatible connection |
| PUT | `/:id` | Update that connection |
| POST | `/:id/test` | Test `/models` from the harness computer and update status/catalog |
| DELETE | `/:id` | Remove that connection |

Save input is `{ id?, name, baseUrl, apiKey?, manualModels? }`. Omit `apiKey` to retain a saved key;
use `null` to clear it. A connection id is `custom-<uuid>`. Safe output includes `hasApiKey`,
discovered `models`, `manualModels`, and `status` (`unchecked`, `connected`, or `unreachable`). Keys
are never returned. A failed discovery preserves manual model selection and reports the failure.

The independent attach capability is `provider_connections`. Its operations are
`providers.connections.list`, `.save`, `.test`, `.remove`, `.transfer`, and `.import`. Save/import
frames contain a one-time `handoffId`, never credentials. The paired HTTP input limit is 32 KiB.
The gateway stages credential input in memory for up to 30 seconds and binds consumption to one
authenticated attach identity; it never stores the input in its database or durable event stream.

For a custom provider in a separate chat execution, the source harness stages its private
connection through authenticated `POST /attach/v1/provider-transfers/:executionId`. The gateway
checks source-bot/session ownership and returns a one-time handoff. Only the execution's attach
identity can consume `GET /attach/v1/provider-handoffs/:handoffId`; consumption removes it. The
target imports the original provider id and prepares its session before a turn can be dispatched.
No source provider key is included in runner commands or execution inventory.

Provider defaults belong to the bot. A chat override is only `{ providerId, modelId, effort? }` and
applies to that chat's future turns. Reset does not change the bot default or another chat.
