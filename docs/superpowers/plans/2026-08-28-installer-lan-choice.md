# Installer LAN Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, one-question LAN opt-in to fresh interactive CozyGateway installs.

**Architecture:** Keep listener intent resolution in `scripts/agent-install.sh`: command-line/environment intent first, then saved configuration, then an interactive fresh-install prompt. The existing gateway pairing implementation remains responsible for replacing wildcard listeners with a detected LAN address in the QR payload.

**Tech Stack:** Bash, the existing shell installer harness, PowerShell bootstrap tests.

## Global Constraints

- Enter or `n` preserves `127.0.0.1`; only `y` selects `0.0.0.0`.
- Never prompt for explicit listener/public URL intent, saved installs, dry runs, upgrades, or noninteractive standard input.
- Do not configure Windows Firewall, routers, DNS, TLS, or Tailscale.
- LAN completion copy must call out trusted-private-network use and the existing Tailscale documentation.

---

### Task 1: Add the fresh-install LAN decision

**Files:**
- Modify: `scripts/agent-install.sh`
- Test: `scripts/test/hermes-installer.test.sh`
- Modify: `docs/agent-install.md`

**Interfaces:**
- Consumes: `BIND_HOST_EXPLICIT`, `PUBLIC_URL_EXPLICIT`, `CLEAR_PUBLIC_URL`, `DRY_RUN`, and `CONFIG_JSON` after `hydrate_listener_settings`.
- Produces: `choose_fresh_listener`, which leaves `BIND_HOST=127.0.0.1` or sets `BIND_HOST=0.0.0.0` before `validate_listener_settings`.

- [ ] **Step 1: Write failing harness cases**

Add installer cases that pipe `y`, blank input, and invalid-then-`y` into a fresh install and assert the generated config host. Add bypass cases for an explicit `--bind-host`, an existing config, dry-run, and closed/noninteractive stdin. Assert LAN completion output mentions a trusted private network and Tailscale.

- [ ] **Step 2: Run the focused harness and verify red**

Run: `"C:\Program Files\Git\bin\bash.exe" scripts/test/hermes-installer.test.sh`

Expected: FAIL because a fresh affirmative answer still writes `127.0.0.1`.

- [ ] **Step 3: Implement the minimal prompt**

Add a function with this decision shape before listener validation:

```bash
choose_fresh_listener() {
  local answer
  [ ! -f "$CONFIG_JSON" ] || return 0
  [ "$BIND_HOST_EXPLICIT" = 0 ] || return 0
  [ "$PUBLIC_URL_EXPLICIT" = 0 ] || return 0
  [ "$CLEAR_PUBLIC_URL" = 0 ] || return 0
  [ "$DRY_RUN" = 0 ] || return 0
  [ -t 0 ] || return 0
  while true; do
    read -r -p 'Allow devices on your local network to connect? [y/N] ' answer || return 0
    case "$answer" in
      y|Y|yes|YES|Yes) BIND_HOST=0.0.0.0; return ;;
      ''|n|N|no|NO|No) return ;;
      *) say 'Please answer y or n.' ;;
    esac
  done
}
```

Call it after hydration and before validation. For testability without changing production defaults, allow the harness to supply a terminal predicate through its existing command stubs rather than adding a public installer flag.

When `BIND_HOST=0.0.0.0` and no public URL is set, print that LAN access is plaintext and only for a trusted private network, followed by the CozyGateway Tailscale documentation URL.

- [ ] **Step 4: Document and verify green**

Update `docs/agent-install.md` with the exact prompt rules and bypass behavior. Run the focused harness, `scripts/test/windows-bootstrap.test.ps1`, `git diff --check`, and Bash syntax validation. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-install.sh scripts/test/hermes-installer.test.sh docs/agent-install.md
git commit -m "feat: offer LAN access during install"
```
