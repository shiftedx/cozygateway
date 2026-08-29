# Windows Hermes Session-Token Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and release the lean shared-installer Windows session-token path introduced by PR 266.

**Architecture:** PowerShell remains a verified release bootstrap and delegates to the cross-platform shell installer. The shell installer is the only owner of the Hermes Dashboard session token and generated CozyGateway token configuration. Production changes are test-driven and limited to defects reproduced on Windows.

**Tech Stack:** Windows PowerShell 5.1, Git Bash, Bash, Node.js 24, pnpm, Hermes Agent, local OpenAI-compatible vLLM.

## Global Constraints

- Fresh Windows CozyGateway installs only; upgrade migration is out of scope.
- Reuse an installed and configured Hermes Agent and its model provider.
- Do not duplicate Hermes authentication logic in `scripts/install.ps1`.
- Use `DASHBOARD_SESSION_TOKEN`, `HERMES_DASHBOARD_SESSION_TOKEN`, `X-Hermes-Session-Token`, and `COZYGATEWAY_HERMES_TOKEN` consistently.
- Never enable basic auth, call `/auth/password-login`, or persist Dashboard username/password keys.
- Never print session tokens, attach tokens, API keys, or active pairing codes.
- Target v0.3.9 only after confirming v0.3.8 is published or otherwise occupies that version.

---

### Task 1: Automated Windows auth regression

**Files:**
- Modify only if a failing test exposes a gap: `scripts/agent-install.sh`
- Modify only if coverage is missing: `scripts/test/hermes-installer.test.sh`
- Modify only if bootstrap behavior is implicated: `scripts/install.ps1`
- Modify only if bootstrap coverage is implicated: `scripts/test/windows-bootstrap.test.ps1`

**Interfaces:**
- Consumes: PR 266 at commit `c2d5317`.
- Produces: a passing Windows bootstrap and shared-installer auth contract with no basic-auth behavior.

- [ ] Run the Windows bootstrap test directly under Windows PowerShell 5.1.
- [ ] Run the shared installer test under Git for Windows Bash.
- [ ] Confirm the Windows cases assert token-mode config, matching protected env values, authenticated `/api/config`, absence of `/auth/password-login`, and no basic-plugin mutation.
- [ ] If any required assertion is missing, add it first and run it to prove the expected failure.
- [ ] Make the smallest production change needed to pass a genuine failing assertion.
- [ ] Re-run both installer suites and commit any code/test changes.

### Task 2: Fresh local Windows installation

**Files:**
- Generated, not committed: `dist-bundle/**`
- Managed host installation: `%LOCALAPPDATA%\cozygateway`

**Interfaces:**
- Consumes: local Hermes model provider `custom`, base URL `http://127.0.0.1:8888/v1`, model `qwen38-nvfp4`.
- Produces: live evidence that the generated Windows supervisor and Hermes Dashboard authenticate with the same session token.

- [ ] Run `pnpm bundle` and verify every generated asset has a matching SHA-256 sidecar.
- [ ] Uninstall only the managed CozyGateway test installation, preserving Hermes and its provider configuration.
- [ ] Install through `scripts/install.ps1` with `COZYGATEWAY_INSTALL_ASSET_BASE` set to the absolute `dist-bundle` directory.
- [ ] Verify `local/cozygateway.config.json` uses token auth and contains no password auth fields.
- [ ] Compare token values by digest or equality inside a redaction-safe process; do not print them.
- [ ] Verify authenticated Dashboard `/api/config`, CozyGateway `/health`, installer `--status`, and Hermes plugin/gateway state.
- [ ] Execute one real Hermes turn using `qwen38-nvfp4` and verify a nonempty response.
- [ ] Re-run status/start behavior, then uninstall and verify owned persistence/files are removed.
- [ ] Reinstall locally for release-candidate verification.

### Task 3: Version and release candidate

**Files:**
- Modify: `packages/gateway/package.json`
- Modify: `packages/gateway/src/server.ts`
- Modify: `integrations/attach-plugin/plugin.yaml`

**Interfaces:**
- Consumes: latest `origin/main` and published tag list.
- Produces: three exactly matching release version strings.

- [ ] Fetch origin and tags and confirm whether v0.3.8 exists.
- [ ] Rebase the feature branch on the latest `origin/main` after v0.3.8 lands.
- [ ] Add a failing version-consistency check for the intended v0.3.9 tag by running the release workflow's three comparisons before changing versions.
- [ ] Change all three version sources to `0.3.9`.
- [ ] Re-run the comparisons and `pnpm bundle`; inspect bundled version output.
- [ ] Commit the version bump separately.

### Task 4: Full verification and review

**Files:**
- No expected source changes.

**Interfaces:**
- Consumes: complete feature branch.
- Produces: review and verification evidence suitable for release.

- [ ] Run `pnpm build`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run the installer test with Git for Windows Bash.
- [ ] Run both Windows PowerShell installer tests directly.
- [ ] Run `pnpm --filter cozygateway-contract lint:package`.
- [ ] Run a whole-branch Sol code review and fix all important findings.
- [ ] Re-run every affected test after review fixes.

### Task 5: Upstream release and published-asset validation

**Files:**
- No expected source changes after merge.

**Interfaces:**
- Consumes: reviewed commit on `main` with all CI checks passing.
- Produces: GitHub release v0.3.9 and a validated Windows installation from its published assets.

- [ ] Push the branch, create a pull request, and wait for all CI checks.
- [ ] Merge the pull request without force-pushing or bypassing failed checks.
- [ ] Tag the merged release commit `v0.3.9` and push the tag.
- [ ] Wait for the release workflow and verify every expected asset and checksum.
- [ ] Uninstall the local release-candidate CozyGateway instance.
- [ ] Install from the published v0.3.9 assets through `install.ps1`.
- [ ] Repeat the redaction-safe token, health, status, plugin, and real-model-turn checks.
- [ ] Leave the validated CozyGateway installation running and report the release and PR URLs.
