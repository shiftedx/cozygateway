import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NetworkOnboardingStateFile,
  parseNetworkOnboardingState,
  readBoundedNetworkOnboardingState,
} from "../src/onboarding-state.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateFile(options: { platform?: NodeJS.Platform; protect?: (path: string) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cozy-onboarding-state-"));
  roots.push(root);
  const localRoot = join(root, "local");
  mkdirSync(localRoot);
  return {
    root,
    localRoot,
    path: join(localRoot, "network-onboarding.json"),
    store: new NetworkOnboardingStateFile({
      localRoot,
      platform: options.platform ?? "linux",
      protectWindowsAcl: options.protect,
    }),
  };
}

describe("network onboarding resume projection", () => {
  it("writes a bounded schema through a closed sibling temp and atomic rename", async () => {
    const { localRoot, path, store } = stateFile();

    await store.write({
      version: 1,
      stage: "endpoint_ready",
      mode: "tailscale",
      deploymentFingerprint: "fingerprint-a",
      updatedAt: 42,
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      stage: "endpoint_ready",
      mode: "tailscale",
      deploymentFingerprint: "fingerprint-a",
      updatedAt: 42,
    });
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(localRoot).isDirectory()).toBe(true);
    expect(readFileSync(path).byteLength).toBeLessThanOrEqual(4_096);
    await expect((await import("node:fs/promises")).readdir(localRoot)).resolves.toEqual([
      "network-onboarding.json",
    ]);
  });

  it("requests Windows protection for the sibling temp and renamed destination", async () => {
    const protect = vi.fn<(path: string) => Promise<void>>(async () => undefined);
    const { path, store } = stateFile({ platform: "win32", protect });

    await store.write({ version: 1, stage: "pending_choice", updatedAt: 7 });

    expect(protect).toHaveBeenCalledTimes(2);
    expect(protect.mock.calls[0]![0]).not.toBe(path);
    expect(protect.mock.calls[0]![0]).toMatch(/network-onboarding\.json\..+\.tmp$/);
    expect(protect.mock.calls[1]![0]).toBe(path);
  });

  it("refuses a Windows write when no explicit ACL protector is available", async () => {
    const { store } = stateFile({ platform: "win32" });
    await expect(store.write({ version: 1, stage: "pending_choice", updatedAt: 7 }))
      .rejects.toThrow(/Windows ACL protector/i);
  });

  it("accepts only the exact bounded public projection schema", () => {
    expect(parseNetworkOnboardingState(JSON.stringify({
      version: 1,
      stage: "complete",
      mode: "lan",
      deploymentFingerprint: "f".repeat(128),
      verifiedAt: 12,
      updatedAt: 13,
    }))).toMatchObject({ stage: "complete", mode: "lan" });

    for (const forbidden of ["capability", "verificationUrl", "loginUrl", "accountIdentity", "setupCode", "deviceToken", "secret"]) {
      expect(() => parseNetworkOnboardingState(JSON.stringify({
        version: 1,
        stage: "pending_choice",
        updatedAt: 1,
        [forbidden]: "private-value",
      }))).toThrow(/schema/i);
    }
    expect(() => parseNetworkOnboardingState("x".repeat(4_097))).toThrow(/too large/i);
    expect(() => parseNetworkOnboardingState(JSON.stringify({
      version: 1,
      stage: "complete",
      mode: "tailscale",
      deploymentFingerprint: "x".repeat(129),
      verifiedAt: 1,
      updatedAt: 1,
    }))).toThrow(/schema/i);
  });

  it("rejects an out-of-root destination and a reparse-point parent", async () => {
    const first = stateFile();
    expect(() => new NetworkOnboardingStateFile({
      localRoot: first.localRoot,
      statePath: join(first.root, "outside.json"),
    })).toThrow(/outside/i);

    const second = stateFile();
    const actual = join(second.root, "actual");
    const linked = join(second.localRoot, "linked");
    mkdirSync(actual);
    symlinkSync(actual, linked, "junction");
    const store = new NetworkOnboardingStateFile({
      localRoot: second.localRoot,
      statePath: join(linked, "network-onboarding.json"),
      platform: "linux",
    });
    await expect(store.write({ version: 1, stage: "pending_choice", updatedAt: 1 }))
      .rejects.toThrow(/reparse|symbolic/i);
  });

  it("rejects an oversized or schema-invalid file instead of trusting it", async () => {
    const { path, store } = stateFile();
    writeFileSync(path, "x".repeat(4_097));
    await expect(store.read()).rejects.toThrow(/too large/i);
    writeFileSync(path, JSON.stringify({ version: 1, stage: "pending_choice", updatedAt: 1, capability: "raw" }));
    await expect(store.read()).rejects.toThrow(/schema/i);
  });

  it("reads no more than byte 4,097 even when the file grows or returns short reads", async () => {
    const source = Buffer.from("x".repeat(8_192));
    let largestPosition = 0;
    const reader = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        const bytesRead = Math.min(length, 37, source.length - position);
        source.copy(buffer, offset, position, position + bytesRead);
        largestPosition = Math.max(largestPosition, position + bytesRead);
        return { bytesRead };
      },
    };

    await expect(readBoundedNetworkOnboardingState(reader)).rejects.toThrow(/too large/i);

    expect(largestPosition).toBe(4_097);
  });
});
