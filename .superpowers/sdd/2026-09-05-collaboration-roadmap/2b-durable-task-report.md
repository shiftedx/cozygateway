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
