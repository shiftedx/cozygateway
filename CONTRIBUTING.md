# Contributing

Open an issue to discuss a substantial change before implementing it. Keep pull requests focused,
include tests for behavior changes, and run `pnpm check` with Node 24 before requesting review.

The public wire contract is compatibility-sensitive. Changes to its schemas or documented behavior
need explicit migration and conformance coverage. Never commit credentials, pairing data, local
database files, or generated release artifacts.
