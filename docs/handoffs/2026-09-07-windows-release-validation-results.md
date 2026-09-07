# Windows release validation results — 2026-09-07

**Published CozyAgents v0.2.14: FAIL/BLOCKED for a clean release qualification.** Its native Windows source lane passes with stated limits, but the exact published CLI executes the update-worker entry point during ordinary CLI startup. `runner --help` prints an unexpected updater usage line before the normal help. A focused fix has passed local regression checks and independent review; the published release has not been changed.

**Gateway v0.7.8: PASS for the existing hosted Windows installer lane.** No local repeat was required.

This report distinguishes source fixtures, published artifact checks, and a locally patched candidate. None establishes complete installed-product acceptance, logon/reboot recovery, or real paired update receipts.

## Targets and isolated workspaces

| Product | Tag | Exact source commit | Verification |
| --- | --- | --- | --- |
| CozyAgents | v0.2.14 | `da8027c6f56120ae9cef32a78ca0d023218bc07d` | Detached source worktree; remote annotated tag and GitHub tag-object API agree |
| Gateway | v0.7.8 | `f7164c9837076009ef1dd41bc53cd53a6184ea8c` | Local fetched tag, detached worktree, and hosted workflow head agree |

Paths below use `<gateway-checkout>` to avoid publishing private host paths. The retained validation root is `<gateway-checkout>/.worktrees/windows-release-20260907`; `<logs>` means its `logs` directory. Source worktrees are `agents` and `gateway`; the fix worktree is `agents-help-fix`. Published downloads are in `published`, separate from all generated bundles.

Both original checkouts were clean at the validation inspection. At the end of validation, original Gateway HEAD was `28490a98c7eecc3ed6e9accc47e674d58ad26f58`; original CozyAgents HEAD was `757f369d0124775c4b934bff628db5e17a3be56a`. Neither was reset or switched during validation. No repository AGENTS instructions were present in the Gateway worktree; the existing CozyAgents AGENTS instructions were read.

CozyAgents local tags v0.2.12–v0.2.14 contain invalid NUL-filled ref files. The v0.2.14 file contains 41 NUL bytes. Those existing files were left untouched. The intact pinned commit was used, and `git ls-remote origin refs/tags/v0.2.14 'refs/tags/v0.2.14^{}'` verified annotated tag object `254646460c02483faf4e3ae1ec660466ec1101d0` peeling to the expected commit. This is a local repository setup limitation, not evidence of a release asset mismatch.

## Host and tools

| Item | Observed value |
| --- | --- |
| OS | Microsoft Windows 11 Pro, 25H2, build 26200.9168, x64 |
| Node / npm | v24.15.0 / 11.12.1 |
| Git for Windows / Git Bash | 2.54.0.windows.1 / GNU Bash 5.3.9 |
| PowerShell used for native Agents tests | 7.6.5 |
| Windows PowerShell available | 5.1.26100.9168 |
| Free disk at preflight | 185,707,298,816 bytes |
| GitHub authentication | Authenticated release, tag, and Actions reads succeeded outside the restricted sandbox; no credentials printed |
| Gateway package manager | Local PATH exposes pnpm 11.19.0; unused. Hosted Windows log confirms required pnpm 10.30.1 and Node v24.19.0 |

No machine-wide prerequisites or configuration were installed or changed. Native tests used an absolute Git Bash path, a process-local PATH with Git's tools first, explicit `COZYAGENTS_PWSH`, and disposable `TEMP`/`TMP`/`TMPDIR` under `<logs>/agents/temp`.

Two source bundle setup attempts failed with exit 1 before the successful host run: inherited PATH selected WSL Bash (`Bash/Service/CreateInstance/E_ACCESSDENIED`), then esbuild was denied an ancestor-directory read by the sandbox. Process-local PATH and normal host access resolved them. Original failure logs are retained as `bundle-host-path-failed.*` and `bundle-sandbox-failed.*`; no product timeout or assertion was weakened. The fix worktree also retains its sandbox build failure and shell-path smoke failure separately.

## CozyAgents pinned source lane

These commands ran sequentially from the detached exact-commit worktree through Git Bash. `<logs>/agents/run-lane.ps1` preserves the actual host invocation and environment overrides; each command has a `.log` plus a `.json` with timestamps and exit code.

| Command | Final exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | 394 packages added; 395 audited; zero vulnerabilities reported |
| `npm run bundle` | 0 | TypeScript build and both bundles generated |
| `npm run smoke:bundle` | 0 | Six existing smoke assertions passed |
| `npm run test:windows` | 0 | 1 bundle check, 109/109 installer checks, 19 lifecycle assertions passed |

The Windows lane ran native PowerShell, not the non-Windows SKIP path. Its 129 `ok` lines comprise the bundle check, installer checks, and lifecycle assertions; 109/109 is the installer suite's emitted aggregate.

The locally generated main bundle matches the published fixed SHA-256 exactly: `9d707812b47ec6ac3fddb28eeb1f4b8b19790a0f6236e6ab15a69110e1f5b9df`. Browser-runtime archives were built locally and checked against their own generated sidecars; these are not substituted for the published archive evidence below.

Native lifecycle observations include registration of the exact disposable ONLOGON task, hidden WScript launch, current-user SID and battery settings, PT1M restoration after the fixture child exited 23, exact task removal, and registration/execution/reaping of the one-shot update worker fixture. The scheduled task returned to Running with a new child PID. Existing deadlines were preserved.

Limits explicitly retained:

- Startup fallback was not exercised because task registration succeeded; there was no permission-only ONLOGON refusal on this run.
- Interactive-session restore and machine-start restore require actual session transitions and remain unqualified.
- Remote reconnect and update receipts require a paired disposable Gateway and remain unqualified.
- Installer assets and the lifecycle worker were disposable fixtures. This does not test upgrading, repairing, uninstalling, or preserving a real production installation.

## Published CozyAgents assets

Acquisition commands all exited 0:

```text
gh release view v0.2.14 --repo shiftedx/cozyagents --json tagName,targetCommitish,assets,url,publishedAt
gh release download v0.2.14 --repo shiftedx/cozyagents --dir <validation-root>/published
gh api repos/shiftedx/cozyagents/git/ref/tags/v0.2.14
gh api repos/shiftedx/cozyagents/git/tags/254646460c02483faf4e3ae1ec660466ec1101d0
```

All six runtime/bootstrap files match their sidecar filename and SHA-256, and the manifest's exact asset names, hashes, and sizes. All 13 downloaded files, including the manifest and sidecars, match GitHub's asset sizes and digests.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| agents.sh | 53,813 | `3f25318a52dc3cea55663377c3a53b14461b7d56797e91137a1a0fe9518d7b88` |
| agents.ps1 | 64,277 | `e20c60eeaa763757daa48479fed10405a9be11caa9ca7bd8698dfaaa92cec3cd` |
| cozyagents.mjs | 16,956,607 | `9d707812b47ec6ac3fddb28eeb1f4b8b19790a0f6236e6ab15a69110e1f5b9df` |
| cozyagents-update.mjs | 287,814 | `a384a012f5ac3fcba26768bd6bd8805c974fe6168801da1cbcdc7346068b56a4` |
| cozyagents-browser-runtime.tar.gz | 4,100,040 | `d759f22925c7c8d673b67479425be005abc74986ce46615fca5948ba1d29b9b3` |
| uninstall.sh | 1,628 | `aeff108449be94cc1df8152b1eb1161171da0ebe10b76861f7914df6a4eb784e` |

| Direct command against downloaded CLI, Node v24.15.0 | Exit | Observation |
| --- | --- | --- |
| `node <published>/cozyagents.mjs --version` | 0 | Exactly `0.2.14` |
| `node <published>/cozyagents.mjs runner --help` | 0 | Unexpected updater usage line before normal CozyAgents help |

Unexpected first line retained verbatim:

```text
Usage: cozyagents-update.mjs --home <path> --operation-id <runner_maintenance_id>
```

The artifact worker did not invoke the published update-worker file directly, pair a runner, or replace an installed launcher. Before/after Node snapshots show no new remaining Node processes; transient process/window creation was not traced. A zero exit does not erase the unexpected output or establish a clean smoke result.

## Confirmed defect and local candidate

`runner/index.ts` imports the reusable update-worker helpers. The old `update-worker.ts` also contained command-line startup guarded by `fileURLToPath(import.meta.url) === process.argv[1]`. When bundled into the main CLI, that comparison becomes true for the main CLI file, starting the worker entry point too. The old smoke assertion only searched for the expected runner-help substring, so it missed the extra worker output.

The local fix moves worker argument parsing and startup into `src/runner/update-worker-cli.ts`, points the worker bundle at that dedicated entry, and leaves `update-worker.ts` safe to import. A regression stages the actual standalone bundles and checks CLI version, both CLI help forms, standalone worker help, and missing-worker-argument failure. It runs from the existing bundle smoke and Windows bundle test. The regression honors a custom CLI filename and hides spawned Windows helpers.

Fix commit: `490993b47b6a03e8ab2f996ed0bf604cb8695f34` on `codex/windows-bundle-help-fix` in the clean `agents-help-fix` worktree. Six files changed, +67/−22. Local candidate main bundle SHA-256: `335c186b52c0588fa71fcbf182f80bd86b97887ec90cfe9d2cb629b1da0d3fe8`. This is a patched local build, not the published v0.2.14 bytes.

The [portable patch](2026-09-07-cozyagents-windows-bundle-entrypoints.patch) applies to the CozyAgents repository, not Gateway. Its SHA-256 is `78eb317fde02156227b75cdf47677f98eccb53c57bca78b7e7b0c00613b10ae2`. `git apply --check <patch>` against the pristine pinned CozyAgents source worktree exited 0; the patch was not applied there. Nothing was pushed during the validation phase.

| Candidate check | Exit / count |
| --- | --- |
| New entrypoint regression against published artifact | 1, expected RED on the unexpected updater usage |
| `npm run bundle` | 0 |
| `node scripts/test/bundle-entrypoints.mjs` against candidate | 0 |
| `node node_modules/vitest/vitest.mjs run tests/runner-update-worker.test.ts` | 0; 16/16 passed |
| `npm run smoke:bundle` | 0 |
| `pwsh.exe -NoProfile -File tests/windows/bundle.test.ps1`, including GNU tar and new regression | 0 |
| Independent review of all six changed files | No actionable findings |
| Parent rerun of entrypoint regression after commit, plus candidate hash check | 0; hash matches above |
| `git diff --check` and portable patch applicability | 0 |

Non-help instrumentation also confirmed the defect: published `--version` assigned `process.exitCode` values `[1, 0]`, whereas the fixed bundle assigned `[0]`. Both commands ultimately exited 0. A process proxy recorded the assignments and stack sites; no runner was started. Long-running runner impact was not exercised. An earlier diagnostic harness failed before loading either bundle because Node's exitCode property is nonconfigurable; that harness failure is retained separately and is not classified as a product failure.

The unchanged full installer/lifecycle lane was not rerun on the patched candidate. The changed native bundle test, entrypoint regression, smoke, and worker tests provide the focused candidate evidence.

## Gateway final hosted Windows result

[Workflow 34164453135](https://github.com/shiftedx/cozygateway/actions/runs/34164453135) completed successfully at `f7164c9837076009ef1dd41bc53cd53a6184ea8c`. [Windows job 101872617581](https://github.com/shiftedx/cozygateway/actions/runs/34164453135/job/101872617581) completed successfully at 2026-09-07 22:05:14 UTC, with every step successful.

```text
gh run view 34164453135 --repo shiftedx/cozygateway --json databaseId,headSha,status,conclusion,url,jobs
gh run view 34164453135 --repo shiftedx/cozygateway --job 101872617581 --log
```

Both retrieval commands exited 0. The actual log confirms bootstrap, hidden supervisor (4 tests, 0 failed/skipped), launcher ownership/cleanup, prerequisites, transaction, Agents bootstrap, Dashboard ownership, native Node identity, Hermes installer, and spool (9 tests) checks. The Hermes step succeeded; the prior cold-supervisor failure was not reproduced or used to justify a timeout change.

Because this exact-commit hosted lane passed, no local Gateway dependency install, build, installer repeat, or bundle download was performed. The Gateway hash supplied in the handoff was not independently checked against downloaded bytes in this session.

## Cleanup, preservation, and retained evidence

Before execution, cleanup boundaries were inspected. Installer fixtures own generated asset/install directories. Lifecycle cleanup checks exact process executable, command line and creation time, uses unique task identities derived from its disposable root, and validates its temporary-root prefix before deletion.

Post-suite inspection found zero fixture tasks or processes and no remaining fixture directories. Only Node's compile cache remains under the redirected test temp root. The host comparison found unchanged Cozy/Hermes service metadata, scheduled-task state, and Startup-entry hashes; every captured pre-existing Node, Python, and LM Studio process retained its PID and creation time. No production installation, pairing, bot/model settings, or model server was changed or restarted by this work. Configuration preservation is based on isolated execution and reviewed mutation paths; a production configuration-content comparison was not performed.

No CozyChat checkout/build/release work, ToolRush, benchmarks, model sweeps, public release-note edits, tag publication, deployments, or production rollout were performed. The user identified the earlier PC crash as unrelated; its reboot preceded these validations, and system-crash diagnosis was not pursued.

Private evidence retained under `<logs>`:

- `host/preflight.json`, `before.json`, `after-source.json`, `comparison-after-source.json`, and the read-only capture script.
- `agents/run-lane.ps1`, each command's `.log`/`.json`, original setup failures, `source-evidence.json`, and `cleanup.json`.
- `release/acquisition-commands.txt`, GitHub release/tag/run JSON, `gateway-windows-job.log`, `checksum-table.csv`, `verify-published.ps1`, `verification-transcript.txt`, exact CLI output, and Node snapshots.
- `help-fix/` contains published reproduction, RED/GREEN regression, build, smoke, Windows bundle and worker-test logs with exit-code sidecars, plus the initial host failures.

The source Windows validation gap now has positive evidence. The published CLI defect and the stated installed-product/session/paired limits prevent an unconditional Windows-qualified claim. At the end of validation, the local fix was ready for integration and a subsequent release decision; no existing release was republished.

## Subsequent integration

The same six-file patch was integrated onto current CozyAgents main `66e14203e6fdcf3dd552da1a2bd842ca1ea9df72` as commit `8dcd6a3c9d87d8504f7751f8475d7cbc2787504e` in [CozyAgents PR #173](https://github.com/shiftedx/cozyagents/pull/173). This fresh integration preserves the original validation commit and evidence above. `npm ci`, `npm run bundle`, the 16 worker tests, and `npm run smoke:bundle` all exited 0 on the integration candidate. Its main bundle SHA-256 remained `335c186b52c0588fa71fcbf182f80bd86b97887ec90cfe9d2cb629b1da0d3fe8`.

Hosted CozyAgents integration CI and security jobs could not start because GitHub reported an account payment or spending-limit restriction. This is an infrastructure limitation, not a failed test assertion. No workflow or billing settings were changed.

CozyAgents PR #173 merged at `2026-09-07T22:47:36Z` as main commit `388764e31d56fd1bbe069cf5ac1c0929a311e255`, using the normal squash merge with no administrator bypass or gate changes. No release was published or replaced.

A subsequent full native `npm run test:windows` on integration commit `8dcd6a3c9d87d8504f7751f8475d7cbc2787504e` exited 1. Its installer suite failed at the checksum-verified private Node staging case: the expected `node/node.exe` was absent when invoked. This later run does not replace the successful original pinned-source lane above, and does not establish full native acceptance for the integrated candidate. The cause remains unqualified in this report; its private log and exit-code sidecar are retained under `<logs>/integration/native-windows.*`.
