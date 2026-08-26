# Basic Terminal Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain `cozygateway` open a basic listener configuration and pairing TUI while preserving the current zero-config defaults.

**Architecture:** Add a dependency-free interactive layer to the existing TypeScript CLI and keep persistence in a focused configuration module. Extend the installed runner into a config-watching supervisor, and install a native Windows command shim on the user PATH.

**Tech Stack:** TypeScript, Node.js 24 built-ins, Vitest, Bash installer harness, PowerShell 5.1.

## Global Constraints

- The default listener remains `0.0.0.0:8787`.
- Existing explicit CLI commands retain their behavior.
- No runtime dependency is added.
- Configuration writes preserve unrelated fields and never touch secret environment files.
- Windows PowerShell 5.1 remains supported.

---

### Task 1: CLI configuration unit

**Files:**
- Create: `packages/gateway/src/configure.ts`
- Test: `packages/gateway/test/configure.test.ts`

**Interfaces:**
- Produces: `validateListenerHost(raw: string): string`, `parseListenerPort(raw: string): number`, and `updateListenerConfig(path: string, host: string, port: number): void`.

- [ ] Write tests for valid values, invalid values, atomic persistence, and preservation of unrelated configuration fields.
- [ ] Run `corepack pnpm --filter cozygateway test -- configure.test.ts` and confirm the tests fail because the module is missing.
- [ ] Implement the validators and atomic update with Node filesystem primitives.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Interactive CLI and status

**Files:**
- Modify: `packages/gateway/src/cli.ts`
- Modify: `packages/gateway/test/cli.test.ts`

**Interfaces:**
- `runCli(argv: string[], io?: CliIo): Promise<number>` accepts injectable `write` and `question` operations.
- Plain interactive invocation opens the menu; `status` and `configure` are explicit commands.

- [ ] Add failing tests that drive menu choices, direct configuration, validation retry, pairing dispatch, and status output.
- [ ] Run the focused CLI tests and confirm each new behavior fails for the missing feature.
- [ ] Implement the built-in readline adapter and menu state machine with the smallest required output.
- [ ] Re-run all gateway tests and typecheck.

### Task 3: Installed service reload and Windows command

**Files:**
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/install.ps1`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `scripts/test/windows-bootstrap.test.ps1`

**Interfaces:**
- The generated runner watches its config and respawns only its gateway child after an atomic config replacement.
- Windows installs produce `bin/cozygateway.cmd` and register `bin` in the user PATH idempotently.

- [ ] Add failing installer assertions for the native command, PATH registration, and generated config watcher.
- [ ] Run both installer harnesses and confirm the new assertions fail.
- [ ] Implement the command shim, PATH registration, and supervisor restart loop.
- [ ] Re-run both installer harnesses and confirm they pass.

### Task 4: Bundle and live Windows acceptance

**Files:**
- Modify generated release assets only through `corepack pnpm bundle`.

- [ ] Run `corepack pnpm check` and both installer harnesses.
- [ ] Build the release bundle and update the live managed installation with the verified artifacts.
- [ ] Run plain `cozygateway`, exercise status and a no-change listener save, and verify `http://127.0.0.1:8787/health` plus attach `1/1 online` with zero dead letters.
- [ ] Commit the implementation with verification evidence recorded in the handoff.
