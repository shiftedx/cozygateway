# Locked harness workspace extension v1

Capability id: `com.cozylabs.harness-workspace`

Version: `1`

This paired-device extension exposes a read-only projection of one Hermes managed-files root. A
gateway MUST NOT advertise it until Hermes reports both a non-null `locked_root` and
`can_change_path: false`. The root value is an internal proof only and never crosses this wire.

## Routes

Both routes require a paired-device bearer token. `:harnessId` and `:scopeId` must be an exact
currently configured harness/scope pair. No write method exists.

| Route | Request | Success response |
| --- | --- | --- |
| `GET /gateway/harnesses/:harnessId/scopes/:scopeId/workspace?path=<relative>` | `path` omitted means root | `HarnessWorkspaceList` |
| `GET /gateway/harnesses/:harnessId/scopes/:scopeId/workspace/download?path=<relative>` | optional single `Range: bytes=…` | streamed bytes |

Paths use `/` separators and are relative to the locked root. Absolute paths, backslashes, empty,
`.` or `..` segments, NUL, segments over 255 UTF-8 bytes, and paths over 4096 UTF-8 bytes are
invalid. Credential/config/pairing/MCP-token names and trees are inaccessible and absent from
listings. Entries expose only relative paths, names, kind, bounded size, MIME metadata, and a Unix
millisecond modification time.

Downloads are attachments with `X-Content-Type-Options: nosniff`, `Cache-Control: private,
no-store`, a sanitized `Content-Disposition`, and at most 100 MiB. Only one RFC 9110 byte range is
accepted and its response is capped at 16 MiB. The implementation bounds concurrent streams and
requests per paired device, propagates cancellation upstream, and sanitizes all upstream failures.

The extension is not a generic filesystem proxy. In particular, it never forwards `/api/fs`, never
accepts an absolute path, and exposes no read-text, upload, mkdir, rename, delete, or write verb.
