# Chat workspaces and providers

Deploy matching CozyGateway, CozyAgents runner/service, Hermes attach plugin, and CozyChat changes
before expecting every new-chat control to be available. Older peers continue their ordinary chat
path; they do not gain workspace support from the gateway's global API capability alone.

## App navigation

- **Settings → Providers & Models**: choose the harness/bot scope, add an OpenAI-compatible base
  URL and optional key, save, and test to discover models. Manual model ids support servers without
  a usable `/models` catalog. Use an address reachable from the bot's computer; `localhost` means
  that computer, not the phone.
- **Bot settings → Model**: choose the bot's default provider and model.
- **Chat → Model**: quickly select a configured model for this chat, or use the bot default.
- **New/reset chat**: choose a computer, project, direct/worktree mode, and branch. Last successful
  workspace choices prefill future chats. Leaving an unconfigured chat unchanged sends normally.

## Computers and projects

A registered process runner advertises `chat_execution: 1`. Its project registry is explicit and
local to that computer; clients send opaque ids, not filesystem paths. Configure the runner's
environment with a JSON array like this (replace the example values with registered local values):

```text
COZYRUNNER_CHAT_PROJECTS_JSON=[{"computerId":"registered-runner-id","id":"my-project","name":"My project","path":"/absolute/project/path"}]
```

`computerId` must match the runner id assigned by the gateway. `id` must be unique in that runner's
registry. An optional `displayPath` is presentation text only. Direct mode accepts non-Git folders
and dirty repositories; its branch is the current branch. Worktree mode requires a repository and
creates a separate branch/checkout from the selected source branch. Neither mode changes another
chat's configuration or relocates the source bot. Created worktrees contain user work and are not
automatically force-deleted when a chat is removed.

For a bot's already attached CozyAgents computer, `COZYAGENTS_CHAT_COMPUTER_ID` and
`COZYAGENTS_CHAT_COMPUTER_NAME` name the computer. `COZYAGENTS_CHAT_PROJECTS_JSON` accepts
`[{"id":"my-project","name":"My project","path":"/absolute/project/path"}]`; the existing bot
workspace remains its default. The equivalent Hermes plugin variables are
`HERMES_CHAT_COMPUTER_ID`, `HERMES_CHAT_COMPUTER_NAME`, and `HERMES_CHAT_PROJECTS_JSON`; Hermes
registry rows use `computerId`, `projectId`, `root`, and an optional `name`.

## Separate Hermes processes

The process runner advertises Hermes only when an interpreter and the updated plugin bootstrap
are explicitly configured:

```text
COZYRUNNER_HERMES_EXECUTOR_JSON=["/absolute/python","/absolute/cozygateway/integrations/attach-plugin/cozygateway/chat_execution.py"]
```

Both paths must exist. The runner's PATH must resolve the installed `hermes` CLI. The bootstrap
executes the public `hermes gateway run --force` command in an isolated `HERMES_HOME` beside the
execution spec. It uses the runner-prepared project/worktree, the source SOUL and supported profile
settings, and the updated attach plugin. It does not relocate or reuse the original Hermes
process. Source skill bundles and MCP server installation/credentials are not copied across
computers; those tools must be installed/configured on the destination independently.

## Lifecycle and credentials

Executions live under the runner home's `executions/<executionId>` directory. The process
supervisor owns restart, process identity, health port, and parent lease. Readiness requires the
matching process incarnation, attach connection, and prepared chat context. The gateway retains
the source bot as transcript owner and routes only the bound session to that execution. Runner
restart/reconnection replays the same assignment; it does not add another bot to the roster.

Custom-provider keys live in protected harness files. The gateway's private, one-time HTTP
handoff moves a configured custom connection into its bound execution without placing the key in
WebSocket frames, runner specs, model catalogs, or logs. Built-in provider authentication remains
the destination harness/runner's configuration. A source-machine loopback endpoint may therefore
need a network-reachable address before running that chat on another computer.
