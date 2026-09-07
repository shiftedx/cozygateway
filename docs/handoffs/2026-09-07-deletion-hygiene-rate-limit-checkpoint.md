# Deletion and install hygiene: rate-limit checkpoint

User requested a natural stopping point before rate limits. **Do not tag or deploy the current candidates until the review blockers below are resolved.** Production was deliberately left unchanged.

## User instructions to preserve

- Complete all handoff work; dashboard-first original work is already merged. Native batching only, no ToolRush.
- Use Astra High agents for deletion cleanup, repair/hygiene and production verification. All current packet agents are Astra High.
- Merge locally validated changes; publish upstream and deploy locally after consolidated review. Hosted billing failures are accepted as unavailable, not passed.
- **Do not release CozyChat**: another agent owns Jelly/character changes. Do not touch the original CozyChat checkout or its simulator.
- Local-model reliability testing is deferred to the user's overnight work. Do not start model tests or schedule an automation implicitly.
- Keep only Cleo (`cleo`), Nighty (`night-owl`), Clip Bot (`drowsy-lark`), Breezy Ivy (`breezy-ivy`, CozyAgents runner), Polished Satellite (`polished-satellite`). Previous live cleanup completed. Preserve backups/quarantines and the shared `g6 room` history/membership.
- User requested all implementation merged first, then one consolidated normal review/validation. That review ran and found the blockers below; focused fixes are being checkpointed.

## Production and release status

- Gateway production/public stable: **v0.7.8**, `f7164c9837076009ef1dd41bc53cd53a6184ea8c`.
- CozyAgents production/public stable: **v0.2.14**. Installed runner asset SHA256 `9d707812b47ec6ac3fddb28eeb1f4b8b19790a0f6236e6ab15a69110e1f5b9df`.
- Latest read-only checks: ready 5/5, Hermes 4/4, queues empty; no release/deploy/service mutations in this packet.
- Gateway and Agents versions are already bumped on main to **0.7.9 / 0.2.15**, but **neither tag has been published**.
- Website canonical checkout is clean at `dc754ab` or newer; pins still v0.7.8/v0.2.14. Preserve its newer phone-pairing documentation when updating pins from a clean latest-main worktree.
- Existing provisioner `~/Library/Application Support/cozylabs/provisioner/current` points to `releases/20260907T220429Z-34266`. New installer read-only ownership validation accepts this legacy stage, including its missing deprovision helper. Original source checkout in STAGED_FROM no longer exists, intentionally accepted as recorded identity.
- Four legitimate Hermes LaunchAgents use the 14-argument `stderr_timestamp` wrapper followed by the same Python executable, `-m hermes_cli.main --profile <name> gateway run --external-supervisor`. UID501; exact profile WorkingDirectory/HERMES_HOME; profile-local absolute error-log path. Do not reject these as foreign when fixing ownership checks.

## Merged work / exact candidates

Gateway main candidate **`380b4cc4eeaab28019b0fa360b35543bc7f7760c`**:

- [#420](https://github.com/shiftedx/cozygateway/pull/420): durable bot-owned storage deletion, credential fingerprint revocation across same-name recreation/restart, runtime cleanup acknowledgements, automatic staged deprovisioning/retry/SIGKILL locks, v0.7.9 preparation. Merge `524ca7be34638a0dbef27a6e45683b213f2d7f7c`.
- [#419](https://github.com/shiftedx/cozygateway/pull/419), [#421](https://github.com/shiftedx/cozygateway/pull/421): Windows reports; #421 is docs-only, `c24ff91b1443d5c79baa4067448d350262dc2da2`.
- [#422](https://github.com/shiftedx/cozygateway/pull/422): automatic native saved-scope hygiene, shared/custom env preservation, owned staged provisioner migration/rollback, protocol docs and Windows delta handoff. Merge `380b4cc4eeaab28019b0fa360b35543bc7f7760c`.

CozyAgents main candidate **`1ab29c7cb65764f2a53068cf1f80296f252c4c4c`**:

- [#173](https://github.com/shiftedx/cozyagents/pull/173) isolated updater startup from the CLI bundle; merge `388764e31d56fd1bbe069cf5ac1c0929a311e255`.
- [#174](https://github.com/shiftedx/cozyagents/pull/174) prepares v0.2.15, fixes updater startup via directory aliases/junctions, and exposes original private-Node installer fixture failures.

## Consolidated review blockers (must fix before release)

1. **P1 native timeout after force-delete crashes Gateway.** `NativeBotDataPlane.removeRuntimeBot` removes runtime maps but leaves `#turnTimers`. `#timeoutTurn` around native-data-plane.ts:3365 calls `nativeBotChat`; the new deleted-bot fence throws uncaught from setTimeout. Reproduced with real SQLite/data plane and a 30ms timeout. Cancel exact bot timers and guard stale callbacks, with force-delete regression.
2. **Late Live Activity registration can resurrect deleted metadata.** http.ts around1780–1823 awaits relay response/JSON then persists without checking original bot/run/session lifetime. A response after purge can reinsert a registration and leave its new push ID unqueued. Revalidate original ownership, including same-name recreation, and enqueue stale remote registration for cleanup.
3. **Foreign service deletion through filename discovery.** New watcher scan admits an unloaded `ai.hermes.gateway-foreign.plist` by prefix/name alone; deprovision can delete an unconfigured/un-journaled plist with unrelated ProgramArguments/WorkingDirectory. Reproduced through actual staged watcher. Require structural ownership proof before remote edits and again before service teardown; preserve unknown identities/services. Accept legitimate production wrapper shape above.
4. **Multiline custom dotenv corruption.** Native physical-line filtering deletes a managed-key-looking line inside a valid unrelated multiline quoted value. Reproduced with `CUSTOM_NOTE="before\nCOZYGATEWAY_ATTACH_TOKEN_RETIRED=note content\nafter"`. Preserve custom bytes/values or fail closed before mutation. Check split-host provision/deprovision filters too.

Reviewers found no additional concrete standards violations or CozyAgents entrypoint blockers. Any new follow-up fixes need targeted independent re-review, then appropriate final checks; do not restart unrelated feature work.

## Worktrees and agents

- Gateway integration: `/Users/kmcdowell/Documents/repos/worktrees/automatic-deletion-release`, branch `codex/gateway-v079-final-validation`, based exact merged380b4cc. This checkpoint document is the only root-owned new change.
- Gateway storage author: `/Users/kmcdowell/Documents/repos/worktrees/automatic-bot-deletion`, branch `codex/deletion-late-callback-fixes`; agent `/root/deletion_storage` (Popper), owns timer + delayed Live Activity fixes. Earlier source commits6a6aa16,7146758,adb6f69 already landed via#420. Request latest checkpoint SHA/status before continuing.
- Gateway host author: `/Users/kmcdowell/Documents/repos/worktrees/automatic-host-deprovision`, branch `codex/automatic-host-deprovision`; agent `/root/deletion_host` (Boole), owns service ownership + multiline env fixes. Earlier commits2829521,1f71ebb,513f78d and0e449863 hygiene already landed via#420/#422. Request latest checkpoint SHA/status.
- Agents release worktree: `/Users/kmcdowell/Documents/repos/worktrees/cozyagents-v0215-release`, branch `codex/cozyagents-v0215-validation`, exact1ab29c7c. Clean source.
- Diagnostic worktree: `/Users/kmcdowell/Documents/repos/worktrees/windows-private-node-diagnostics`; diagnostic7dddd5 already included in#174; do not reapply.
- Release/deployment agent `/root/production_gateway_release` (Godel), Astra High, knows safe production backup/pairing/deploy/pin flows and has completed read-only preflights. Reuse only after review/checks green.
- Do not reset the original Gateway main checkout (still older) or original CozyChat checkout. Preserve other agents' work.

## Validation completed / limitations

Node24 PATH: `/opt/homebrew/opt/node@24/bin:$PATH`.

- Initial deletion integrated `pnpm check` PASS: 2,348 tests,26skipped; complete `pnpm test:installer` PASS. Logs `/tmp/automatic-deletion-check-final.log`, `/tmp/automatic-deletion-installer-final.log`.
- Hygiene focused six disposable cases PASS,39.120s, real checksummed file bootstrap and generated repair/update; shell syntax/diff checks PASS. `/tmp/install-hygiene-focused-tests.log`.
- Consolidated Gateway380b4cc `pnpm check` PASS. `/tmp/gateway-v079-consolidated-check.log`. Installer suite was still finishing at checkpoint; inspect `/tmp/gateway-v079-consolidated-installer.log` and final status below.
- Agents1ab29c7c bundle/standalone alias checks and19targeted version/worker tests PASS. Consolidated `npm run test:all` stopped at one timeout: service-real-pi-endurance test exceeded its existing15s bound amid full parallel run; 3,576tests passed,12skipped,1failed. `/tmp/cozyagents-v0215-consolidated-gate.log`.
- Exact unchanged endurance test rerun alone PASS (6.05s test,8.48s total), `/tmp/cozyagents-v0215-endurance-focused.log`. No timeout or product change made. Remaining gate smoke/POSIX stages were not executed after the full-run failure; finish normal verification on resume. This test uses scripted local fixture responses, not the configured live model.
- Hosted Gateway#420 checks/docker/secrets passed; Windows job status should be fetched fresh. Agents1ab CI/Security jobs executed zero steps; annotation explicitly says failed payments/spending limit. Do not call them green.

## Windows evidence

Original private Node failure was a267-character native staging path, not extraction corruption. Unchanged earlier candidate8dcd6a passed130native checks with shorter original prefix (109installer,19lifecycle,bundle,entrypoint). Deep custom install paths remain unqualified; no product fix was merged for long paths. Exact1ab29c junction delta and new Gateway native hygiene cases are not yet native-Windows-qualified.

See `docs/handoffs/2026-09-07-windows-private-node-rerun.md` (updated current-candidate narrow delta) and `docs/install-hygiene.md` (new hygiene Windows handoff). User has a Windows agent and requested Markdown handoffs; do not repeat already-completed full suite by default.

## Resume sequence

1. Collect/checkpoint followup commits below; finish missing targeted tests, independently re-review the four fixes, merge clean locally validated followups.
2. Finish normal Gateway and Agents gates on exact final main. Diagnose the existing endurance timing failure without blindly inflating timeout or launching a benchmark campaign. Check current hosted evidence, separating billing from real failures.
3. Publish Gatewayv0.7.9 and Agentsv0.2.15 only after green review/checks. Never move/delete an existing tag. Verify generated/published asset hashes; keep one stable latest per repository.
4. Fresh online SQLite backup with integrity/hash verification and offhost copy before a short Gateway cutover. Retain configuration, pairing, previous payloads and backups. Do not compress huge backups while stopped.
5. Deploy exact released Gateway, four Hermes/global plugins, and complete staged provisioner. Existing relay sources are unchanged; do not disturb them unnecessarily. Update local runner to exact released Agents asset. Preserve5keepers and g6room.
6. Run a disposable bot create→automatic provision→API delete→automatic host cleanup check with no inference. Verify no owned config/token/service/DB residue, old credentials rejected, cleanup journal clear, and return to5/5. Revoke temporary operator credential in finally.
7. Update website installer pins/private mirrored assets from latest main (dc754ab or newer), verify checksums and live website deployment. No CozyChat release. Save final proof and report platform limitations honestly.

## Final agent checkpoints at stop

- **Storage fixes `80ee96ad250de69d37c6677d625b8d461a86fd24`**, branch `codex/deletion-late-callback-fixes`, based exact380b4cc. Clean. Timer and delayed Live Activity fixes implemented;75focused tests PASS (native data plane62, push proxy12, LiveActivity storage1), including delete/recreate, keeper timer, failed relay cleanup retry and preservation of recreated registration. Diff check PASS. Build/typecheck and independent re-review are pending. Apply only this followup to latest main.
- **Host fixes `1644bc51033bee323dbef99852abdc22498efaa9`**, branch `codex/automatic-host-deprovision`. Clean. Service ownership validates legitimate14argument wrapper before edits/bootout; foreign or definition-less services remain untouched. Native/split-host/local-profile multiline ambiguity is refused before mutation. Initial15case run had3failures; guard typo and shadowed token were corrected, then4affected rechecks PASS9.659s (`/tmp/host-review-fixes-recheck.log`). Hygiene7/7PASS44.336s (`/tmp/host-review-fixes-hygiene.log`); shell syntax/diff checks PASS. Full corrected host suite and independent re-review are pending. Cherry-pick **only1644bc5**, since earlier author history was already squash-merged.
- Both author branches are pushed for recovery. Neither followup is merged, reviewed to completion, released, or deployed. All agents stopped at the user's request.
