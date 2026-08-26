import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { GATEWAY_VERSION } from "../src/server.ts";

/**
 * The release workflow refuses to publish unless the tag, the gateway package version and the
 * plugin manifest version all agree, and it checks that only after a tag has already been pushed.
 * v0.2.7 and v0.2.8 were both burned that way: tagged, failed, and left behind as public tags
 * pointing at commits that were never released. This catches the drift on the pull request that
 * causes it, which is the last moment it costs nothing.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages/gateway/package.json"), "utf8"));
  return manifest.version;
}

function pluginVersion(): string {
  const manifest = readFileSync(join(ROOT, "integrations/attach-plugin/plugin.yaml"), "utf8");
  const version = manifest.match(/^version:\s*(\S+)$/m)?.[1];
  if (version === undefined) throw new Error("plugin.yaml has no version");
  return version;
}

describe("the three places a release version is written", () => {
  it("agree, so a tag cannot fail its own version check", () => {
    expect(GATEWAY_VERSION).toBe(packageVersion());
    expect(pluginVersion()).toBe(packageVersion());
  });

  it("are all a plain semantic version", () => {
    for (const version of [GATEWAY_VERSION, packageVersion(), pluginVersion()]) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
