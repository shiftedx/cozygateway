# 3b policy contract independent review

Status: PASS

Reviewed range: `8260d7b..dab850b`. Both `8260d7b` and `766b04c` resolve as the merge base
of `dab850b`; the policy branch has not yet been rebased onto current `origin/main`.
The lead will perform that mechanical rebase before the full gate. The Windows-only delta on
`766b04c` is outside this frozen policy review and is not classified as a policy deletion.

## Findings

No important regression found in the reviewed range.

- `packages/contract/src/ext-bots.ts:1069-1103` adds the optional `repair` field to
  `BotMcpServerSchema`, with exactly the closed literals `approve_once` and `auto_refresh`.
  `packages/contract/src/ext-bots.ts:1195-1204` keeps `BotProfilePatch` limited to server
  names through `enabledMcpServers`, with no policy write shape.
- `packages/contract/src/ext-bots.ts:2655-2679`, `contract/ext-bots-v1.md:31-40`,
  `contract/ext-bots-v1.md:105`, and `contract/attach-v1.md:248-258` consistently declare
  capability 63, its discovery scalar, read-only ownership, emission rule, absence semantics,
  known CozyAgents effective `approve_once`, Hermes and older-peer omission, and fail-closed
  unknown values. They correctly say `approve_once` requires approval and grants no permission.
- The actual lane supports the documentation: ingress validates the full client frame before
  dispatch at `packages/gateway/src/adapters/attach/ingress-v1.ts:237-242`, advertises the scalar
  at `:290-297`, and sends `config_result` to the config surface at `:340-346`. The config
  surface validates `profile.read` with `BotProfileSchema` at
  `packages/gateway/src/hermes-bridge/bot-config.ts:153-162`, issues only `{}` for the read at
  `:247-249`, and resolves the peer result without serialization at `:337-345`. Runtime routing
  reaches that surface at `packages/gateway/src/hermes-bridge/native-data-plane.ts:277-286`.
- This is accurately described as live request/reply. The changed test proves no durable command
  or event cursor advances and re-reads a changed peer answer rather than inventing storage or
  rebroadcast. The existing source trace contains no newly added repair executor or policy mutator.
- The portable fixture and tests cover both values, absence, rejected values, the no-write patch
  shape, discovery floor, and real websocket refusal. `git diff --check 8260d7b..dab850b` is clean.

## Independent focused evidence

Run under Node `v24.19.0` with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`:

| Command | Result |
| --- | --- |
| `pnpm --filter cozygateway-contract exec vitest run test/ext-bots.test.ts` | 1 file, 84 passed |
| `pnpm --filter cozygateway-conformance exec vitest run test/bot-mcp-repair-policy-fixture.test.ts` | 1 file, 5 passed |
| `pnpm --filter cozygateway exec vitest run test/bots-config-lane.test.ts` | 1 file, 27 passed |

The gateway probe included the unknown `auto_reconnect` value. It logged the expected content-free
schema refusal and observed socket close `1008` with `attach-v1 invalid config_result frame`.

## Gate pending

The full Node 24 build, typecheck, and full test suite remain pending the lead's serialized
foreground gate after rebase onto `766b04c`. Hosted checks and live model qualification remain
unavailable, as recorded by the packet report. No full suite or heavy build was run for this review.
