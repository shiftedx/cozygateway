# Contributing

Open an issue to discuss a substantial change before implementing it. Keep pull requests focused,
include tests for behavior changes, and run `pnpm check` with Node 24 before requesting review.

The public wire contract is compatibility-sensitive. Changes to its schemas or documented behavior
need explicit migration and conformance coverage. Never commit credentials, pairing data, local
database files, or generated release artifacts.

## Releases

A tag is a promise to every installed gateway, because `install.sh` and `cozygateway repair`
resolve `releases/latest` and record the tag they came from. Tags are never deleted or moved.

- Batch fixes and cut at most one tag per day. The exception is a fix for a broken client install,
  which ships as soon as it is verified.
- Bump `packages/gateway/package.json`, `integrations/attach-plugin/plugin.yaml`, and
  `GATEWAY_VERSION` together; the release workflow refuses a tag that disagrees with them.
- Before tagging, run `pnpm check` and `pnpm test:installer` locally. Pushing the tag runs them
  again, builds and attests the bundle, and publishes the release.
- Write the release notes for the person running a gateway: what changed for them, then what they
  should do. Link the PRs; do not paste the PR list as the notes. Add the series summary to
  `CHANGELOG.md` in the same PR.
- After publishing, mark the previous release as pre-release so the releases page shows one
  "Latest" and `releases/latest` stays unambiguous.
