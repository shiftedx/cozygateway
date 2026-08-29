import { describe, expect, it, vi } from "vitest";
import {
  WindowsHelperClient,
  WindowsHelperProtocolError,
  type WindowsHelperRunner,
} from "../src/windows-helper.ts";

const helper = "C:\\CozyGateway\\bin\\cozygateway-windows-helper.ps1";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function response(command: string, result: unknown): string {
  return JSON.stringify({ schemaVersion: 1, ok: true, command, result });
}

describe("WindowsHelperClient", () => {
  it("invokes the absolute fixed helper without a shell and parses its versioned envelope", async () => {
    const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: response("adapter-inventory", { schemaVersion: 1, adapters: [] }),
      stderr: "",
    });
    const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });

    await expect(client.adapterInventory()).resolves.toEqual({ schemaVersion: 1, adapters: [] });
    expect(runner).toHaveBeenCalledWith(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "adapter-inventory"],
      expect.objectContaining({ shell: false, windowsHide: true, stdin: "{}" }),
    );
  });

  it("parses bounded read-only Windows network profile and firewall posture", async () => {
    const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: response("inspect-network-safety", {
        networkCategory: "public", firewallEnabled: true, defaultInboundAction: "block",
      }),
      stderr: "",
    });
    const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });

    await expect(client.inspectNetworkSafety("{ADAPTER-ID}")).resolves.toEqual({
      networkCategory: "public", firewallEnabled: true, defaultInboundAction: "block",
    });
    expect(runner).toHaveBeenCalledWith(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "inspect-network-safety"],
      expect.objectContaining({ stdin: JSON.stringify({ adapterId: "{ADAPTER-ID}" }) }),
    );
  });

  it("rejects relative helper and PowerShell paths before spawning", () => {
    expect(() => new WindowsHelperClient({ helperPath: ".\\helper.ps1", powershellPath: powershell }))
      .toThrow(/fully qualified helper path/i);
    expect(() => new WindowsHelperClient({ helperPath: helper, powershellPath: "powershell.exe" }))
      .toThrow(/fully qualified PowerShell path/i);
  });

  it("rejects rooted-but-not-fully-qualified Windows executable paths everywhere", async () => {
    for (const path of ["\\helper.ps1", "/helper.ps1", "C:relative.ps1"]) {
      expect(() => new WindowsHelperClient({ helperPath: path, powershellPath: powershell }))
        .toThrow(/fully qualified helper path/i);
      expect(() => new WindowsHelperClient({ helperPath: helper, powershellPath: path }))
        .toThrow(/fully qualified PowerShell path/i);
    }

    for (const path of ["\\tailscale.exe", "/tailscale.exe", "C:tailscale.exe"]) {
      for (const result of [
        { state: "ready", cliPath: path, daemonPath: "C:\\Program Files\\Tailscale\\tailscaled.exe" },
        { state: "ready", cliPath: "C:\\Program Files\\Tailscale\\tailscale.exe", daemonPath: path },
      ]) {
        const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue({
          exitCode: 0,
          stdout: response("discover-tailscale", result),
          stderr: "",
        });
        const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });
        await expect(client.discoverTailscale()).rejects.toBeInstanceOf(WindowsHelperProtocolError);
      }
    }

    expect(() => new WindowsHelperClient({
      helperPath: "\\\\server\\share\\helper.ps1",
      powershellPath: "\\\\server\\share\\powershell.exe",
    })).not.toThrow();
  });

  it("rejects oversized, non-UTF-8, extra-key, wrong-command, and malformed command results", async () => {
    const cases: Array<Uint8Array | string> = [
      "x".repeat(65_537),
      Uint8Array.from([0xff]),
      JSON.stringify({ schemaVersion: 1, ok: true, command: "adapter-inventory", result: { schemaVersion: 1, adapters: [] }, extra: 1 }),
      response("discover-tailscale", { state: "absent", reason: "not_installed" }),
      response("adapter-inventory", { schemaVersion: 2, adapters: [] }),
    ];
    for (const stdout of cases) {
      const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue({ exitCode: 0, stdout, stderr: "" });
      const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });
      await expect(client.adapterInventory()).rejects.toBeInstanceOf(WindowsHelperProtocolError);
    }
  });

  it("sends only the fixed preference and browser request shapes", async () => {
    const calls: Array<{ command: string; input: unknown }> = [];
    const runner: WindowsHelperRunner = async (_file, args, options) => {
      const command = args.at(-1)!;
      calls.push({ command, input: JSON.parse(options.stdin) });
      return { exitCode: 0, stdout: response(command, { applied: true }), stderr: "" };
    };
    const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });
    await client.setPreference("unattended", true);
    await client.openBrowser("login", "https://login.tailscale.com/a/opaque");
    expect(calls).toEqual([
      { command: "set-preference", input: { preference: "unattended", enabled: true } },
      { command: "open-browser", input: { purpose: "login", url: "https://login.tailscale.com/a/opaque" } },
    ]);
  });

  it("surfaces a fixed helper reason without stderr or request secrets", async () => {
    const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({ schemaVersion: 1, ok: false, command: "open-browser", reason: "browser_url_rejected" }),
      stderr: "untrusted diagnostic https://login.tailscale.com/a/secret",
    });
    const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });
    await expect(client.openBrowser("login", "https://login.tailscale.com/a/secret"))
      .rejects.toThrow("browser_url_rejected");
  });

  it("rejects zero-exit failures and reasons outside the command contract", async () => {
    for (const result of [
      { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: false, command: "open-browser", reason: "browser_url_rejected" }), stderr: "" },
      { exitCode: 1, stdout: JSON.stringify({ schemaVersion: 1, ok: false, command: "open-browser", reason: "download_failed" }), stderr: "" },
      { exitCode: 0, stdout: response("discover-tailscale", { state: "paused", reason: "browser_url_rejected" }), stderr: "" },
    ]) {
      const runner = vi.fn<WindowsHelperRunner>().mockResolvedValue(result);
      const client = new WindowsHelperClient({ helperPath: helper, powershellPath: powershell, runner });
      const call = result.stdout.includes("discover-tailscale")
        ? client.discoverTailscale()
        : client.openBrowser("login", "https://login.tailscale.com/a/opaque");
      await expect(call).rejects.toBeInstanceOf(WindowsHelperProtocolError);
    }
  });
});
