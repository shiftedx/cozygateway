# R1: rooms between runtime bots on a gateway with no Hermes endpoint

Branch `codex/r1-rooms-without-hermes`, cut from `origin/main` at `bbbd5fb`. Node 24
(`/opt/homebrew/opt/node@24/bin`). No merge, tag, release or deploy; no subagents.

## Root cause

`POST /bots/groups` answered `503 backend_unavailable "cross-endpoint groups are not supported"` on
a gateway configured with zero `hermesEndpoints`, and the cause was two layers deep.

1. `packages/gateway/src/server.ts:611` picks the control surface: a single un-namespaced Hermes
   endpoint gives a `HermesBridge`, anything else gives `FederatedBotControlSurface`. Zero endpoints
   is "anything else", so a Hermes-free gateway landed on the federated surface with zero members.
2. `packages/gateway/src/hermes-bridge/federation.ts:133-136` (pre-fix) refused every group method
   unconditionally: `createGroup`, `deleteGroup`, `groupDetail` and `sendGroupMessage` all threw
   `BackendUnavailable("cross-endpoint groups are not supported")`, and `groups()` answered `[]`.
   That refusal is correct for membership that genuinely spans two Hermes endpoints and wrong for
   the absence of an endpoint.

Underneath those two, a third gate would have kept a room dead even if the route had answered: the
room wiring in the server was conditioned on the surface being a `HermesBridge`, at
`server.ts:649` and `:729` (the room attach-event hooks), `:822` (`setGroupNativeTurns`, the room
turn transport) and `:973` (`setGroupInteractionExpiry`, capability 51's deadline wheel). A
Hermes-free gateway had no room owner to wire them onto, so a room could not have dispatched a
member turn, carried an approval, or expired an interaction. Fixing only the route would have
produced a room that accepts messages and never speaks.

Nothing in `group-rooms.ts` needed Hermes: `GroupRooms` reaches the Dashboard only through the
member callbacks its host supplies, and the bridge's own callbacks already short-circuit every one
of them for a runtime bot (`bridge.ts:493-524`). The room protocol was ready; it had no host.

## What changed

- `packages/gateway/src/hermes-bridge/group-rooms.ts`: new `GatewayRoomHost`, the room owner for a
  gateway with no Hermes endpoint. It owns the same `GroupRooms` a bridge owns and supplies the
  Hermes-free half of the bridge's member callbacks: membership, existence and display identity are
  answered from the gateway's own live runtime bot set and the roster overlay, with no RPC. It
  exposes the same nine methods the server and the surface already call on a bridge.
- `packages/gateway/src/hermes-bridge/federation.ts`: the federated surface takes an optional room
  host and delegates the group methods to it. The cross-endpoint refusal is kept, unchanged, for
  the case it was written for: a surface with two or more members has no host and still throws.
- `packages/gateway/src/server.ts`: builds the host when `bridgeMembers.length === 0`, hands it to
  the federated surface, and replaces the four `bridge instanceof HermesBridge` room gates with one
  `rooms` owner that is the bridge or the host. Closed on shutdown beside the bridges.
- `contract/ext-bots-v1.md`: one clarifying sentence on the capability 46 note. No row was
  allocated and none was needed: no route, frame, schema or capability version moved. Row 70 is
  still free.
- `CHANGELOG.md`: an entry under the existing `Unreleased` heading. No version field touched.

## RED then GREEN

Test seam 1, the route and the room turn fan-out end to end, on a real `startGateway` with no
`hermesEndpoints`: `packages/gateway/test/cozyagents-only-gateway.test.ts`. Two runtime bots created
over `POST /bots`, one paired runner, and one real `/attach/v1` socket per bot dialed with the
credential the runner was handed in its `create_runtime` command.

RED (commit `600d49b`, before the fix):

```
 ✓ ... 5 passed
 × creates a room of two runtime bots and fans a member turn out to both
   → expected 503 to be 201
 Tests  1 failed | 5 passed (6)
```

GREEN, same file, now 7 tests including the capability 51 room approval:

```
 ✓ test/cozyagents-only-gateway.test.ts (7 tests) 282ms
 Tests  7 passed (7)
```

The two new cases assert, on a gateway with zero Hermes endpoints: create 201, list, detail, a
member turn dispatched to BOTH peers on their own `group:launch:<member>` threads, both replies in
the transcript, one room-scoped Task per member turn through `GET /bots/groups/:name/tasks`, and a
room turn's approval landing in the ordinary inbox, badged on the room as `pendingInteractions`, and
resolved through the unchanged `POST /bots/sage/approvals/:id/approve` with the `resolve_approval`
command reaching the peer that asked.

Test seam 2, conformance: `packages/conformance/test/rooms-without-hermes.test.ts`, a gateway with
no `hermesEndpoints` whose members are config-declared runtime bots, answered by the package's own
reference echo peer, with every room body checked against the published schemas
(`BotGroupSchema`, `BotGroupDetailSchema`, `BotGroupMessageSchema`).

RED (source files reverted to `600d49b`, test file unchanged):

```
 ✓ advertises the bots capability and no rooms yet
 × creates, lists and reads a room of two runtime bots, and fans a member turn out to both
   → expected 503 to be 201
 × deletes the room
   → expected 503 to be 204
 Tests  2 failed | 1 passed (3)
```

GREEN:

```
 ✓ test/rooms-without-hermes.test.ts (3 tests) 85ms
 Tests  3 passed (3)
```

Unchanged behaviour, run together with the new work (Kyle's ruling for this run: typecheck plus
focused tests, no full suite):

```
pnpm -r typecheck
  contract Done, relay Done, gateway Done, conformance Done

packages/gateway: vitest run cozyagents-only-gateway bots-rooms-runtime-members
  bots-rooms-interactions bots-group-protocol bots-group-turn federated-hermes-e2e
  attach-v1-federated-health bots-bridge-wiring task-routes durable-tasks config-native-bots
  Test Files  11 passed (11)
  Tests  116 passed (116)

packages/conformance: vitest run rooms-without-hermes reference-gateway reference-gateway-hookless
  Test Files  3 passed (3)
  Tests  74 passed | 20 skipped (94)
```

The 20 skips are the hookless runner's optional stall and approval groups, exactly as on `main`.
`federated-hermes-e2e` and `attach-v1-federated-health` are the mixed and multi-endpoint cases; a
Hermes-only room is covered by `bots-rooms-runtime-members` and `bots-rooms-interactions`, both of
which run a room against a real fake Hermes. All unchanged.

The typecheck needs `pnpm --filter cozygateway-contract build`, `--filter cozygateway-relay build`
and `--filter cozygateway build` first in a fresh worktree: `packages/gateway` imports
`cozygateway-relay`'s types and `packages/conformance` imports `cozygateway`'s, and both resolve
through `dist`. That is a pre-existing property of a cold checkout, not a change here.

## Files

- `packages/gateway/src/hermes-bridge/group-rooms.ts` (new `GatewayRoomHost`)
- `packages/gateway/src/hermes-bridge/federation.ts`
- `packages/gateway/src/server.ts`
- `packages/gateway/test/cozyagents-only-gateway.test.ts`
- `packages/conformance/test/rooms-without-hermes.test.ts` (new)
- `packages/conformance/test/reference-attach.ts` (exports `AttachPeer`, one word)
- `contract/ext-bots-v1.md`, `CHANGELOG.md`

## Self review and concerns

1. A gateway with TWO OR MORE Hermes endpoints still refuses every room, including one whose
   members all live on a single endpoint. That is the pre-existing behaviour and the brief holds
   the mixed and Hermes-only cases unchanged, so it stays. It is a real gap for a federated
   operator: `#route` already knows which endpoint owns a name, so a single-endpoint room could be
   delegated to that member's bridge and only a genuinely spanning room refused. Worth its own
   packet; it needs a rule for which bridge holds a room whose membership later changes, and that
   is a design decision, not a one-line fix.

2. The room host is created only when there are zero Hermes endpoints, so nothing about a gateway
   that has one can reach it. That keeps the blast radius at exactly the configuration the finding
   names, and it is why `bots-bridge-wiring`, `federated-hermes-e2e` and both room suites pass
   untouched.

3. The Hermes-free host answers `memberExists` from the runtime set alone. On a gateway with an
   endpoint the bridge answers `true` when it cannot reach Hermes, deliberately, because an
   unreachable Dashboard has taught it nothing. Here there is no Dashboard to be unreachable: a
   name that is not a runtime bot is not a bot on this gateway, so `false` is the honest answer and
   a member deleted from the app is skipped with a note rather than burning a turn per round.

4. I tried the larger reading of "conformance covers the no-endpoint case" first, a third runner of
   the whole portable suite against a Hermes-free reference gateway, and reverted it. It fails 15
   cases for reasons that have nothing to do with rooms: the core `/threads` surface answers 503
   because a thread needs a Hermes-profile agent, and the suite's `/health` case requires
   `bridges.hermes` to be an object where a Hermes-free gateway answers the string `"absent"`. That
   is a separate finding about what the portable suite assumes, and it deserves a packet rather
   than being smuggled in here. The focused conformance file above covers the room contract on that
   configuration; the portable suite's own Hermes assumption is untouched and unclaimed.

5. Not verified against a live model endpoint. `.121` remains unavailable per the wave 2 rulings;
   every peer above is a deterministic attach socket. Nothing here is described as a deployment
   pass.
