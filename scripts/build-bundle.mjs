#!/usr/bin/env node
// Build the single-file gateway bundle the simple-install track ships.
// Input: packages/gateway/dist/cli.js (run `pnpm build` first).
// Output: dist-bundle/cozygateway.mjs + .sha256 (the exact names
// scripts/install.sh downloads from a GitHub Release).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

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
console.log(`bundled ${(body.length / 1024 / 1024).toFixed(1)}MB, sha256 ${sha}`);
