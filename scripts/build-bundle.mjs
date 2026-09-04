#!/usr/bin/env node
// Build the single-file gateway bundle the simple-install track ships.
// Input: packages/gateway/dist/cli.js (run `pnpm build` first).
// Output: dist-bundle/cozygateway.mjs + .sha256 (the exact names
// scripts/install.sh downloads from a GitHub Release).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const entry = "packages/gateway/dist/cli.js";
if (!existsSync(entry)) {
  console.error(`build-bundle: ${entry} not found; run 'pnpm build' first`);
  process.exit(1);
}
mkdirSync("dist-bundle", { recursive: true });

// cli.js only invokes runCli() when process.argv[1] ends with "cli.js"/"cli.ts" (see its
// invokedDirectly check). The bundle ships as cozygateway.mjs, so that guard never fires if we
// bundle cli.js directly -- the process would load and exit 0 silently. A tiny wrapper entry that
// imports the real runCli and calls it unconditionally sidesteps the guard without touching gateway
// source, and esbuild bundles it away to nothing extra.
const wrapperEntry = resolve("dist-bundle/.bundle-entry.mjs");
writeFileSync(
  wrapperEntry,
  `import { runCli } from ${JSON.stringify(resolve(entry))};
runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
`,
);
await build({
  entryPoints: [wrapperEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist-bundle/cozygateway.mjs",
  // ws optionally requires these native accelerators; without them it
  // falls back to pure JS, which is fine for a single-user gateway.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // CJS deps inside an ESM bundle still call require/__dirname.
    js: "import { createRequire as __cgwCreateRequire } from 'node:module';\nconst require = __cgwCreateRequire(import.meta.url);",
  },
});
rmSync(wrapperEntry, { force: true });
const body = readFileSync("dist-bundle/cozygateway.mjs");
const sha = createHash("sha256").update(body).digest("hex");
writeFileSync("dist-bundle/cozygateway.mjs.sha256", `${sha}  cozygateway.mjs\n`);

// The Hermes plugin is a complete, version-matched release artifact.  The
// installer verifies this archive before placing its contents under each
// selected Hermes profile; source-only caches and bytecode are deliberately
// absent so the artifact is deterministic and contains no local machine state.
const pluginArchive = "dist-bundle/cozygateway-hermes-attach-plugin.tar.gz";
const archive = spawnSync(
  "tar",
  [
    "-czf", pluginArchive,
    "--exclude=__pycache__", "--exclude=.pytest_cache", "--exclude=.venv-test",
    "-C", "integrations", "attach-plugin",
  ],
  { encoding: "utf8" },
);
if (archive.status !== 0) {
  console.error(`build-bundle: could not create attach plugin archive: ${archive.stderr || archive.error}`);
  process.exit(1);
}

// Ship the exact installer payload as a release asset too. The curl bootstrap
// verifies it before executing it, rather than trusting a mutable raw branch.
const installer = "dist-bundle/cozygateway-installer.sh";
writeFileSync(installer, readFileSync("scripts/agent-install.sh"), { mode: 0o700 });
const supervisor = "dist-bundle/gateway-supervisor.cjs";
writeFileSync(supervisor, readFileSync("scripts/gateway-supervisor.cjs"), { mode: 0o700 });
const windowsBootstrap = "dist-bundle/install.ps1";
writeFileSync(windowsBootstrap, readFileSync("scripts/install.ps1"));
// The POSIX bootstrap ships as a release asset for the same reason the Windows one does: what a
// person pipes into a shell should be bytes somebody signed off on at a version, not whatever the
// branch says this minute. Serving it from a release is what lets the checksum mean anything.
const posixBootstrap = "dist-bundle/install.sh";
writeFileSync(posixBootstrap, readFileSync("scripts/install.sh"), { mode: 0o700 });
for (const asset of [pluginArchive, installer, supervisor, windowsBootstrap, posixBootstrap]) {
  const assetSha = createHash("sha256").update(readFileSync(asset)).digest("hex");
  writeFileSync(`${asset}.sha256`, `${assetSha}  ${asset.split("/").at(-1)}\n`);
}
console.log(`bundled ${(body.length / 1024 / 1024).toFixed(1)}MB, sha256 ${sha}`);
