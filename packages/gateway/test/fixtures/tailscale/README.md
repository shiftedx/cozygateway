# Sanitized Tailscale CLI fixtures

These fixtures model public CLI JSON fields documented by Tailscale's `ipnstate.Status`,
`version.Meta`, `get --json`, `up --json`, and `ServeConfig` command implementations. All
identities, node IDs, domains, URLs, and targets are synthetic. `login-oversized.json` is a recipe
for generating the labeled 65,537-byte field without committing a large inert blob.
