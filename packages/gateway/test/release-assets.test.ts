import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { loadConfig } from "../src/config.ts";

/**
 * Both one-liners are piped straight into a shell, so both have to be release assets: the bytes a
 * person runs should be the bytes a version signed off on, not whatever the branch says this
 * minute. The Windows bootstrap shipped that way from the start and the POSIX one did not, which
 * left `/install.sh` pointing at a mutable branch file while `/install.ps1` was pinned.
 *
 * The workflow lists its uploads by hand, so this asserts the list still names every asset the
 * bundle produces. A bootstrap that quietly stops shipping is a broken install command.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8").replaceAll("\r\n", "\n");
const BUNDLER = readFileSync(join(ROOT, "scripts/build-bundle.mjs"), "utf8");
const INSTALLER = readFileSync(join(ROOT, "scripts/agent-install.sh"), "utf8");
const SUPERVISOR = join(ROOT, "scripts/gateway-supervisor.cjs");
const SUPERVISOR_BODY = readFileSync(SUPERVISOR, "utf8");

const REQUIRED = [
  "cozygateway.mjs",
  "cozygateway-hermes-attach-plugin.tar.gz",
  "cozygateway-installer.sh",
  "gateway-supervisor.cjs",
  "install.ps1",
  "install.sh",
];

describe("what a release publishes", () => {
  it("keeps the bundle smoke fixture valid against the current gateway config", () => {
    const smokeJson = WORKFLOW.match(/cat > \/tmp\/smoke\.json <<'EOF'\n([\s\S]*?)\n\s+EOF/)?.[1];
    expect(smokeJson, "release.yml has no /tmp/smoke.json fixture").toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-release-smoke-"));
    const path = join(directory, "smoke.json");
    writeFileSync(path, smokeJson!);
    expect(loadConfig(path).hermesEndpoints).toMatchObject([{
      id: "default",
      url: "ws://127.0.0.1:19999/api/ws",
      tokenEnv: "SMOKE_HERMES_TOKEN",
      profiles: { default: { tokenEnv: "SMOKE_ATTACH_TOKEN" } },
    }]);
  });

  it("uploads every asset, and a checksum beside each one", () => {
    for (const asset of REQUIRED) {
      expect(WORKFLOW, `${asset} is not uploaded by release.yml`).toContain(`dist-bundle/${asset}\n`);
      expect(WORKFLOW, `${asset} ships with no checksum`).toContain(`dist-bundle/${asset}.sha256`);
    }
  });

  it("builds both one-liner bootstraps, not just the Windows one", () => {
    expect(BUNDLER).toContain('"dist-bundle/install.ps1"');
    expect(BUNDLER).toContain('"dist-bundle/install.sh"');
    expect(BUNDLER).toContain('"dist-bundle/gateway-supervisor.cjs"');
  });

  it("one supervisor starts Gateway in both harness modes", () => {
    expect(existsSync(SUPERVISOR)).toBe(true);
    expect(INSTALLER).toContain("gateway-supervisor.cjs");
    expect(INSTALLER).not.toContain("write_cozyagents_wrapper()");
    expect(INSTALLER).not.toContain("exec \"$NODE_RESOLVED\" - ");
  });

  it("POSIX exits once and relies on the native service restart", () => {
    const serviceWriter = INSTALLER.slice(INSTALLER.indexOf("install_service() {"), INSTALLER.indexOf("dashboard_ready() {"));
    expect(INSTALLER).toContain('<string>$(xml_escape "$NODE_RESOLVED")</string><string>$(xml_escape "$SUPERVISOR")</string>');
    expect(INSTALLER).toContain("printf 'ExecStart=%q %q ' \"$NODE_RESOLVED\" \"$SUPERVISOR\"");
    expect(serviceWriter).not.toContain("ExecStart=/bin/bash $WRAPPER");
  });

  it("Windows bounds child restarts", () => {
    expect(SUPERVISOR_BODY).toContain("crashTimes.length >= 3");
    expect(SUPERVISOR_BODY).toContain("now - crashTimes[0] >= 300_000");
  });

  it("derives missing-state Windows task ownership from the canonical Gateway bundle", () => {
    expect(INSTALLER).toContain('[ "$bundle" = "$(to_windows_path "$GATEWAY_DIR/bin/cozygateway.mjs")" ]');
  });

  it("config change restarts without spending crash budget", () => {
    expect(SUPERVISOR_BODY).toMatch(/if \(deliberateRestart\) \{[\s\S]*?return start\(\);[\s\S]*?\}\s*crashed\(\);/);
  });

  it("Hermes prelude cleans up only its owned Dashboard on failure", () => {
    expect(SUPERVISOR_BODY).toContain("if (child) await stopOwnedDashboard(child, options)");
  });

  it("task action directly tracks the Node supervisor", () => {
    expect(INSTALLER).toContain('schtasks.exe /Create /F /TN "$WINDOWS_TASK" /XML');
    expect(INSTALLER).toContain('schtasks.exe /Run /TN "$WINDOWS_TASK"');
  });

  it("task has bounded restart policy", () => {
    expect(INSTALLER).toContain("<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>");
  });

  it("successful registration never launches detaching VBScript", () => {
    expect(INSTALLER).toContain("shell.Run(command, 0, True)");
    expect(INSTALLER).not.toContain('task_command="wscript.exe');
  });

  it("Startup fallback waits and retries only three times", () => {
    expect(INSTALLER).toContain("For attempt = 0 To 3");
    expect(INSTALLER).toContain("If attempt < 3 Then WScript.Sleep 60000");
  });

  it("repair replaces only an owned task action", () => {
    expect(INSTALLER).toContain("if [ -n \"$existing\" ] && ! windows_task_uses_current_supervisor; then");
    expect(INSTALLER).toContain("Scheduled Task $WINDOWS_TASK is foreign; leaving it untouched");
  });

  it("checksums whatever it built, if a bundle is present", () => {
    const dist = join(ROOT, "dist-bundle");
    if (!existsSync(join(dist, "install.sh"))) return; // no bundle in this working tree
    for (const asset of REQUIRED) {
      expect(existsSync(join(dist, `${asset}.sha256`)), `${asset}.sha256 missing`).toBe(true);
    }
  });
});
