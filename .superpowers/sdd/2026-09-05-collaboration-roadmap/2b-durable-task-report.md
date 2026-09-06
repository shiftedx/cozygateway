# 2b durable Task report

Status: IN_PROGRESS. Base 54dc248 (gateway main 766b04c plus reviewed capability 63 dependency).
Row 64 reserved; not advertised until the vertical slice qualifies. No merge or deployment.

## Decisions grounded in source

- ADR 0004's closed reason list contains 45 unique reasons. Lead confirmed enumeration is authoritative and the earlier 46 count is clerical. No additional reason invented.
- `native-data-plane.ts` intentionally delivered late replies and rewrote a prior non-cancelled seal to completed (issue 193), conflicting with attach-v1 and ADR 0004. Lead ruled to retain durable late reply delivery under source/cancel guards, but preserve first Run/Task/row23 terminal outcome and clear only the exact stale pointer. Journal recovery must reapply its first authoritative terminal.

## Evidence so far

Node 24 explicitly selected with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
`pnpm install --frozen-lockfile --offline` succeeded. Existing dist CLI warnings are expected before bootstrap build.

RED: `pnpm --filter cozygateway-contract exec vitest run test/tasks.test.ts`: 2 failed because Task schemas were absent. The earlier numeric 46 assertion was corrected per the lead's enumeration ruling, not counted as functional evidence.
GREEN: same command: 1 file passed, 2 tests passed. Closes schemas' ten states, 45 reasons, actors and references only; does not establish ingress lifecycle correctness.

An initial workspace build needs the lead's serialized gate slot before gateway focused tests, because this fresh worktree has no dependency dist artifacts. Hosted CI billing unavailable. Live model .121 unavailable. Deterministic local evidence only.

## Remaining

Durable storage, production direct/room ingress, commands/fences, waits, reconciliation, notification, public routes/portable conformance, integrated gates and independent review remain. No lifecycle or release completeness claim.

## First-terminal correction

Lead granted one bootstrap heavy slot: `pnpm -r build` passed contract, relay, gateway, conformance. Slot released immediately.

RED: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts`: 7 tests, 4 failed and 3 passed. Late final commits changed timed_out/failed/interrupted to completed; storage also allowed this rewrite.
GREEN: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts test/native-bot-data-plane.test.ts test/attach-boot-replay.test.ts`: 3 files, 67 passed. Includes late final/interim duplicate delivery, newer active-turn pointer isolation, user-cancel suppression, process reconstruction and journal-before-apply reply recovery. Existing issue 193 assertions now require delivered replies with the original timeout/interruption outcome.

Only production callers of `recordNativeBotTerminal` are native data plane normal settlement and late reply handling. Storage now retains the first outcome. Late replies retain delivery but do not replace it or emit misleading completed row23 state. This is a prerequisite correction, not Task implementation completion.

## Interim commits at the durable journal boundary

RED: task-terminal-immutability focused run, 8 tests: 1 failed and 7 passed. An interim `continues:true` commit incorrectly caused the next verification event to return `ignored_terminal`.
GREEN: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts test/attach-v1-storage.test.ts`, 2 files, 31 passed. The added test closes and reopens SQLite after the interim commit, replays it as a duplicate, admits subsequent Verification and final commit, then refuses a later conflicting terminal. Storage now seals only final commits.
