import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Gather licenses from the exact dependency files esbuild consumed. Missing notices fail closed. */
export function thirdPartyNotices(metafiles, root = process.cwd()) {
  const packages = new Map();
  const missing = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
      let directory = dirname(resolve(root, input));
      while (directory !== dirname(directory)) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest)) {
          const pkg = JSON.parse(readFileSync(manifest, "utf8"));
          if (pkg.name && pkg.version) {
            const files = readdirSync(directory).filter((name) => /^(licen[sc]e|copying|notice)([.-].*)?$/i.test(name)).sort();
            if (!files.some((name) => /^(licen[sc]e|copying)/i.test(name))) {
              missing.add(`${pkg.name}@${pkg.version}`);
              break;
            }
            packages.set(`${pkg.name}@${pkg.version}`, files.map((name) => `${name}\n${readFileSync(join(directory, name), "utf8").trim()}`).join("\n\n"));
            break;
          }
        }
        directory = dirname(directory);
      }
    }
  }
  if (missing.size) throw new Error(`Missing license texts for bundled dependencies: ${[...missing].sort().join(", ")}`);
  const own = ["LICENSE"]
    .map((file) => `${file}\n${readFileSync(join(root, file), "utf8").trim()}`);
  return ["CozyGateway and bundled third-party notices", ...own,
    ...[...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `${name}\n${license}`)]
    .join("\n\n----------------------------------------\n\n") + "\n";
}
