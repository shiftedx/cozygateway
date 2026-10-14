# Agent instructions

This is a public repository. Everything committed here is published permanently, including
history. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CONTEXT.md](CONTEXT.md) for project rules
and vocabulary.

## Keep work product out of the repo

Plans, specs, handoffs, task reports, reviews, evidence logs, and scratch files stay outside the
tracked tree. Write them to your session scratch directory or an ignored path
(`.superpowers/`, `docs/plans/`, `docs/handoffs/`, `docs/superpowers/`, `docs/evidence/`).
CI fails if any of these are tracked. Durable decisions belong in `docs/adr/`; user-facing
behavior belongs in the docs under `docs/` and in `CHANGELOG.md`.

## Never commit private details

- Real hostnames, domains, IPs, SSH targets, ports, or paths of any live deployment. Use
  `gateway.example.com`, `operator@gateway-host`, `/home/operator/...`, and `127.0.0.1`.
- Local machine paths (`/Users/<name>/...`, `C:\Users\<name>\...`, temp or worktree paths).
- Real profile, bot, device, or runner names from the maintainer's setup, and which models or
  providers the maintainer uses.
- Tokens, keys, or passwords, even expired ones. Test fixtures must be obviously fake.
- Code or internals from other private repositories.

Test fixtures and comments refer to "the user" or "the operator", not to a person by name.

## Before you push

Run `pnpm check`. For changes under `integrations/attach-plugin`, also run
`PYTHONPATH=integrations/attach-plugin python3 -m unittest discover -s integrations/attach-plugin/tests`.
Run `git diff --cached` and read it as a stranger would: if a line only makes sense on the
maintainer's machine, take it out.
