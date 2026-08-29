import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

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

const REQUIRED = [
  "cozygateway.mjs",
  "cozygateway-hermes-attach-plugin.tar.gz",
  "cozygateway-installer.sh",
  "install.ps1",
  "install.sh",
  "cozygateway-windows-helper.ps1",
];

describe("what a release publishes", () => {
  it("uploads every asset, and a checksum beside each one", () => {
    for (const asset of REQUIRED) {
      expect(WORKFLOW, `${asset} is not uploaded by release.yml`).toContain(`dist-bundle/${asset}\n`);
      expect(WORKFLOW, `${asset} ships with no checksum`).toContain(`dist-bundle/${asset}.sha256`);
    }
  });

  it("builds both one-liner bootstraps, not just the Windows one", () => {
    expect(BUNDLER).toContain('"dist-bundle/install.ps1"');
    expect(BUNDLER).toContain('"dist-bundle/install.sh"');
    expect(BUNDLER).toContain('"dist-bundle/cozygateway-windows-helper.ps1"');
  });

  it("checksums whatever it built, if a bundle is present", () => {
    const dist = join(ROOT, "dist-bundle");
    if (!existsSync(join(dist, "install.sh"))) return; // no bundle in this working tree
    for (const asset of REQUIRED) {
      expect(existsSync(join(dist, `${asset}.sha256`)), `${asset}.sha256 missing`).toBe(true);
    }
  });
});
