# Windows complete setup and update

Scope: Windows PowerShell only. Do not modify macOS/Linux installers or shared shell installer behavior.

The approved experience is one invocation that updates the gateway and its selected installed harnesses, preserves user data, asks only for missing configuration, and verifies each product before declaring success. Existing installs keep their recorded selection by default; explicit `-Harness` adds a harness. Routine reruns do not ask for a new device pairing code.

Before resolving or writing an installation, an elevated invocation relaunches the exact bootstrap through the verified same-account, same-session normal desktop process. Preserve arguments, environment, working directory, interactive input and exit status. Refuse an ambiguous desktop account, unavailable normal desktop or OS launch denial with one actionable instruction. Never silently switch accounts or continue elevated after handoff failure. Native testing demonstrated that a linked token can be identification-only; the implementation uses the desktop parent process attribute rather than attempting to launch with that token.

One Windows bootstrap lock spans all component changes. Recover any interrupted gateway transaction before invoking harness updaters. Preserve the existing verified Gateway snapshot protocol, fix its preparation/journal crash windows, and use an OS-held file lock instead of PID liveness for new locks.

Use Hermes' supported `update --yes` for existing Hermes, with no force flags. Verify its version/launcher and let the existing Windows gateway installation prove selected Hermes attachment readiness. Hermes owns its backup/recovery; do not promise to roll back arbitrary third-party state.

Commit the healthy gateway transaction before updating CozyAgents. Missing/damaged Agents goes through its verified installer and existing pairing path. Existing Agents updates through `update --home ... --json`, preserving the installed release source. Require successful exit, succeeded status and restarted version evidence. A harness failure does not rewind an already successful gateway update. A small non-secret Windows setup receipt records per-component started/succeeded/failed outcomes. Rerunning reconciles each product through its idempotent supported updater; receipts never substitute for health evidence.

Retry only transient download failures with a bounded policy; checksum failures and permanent HTTP errors fail immediately. Preserve the prior destination until a full download succeeds.

Verification includes PS5.1/7, original File/iex entry points, native token checks and opt-in real elevated integration, argument round trips, exact account preservation, update failures/reruns, preserved credentials/models, lock concurrency/kill recovery, journal crash windows, transient/permanent downloads and the existing Windows installer suites. Simulated elevation is not represented as real UAC qualification.
