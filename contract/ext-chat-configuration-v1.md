# Per-chat configuration extension v1

Capability id: `com.cozylabs.chat-configuration`  
Version: `1`

This paired-device extension stores optional execution choices on one Bot Mode conversation. It is
separate from harness settings: provider credentials and provider discovery remain owned by the
harness adapter. Computer, project, and branch ids are opaque runner-owned references; no
credential, endpoint, or runner diagnostic is exposed. An adapter may provide a safe display path
as presentation metadata, but it is never an execution argument.

## Values

- `ChatWorkspaceSelection` is `{ computerId, projectId, mode: "direct" | "worktree", branch? }`.
- `ChatModelSelection` is `{ providerId, modelId, effort? }`.
- `ChatSessionConfiguration` is keyed by the gateway-native `sessionId` and may carry null
  workspace and model overrides.

`GET /bots/:name/chat/configuration` returns a snapshot for the selected conversation. It includes
that configuration, `defaults.workspace` (the bot's last successfully prepared workspace for
new-chat prefilling), safe computer rows, `canChangeWorkspace`, `canChangeModel`, and an optional
bounded `unavailableReason`.

`PUT /bots/:name/chat/configuration` takes `ChatSessionConfigurationPatch`. Its `sessionId` must
name the currently selected session. Omitted fields are unchanged and `null` clears one override.
Workspace changes are refused after that session's first accepted turn; model changes affect only
future idle turns. A missing configuration has no effect on ordinary immediate sending.

The gateway exposes `GET /bots/:name/chat/computers`,
`GET /bots/:name/chat/projects?computerId=…` (returning `{projects}`), and
`GET /bots/:name/chat/branches?computerId=…&projectId=…` (returning `{branches}`). The global
capability advertises API support. Each bot's snapshot separately reports whether its adapter or
an online compatible runner can provide configuration; a global capability is not proof that a
particular bot supports the feature.

An attached adapter can resolve projects on its own computer. A compatible process runner can
launch a separate chat execution on a selected computer. That execution has an independent attach
identity, private state directory, process lifecycle, and source-bot/session binding. Its replies
remain in the source bot's conversation. It is never added to the bot roster, and it cannot send
events for a room or another chat. A missing override preserves the original bot execution path.

Direct mode uses a project's current branch, including a dirty working tree; it never checks out
another branch. Worktree mode creates an independent checkout from the selected source branch.
Project ids are resolved only against the computer's configured registry. See
`docs/operators/chat-workspaces-and-providers.md` for registration and harness prerequisites.
