> Current status: local qualification PASS on ced0ccf, rebased onto main766b04c with identical reviewed patches. Independent review PASSdab850b. Node24 build/typecheck/full suite passed: contract181, relay161, gateway1378+2skip, conformance76+17skip,1796passed total and19skipped, zero failures. Earlier phase evidence below is historical. Harness emission consumer remains a separate required follow-up.

# 3b-policy-contract report

Packet: contract the read-only MCP repair policy projection.
Worktree branch: `codex/3b-policy-contract`, cut from `8260d7b`.
Phase-one head: `e228303` feat(contract): declare the per-server MCP repair policy (capability 63)
Phase-one push: `origin/codex/3b-policy-contract`. No merge, no tag, no deploy.
Model: Claude Opus 5 (`claude-opus-5`), Claude Code CLI.
Node: `/opt/homebrew/opt/node@24/bin`, `v24.19.0`, matching the declared `>=24` engine.

## Row allocation

Row 63 confirmed FREE before implementing, on two sources:

- Base `8260d7b`: `contract/ext-bots-v1.md` table ends at row 62; `BOTS_CAPABILITY_VERSION = 62`.
- Current `origin/main` (`766b04c`, fetched at implementation time): `grep -c '^| 63 '` on
  `contract/ext-bots-v1.md` is `0`, and `BOTS_CAPABILITY_VERSION = 62` there too.

Row 63 allocated. `766b04c` is a Windows installer commit that touches no contract file, so the base
pin at `8260d7b` costs nothing on this surface.

## The flow, traced end to end before writing code

The projection rides the capability-48 `bot_config` request/reply lane. It is a LIVE lane. There is
no storage, no rebroadcast and no cold read on this path, which is different from capability 62's
approval block, and the report says so rather than claiming a durability the code does not have.

1. Peer answers `config_result` on the socket.
2. `packages/gateway/src/adapters/attach/ingress-v1.ts:237` validates the WHOLE frame with
   `check(AttachV1ClientFrameSchema, decoded)`. A failure is `#refuse`: one bounded content-free log
   line naming the schema violation, then `close(1008, "attach-v1 invalid config_result frame")`.
3. `ingress-v1.ts:340` requires a negotiated config lane, then hands the frame to `onConfigResult`.
4. `packages/gateway/src/hermes-bridge/bot-config.ts:342` correlates the pending request and
   re-checks the body against the operation's own schema (`validResult`, line 155:
   `profile.read` is `Value.Check(BotProfileSchema, result)`). A mismatch is
   `BackendUnavailable("bot config returned an invalid reply")`.
5. `AttachConfigSurface.botProfile` (line 247) returns the peer's object AS SENT. No field-by-field
   re-serialization anywhere on this path, so an added member survives by construction.
6. `NativeBotDataPlane` routes `botProfile` to the config surface for a runtime bot
   (`native-data-plane.ts:278`, `CONFIG_LANE`), keeping the 409 for a peer with no lane.
7. `packages/gateway/src/hermes-bridge/routes.ts:961` answers `GET /bots/:name/profile` with
   `c.json(await bots.botProfile(name))`, again verbatim.
8. The Hermes-backed arm is separate and untouched: `hermes-bridge/profile.ts:225 mcpServer()`
   builds rows explicitly from `profiles.describe` and `mcp.catalog`, and emits no policy, which is
   correct because Hermes has no such setting.

What this trace found, and what makes the packet necessary: `BotMcpServerSchema` is an OPEN
TypeBox object and nothing on the path cleans unknown members. A peer could already put
`repair: "anything"` on a row today and it would reach a client unvalidated. That is exactly the
"open objects are not a substitute for declaring and versioning the field" case the brief names,
and it is the red below.

## What was built

`packages/contract/src/ext-bots.ts`

- `BotMcpRepairPolicySchema`: closed union of `approve_once` and `auto_refresh`, plus the
  `BotMcpRepairPolicy` type. Same two names capability 62 already uses for
  `BotApprovalRepair.policy`, so one setting has one vocabulary.
- `BotMcpServerSchema.repair`: `Type.Optional(BotMcpRepairPolicySchema)`, with the read-only rule
  and the projection/unknown absence rule in the schema comment.
- `BOTS_CAPABILITY_VERSION` 62 to 63, with its history entry stating read-only, no storage, no
  execution, the projection/unknown absence rule, the unknown-value rule, and the emission gating
  rule.

No gateway source change was needed or made. The relay is the whole behaviour, and the schema is
where the validation belongs. No repair is executed and no policy is mutated anywhere in the
gateway, which the brief requires.

## Post-phase semantic correction

The phase-one wording incorrectly required a harness to omit `repair` whenever the operator had
not written an explicit policy key, and treated `approve_once` as a permission claim. That rule is
removed. Wire absence means only that the policy was not projected or is unknown, so the gateway
must preserve absence for Hermes, old peers, and any peer that does not project a value. CozyAgents
has an effective operator default of `approve_once`; after the gateway advertises capability 63, a
known CozyAgents peer may project that effective value even when its explicit config key is absent.
`approve_once` requires an approval for each reconnect and grants no repair permission. This changes
no request shape, no gateway write authority, and no live request/reply or non-durable lane facts.

Focused validation after the correction, with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`:

| Command | Result |
| --- | --- |
| `pnpm --filter cozygateway-contract exec vitest run test/ext-bots.test.ts` | `1 file, 84 passed (84)` |
| `pnpm --filter cozygateway-conformance exec vitest run test/bot-mcp-repair-policy-fixture.test.ts` | `1 file, 5 passed (5)` |
| `pnpm --filter cozygateway exec vitest run test/bots-config-lane.test.ts` | `1 file, 27 passed (27)` |

Documentation, all of it versioned rather than implied:

- `contract/ext-bots-v1.md`: header status to 63, the discovery block scalar to 63, row 63 in the
  table's voice, the `GET /bots/:name/profile` and `PATCH /bots/:name/profile` route rows, and the
  `BotProfile` entry in the Resources section.
- `contract/attach-v1.md`: a paragraph in the Bot config lane section giving the wire rule and
  saying explicitly why it differs from the untyped `repair` on an `approval` event.
- `CHANGELOG.md`: Unreleased entry.
- `packages/conformance/README.md`: what the new client fixture pins and why it is a fixture.

## Tests

Commands were run from the worktree with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.

### RED, observed before implementing

`pnpm --filter cozygateway-contract exec vitest run test/ext-bots.test.ts`
=> `Tests  3 failed | 81 passed (84)`

- `profile > carries the per-server MCP repair policy, closed and optional (capability 63)`:
  `"auto_reconnect": expected true to be false`. The open object accepted a made-up policy.
- `profile > leaves the repair policy absent rather than defaulting it (capability 63)`:
  `expected true to be false`. A whole profile carrying a bad policy validated.
- `capability advertisement > is a vendor-scoped id with an integer version`: `expected 62 to be 63`.

`pnpm --filter cozygateway exec vitest run test/bots-config-lane.test.ts`
=> `Tests  1 failed | 26 passed (27)`

- `attach-v1 config lane > refuses an unknown repair policy: the frame is invalid and the read is
  unavailable`: `Test timed out in 5000ms`. The socket was never closed, because nothing refused
  `repair: "auto_reconnect"` on the wire.

`pnpm --filter cozygateway-conformance exec vitest run test/bot-mcp-repair-policy-fixture.test.ts`,
run against the pre-change contract build to get honest red for the fixture that was written after
the schema landed => `Tests  2 failed | 3 passed (5)`

- `pins the capability floor a client gates the policy on`: `expected 62 to be greater than or equal
  to 63`.
- `refuses every value outside the closed pair, rather than passing a string through`:
  `{"name":"github",...,"repair":"auto_reconnect"}: expected true to be false`.

Honest note on what did NOT go red: the three carriage cases (both names, absence, re-read) passed
before the change as well as after, because an open object carries anything. They are pinned so the
carriage cannot regress, but the real red for this packet is the two validation cases and the two
version cases. Manufacturing red for "accepts approve_once" would have been theatre.

### GREEN, after implementing

| Command | Result |
| --- | --- |
| `pnpm --filter cozygateway-contract exec vitest run test/ext-bots.test.ts` | `1 file, 84 passed (84)` |
| `pnpm --filter cozygateway-conformance exec vitest run test/bot-mcp-repair-policy-fixture.test.ts` | `1 file, 5 passed (5)` |
| `pnpm --filter cozygateway exec vitest run test/bots-config-lane.test.ts test/bots-delete-routes.test.ts test/bots-profile.test.ts test/attach-v1-protocol.test.ts` | `4 files, 122 passed (122)` |
| `pnpm --filter cozygateway exec vitest run test/bots-bridge-wiring.test.ts test/attach-v1-ingress.test.ts test/bots-create-blank-slate.test.ts test/chat-execution-e2e.test.ts test/runner-chat-executions.test.ts test/bots-routine-run.test.ts` | `6 files, 97 passed (97)` |
| `pnpm --filter cozygateway-contract test` (whole contract package) | `17 files, 181 passed (181)` |
| `pnpm --filter cozygateway-conformance exec vitest run test/bot-mcp-repair-policy-fixture.test.ts test/harness-update-fixture.test.ts test/harness-workspace-fixture.test.ts test/hermes-session-management-fixture.test.ts` | `4 files, 8 passed (8)` |
| `pnpm -r typecheck` | `exit 0`, contract, relay, gateway and conformance all `Done` |

### GREEN, after semantic correction

The correction changes contract, fixture, and test commentary only. The same focused suites were
rerun under Node 24 after the correction; their exact results appear in the final handoff update.

`pnpm -r typecheck` needed `pnpm --filter cozygateway-contract build`, `pnpm --filter
cozygateway-relay build` and `pnpm --filter cozygateway build` first, because a fresh worktree has
no `dist/` and the workspace packages resolve each other through their published `exports`. Those
are three single-package `tsc` compiles, not the heavy full build, which was left for the lead's
gate slot.

### What the tests actually cover

Contract (`packages/contract/test/ext-bots.test.ts`, three new cases):

- Both names accepted on `BotMcpServerSchema`; a bare row with no policy still accepted.
- Refused: `auto_reconnect`, `Approve_Once`, `""`, `" "`, `null`, `0`, `true`, `["approve_once"]`.
- Absence at the `BotProfileSchema` level, and a bad policy failing the whole profile read.
- No write surface: `enabledMcpServers: ["github"]` valid, `enabledMcpServers: [{name, repair}]`
  refused.
- The scalar is 63.

Gateway (`packages/gateway/test/bots-config-lane.test.ts`, four new cases, REAL websocket, real
`AttachV1Ingress`, real `AttachConfigSurface`, real `NativeBotDataPlane`):

- Each of the two names travels from a peer's `profile.read` reply through ingest and the data
  plane to `plane.surface().botProfile("sage")`, compared with `toEqual` against the whole profile,
  and the outgoing request input is asserted to be `{}` so the read is provably not a write.
- A row the peer answered without a policy has no `repair` key at all after the trip.
- The lane keeps no copy: a second peer answering a different policy is read as the NEW value, and
  `storage.attachCommandCursor` and `storage.attachEventCursor` are both still `0`, so nothing on
  this path became a durable command or event.
- `repair: "auto_reconnect"` closes the socket with `1008 attach-v1 invalid config_result frame`
  and the read fails `BackendUnavailable("bot config reply timed out")`, mirroring the existing
  pre-P3b providers-row case exactly.

Conformance (`packages/conformance/test/bot-mcp-repair-policy-fixture.test.ts` and
`test/fixtures/bot-mcp-repair-policy-v1.json`, five new cases): a portable client fixture in the
same style as `harness-workspace-v1.json`. It pins the capability floor as `>= 63` rather than
equality (so a later row does not invalidate it), one real profile read carrying both names plus an
unpolicied row, the four values a decoder must refuse, the accepted and refused patch bodies, and a
guard that the fixture carries no credential, token or host path.

## Files changed

```
CHANGELOG.md
contract/attach-v1.md
contract/ext-bots-v1.md
packages/conformance/README.md
packages/conformance/test/bot-mcp-repair-policy-fixture.test.ts   (new)
packages/conformance/test/fixtures/bot-mcp-repair-policy-v1.json  (new)
packages/contract/src/ext-bots.ts
packages/contract/test/ext-bots.test.ts
packages/gateway/test/bots-config-lane.test.ts
packages/gateway/test/bots-delete-routes.test.ts
```

## THE EXACT EMISSION GATING RULE FOR THE HARNESS CONSUMER

This is the deliverable the later harness packet needs. No harness change was made here, and none
should be inferred from this packet.

1. GATE ON THE SCALAR. The gateway sends its bots capability on `hello_ack.extensions`
   (`ingress-v1.ts:296`, `{ "com.cozylabs.bots": <int> }`) and on `GatewayInfo.capabilities` at
   `/health`. Emit `repair` only when that integer is `>= 63`. Below 63, OMIT THE KEY. Do not send
   `null`, do not send `""`, do not send the key with any placeholder.
2. TWO VALUES, NOTHING ELSE. `"approve_once"` or `"auto_refresh"`. Any third value, including a
   future policy name, makes the whole `config_result` frame invalid: the gateway logs one bounded
   content-free line and CLOSES THE ATTACH SOCKET with `1008 attach-v1 invalid config_result
   frame`, and the in-flight read then fails at the lane timeout as `503 backend_unavailable`. A new
   policy name requires a new contract row and a scalar bump BEFORE any harness emits it. This is
   the same fail-closed rule the lane already applies to a malformed providers row; it is not new
   behaviour invented for this field.
3. PROJECT THE EFFECTIVE POLICY ONLY WHEN KNOWN. A harness emits `repair` only after the gateway
   advertises 63, and only with one of the two names. A known CozyAgents harness may project its
   effective `approve_once` default even when the operator omitted that config key: it means a
   reconnect still requires approval, not that it is permitted. Hermes, old peers, and an unknown
   projection omit the key. The gateway itself never fills in an absent field.
4. PER ROW, NOT PER PROFILE. The key lives on each `BotProfile.mcpServers` entry. There is no
   profile-level policy field and adding one would be a different row.
5. READ ONLY, ONE DIRECTION. The key appears on `profile.read` results only. The gateway never sends
   a policy: `profile.write` input is `BotProfilePatch`, whose `enabledMcpServers` is a list of
   NAMES. A harness must not read a policy out of a `profile.write` input and must not treat any
   gateway call as permission to change one.
6. NOTHING ELSE CHANGES. No new operation, no new negotiated capability string (still `bot_config`
   in `hello.capabilities`), no new route. A harness below 63 and a harness at 63 that emits nothing
   are byte identical to their pre-63 selves on this lane.

## Self-review findings

- `BotCatalog.mcpServers` (`GET /bots/catalog`) deliberately does NOT gain the field. That route is
  the LAUNCH PROFILE's menu, not one bot's per-server state, and the same name on both would invite
  a client to render a launch-profile policy as a bot's policy. Named here so the omission reads as
  a decision rather than an oversight.
- The Hermes-backed profile arm was checked and left alone: `hermes-bridge/profile.ts` builds
  `mcpServers` rows explicitly and has no policy to project, which is the correct "absent for a
  Hermes bot" outcome with zero code.
- `BotProfilePatchSchema` is an open TypeBox object, so an unrecognised TOP-LEVEL key in a PATCH
  body still rides through to the peer. That is pre-existing for every field on that schema, is not
  introduced or worsened by row 63, and row 63 adds no named write field, so the gateway still never
  asks a peer to change a policy. Flagged, not fixed: closing that object is a separate change with
  its own compatibility question.
- The unknown-value behaviour (close the socket) intentionally DIFFERS from capability 62's
  drop-the-block rule. 62's `repair` sits on the unbounded `approval` event, where losing a person's
  permission decision over one presentation block would be worse than tolerating it. This field sits
  inside a published schema on a validated request/reply lane whose existing, deliberately pinned
  convention is to refuse the frame. Softening it would need a wire-local permissive profile variant
  plus a sanitizer, which is more code than the row needs and would weaken the guarantee that a
  client never renders an unvalidated permission string. If the lead prefers the softer rule, say so
  and it is a contained follow-up.
- No `ponytail:` cut corners were taken. Nothing was scaffolded for later.

## Blockers and unavailable checks

- HEAVY GATE NOT RUN. Per this phase's instruction the heavy slot belongs to CozyChat, so no full
  build, no full `pnpm test`, no bundle and no container tests were run. Focused suites only.
- `http://192.168.99.121:1234/v1` is unavailable. No live model rollover or performance
  qualification was attempted. Record as UNKNOWN, not passed.
- Hosted GitHub Actions billing is unresolved. Hosted checks are UNAVAILABLE, not passed.
- No CozyChat or simulator work is in scope for this packet, so no simulator name or build id.
- This report lives in a `.gitignore`d directory (`.gitignore:12` excludes `.superpowers/`), so it
  is present in the worktree but not in commit `e228303`. That matches the rule that the lead
  imports reports into the canonical ledger.

## Remaining gate commands for the lead's slot

Run from the root of this packet's worktree (`worktrees/3b-policy-contract`) with
`PATH=/opt/homebrew/opt/node@24/bin:$PATH`, in the foreground, one at a time:

```
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm install` and the three single-package builds have already been done in this worktree, so
`pnpm build` starts from a warm tree. Expected deltas against the pre-packet counts: the contract
package gains 3 cases in `test/ext-bots.test.ts`, the conformance package gains 5 in a new file,
and the gateway package gains 4 in `test/bots-config-lane.test.ts`.
