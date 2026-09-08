# Guided Windows model setup

The Windows one-liner remains a terminal experience. Setup explains its progress,
uses numbered choices and detects model settings whenever supported. It does not
require a browser or native wizard. macOS and Linux installers are out of scope.

Explicit environment configuration and valid saved runner settings take priority
and preserve unattended updates. Fresh interactive setup discovers running local
OpenAI-compatible servers on known loopback ports and reads saved Pi model
preferences/catalogs. Multiple choices need a numbered selection; known models
must not require typing identifiers. Cached model data is described as saved,
not proof that the provider is currently reachable or authenticated.

Discovery is bounded and read-only. Endpoint responses are validated before
display or persistence. Credentials are never printed or sent for discovery.
Sharing existing host credentials requires an explicit explanation and consent.
Unavailable discovery offers understandable recovery and manual entry.

The existing verified downloads, session handoff, transactional Gateway update,
component recovery, model persistence and pairing behavior remain intact.

Validation uses PowerShell 5.1 and 7, isolated model/server fixtures, and the
Windows installer regression suite. Real user accounts and model servers are
not test fixtures.
