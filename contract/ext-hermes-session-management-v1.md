# Hermes session management extension v1

Capability id: `com.cozylabs.hermes-session-management`

Version: `1`

This paired-device extension administers sessions owned by one visible Hermes profile. It is
separate from `com.cozylabs.hermes-desktop-sessions:2`, whose narrower promise remains TUI metadata
discovery and exact adoption into Bot Mode. A `hermesSessionId` is an opaque Hermes identifier and
MUST NOT be accepted by a Bot Mode route or returned in a Bot Mode `sessionId` field.

The gateway implementation maps these operations to Hermes' authoritative, profile-scoped
Dashboard session routes (`GET /api/sessions`, `GET /api/sessions/search`, detail/messages,
`PATCH /api/sessions/{id}`, and idempotent `DELETE /api/sessions/{id}`). It does not read Hermes'
SQLite database or introduce a generic session backend. The capability and device routes remain
absent until startup discovery verifies the pinned OpenAPI operations/query/body fields and bounded
live list/search envelopes; unreachable and older Hermes versions fail closed.

## Routes

Every route requires a paired-device bearer token. `:harnessId` and `:scopeId` must be an exact
currently configured, client-visible harness/profile pair.

| Route | Request | Success |
| --- | --- | --- |
| `GET /gateway/harnesses/:harnessId/scopes/:scopeId/sessions` | `limit=1...100`, `offset=0...100000`, `archived=exclude\|include\|only` | `HermesSessionListResponse` |
| `GET .../sessions/search` | required `q` (1...256 characters), `limit=1...100` | `HermesSessionSearchResponse` |
| `GET .../sessions/:hermesSessionId/messages` | `limit=1...200`, `offset=0...100000`, `order=oldest\|latest` | `HermesSessionMessagesResponse` |
| `PATCH .../sessions/:hermesSessionId` | one or more of `title` (0...100 characters), `archived`, `pinned` | `HermesSessionMutationResponse` |
| `DELETE .../sessions/:hermesSessionId` | no body | `204 No Content`; already absent is also success |
| `GET .../sessions/:hermesSessionId/export` | no body | streamed `application/json` object `{ session, messages }` |

Search preserves Hermes' compression-lineage semantics: `hermesSessionId` is the current tip and
`hermesLineageId` is the stable root. Branches remain distinct. A direct ID match has no
`matchedRole`; a content hit is returned only when Hermes identifies the matched row as `user` or
`assistant`. Search snippets are fixed labels (`Session ID match` / `Matching user message` /
`Matching assistant message`), not Hermes' FTS snippet: Hermes indexes tool-call columns too and
does not identify which indexed column matched.

## Privacy projection

The schemas are closed allow-lists. Session rows expose only Hermes identity/lineage, a sanitized
optional title, timestamps, message count, archive state, and pin state. Transcript rows expose only
rendered `user`/`assistant` text plus optional bounded row identity and timestamp.

The gateway MUST strip system rows, tool rows, tool arguments/results, reasoning/model blobs,
system prompts, working directories, absolute host paths, attachment path directives, and every
upstream field not named by these schemas. A transcript row marked `display_kind=hidden` is omitted.
When Hermes provides `display_content` for a compaction carrier, only that display projection is
eligible for sanitization; the raw carrier is never a fallback. Search results whose matched role is
`system`, `tool`, or unknown are omitted. Errors are fixed gateway prose and never include upstream
messages or paths.
Message pagination returns a physical-row `nextOffset`; omitted system/tool rows still advance it,
so a client neither duplicates visible rows nor loops over a privacy-filtered page.

List/search/message counts and offsets are bounded before Hermes is called. Each upstream JSON body
is capped before parsing, and any messages envelope larger than its requested limit or 200 physical
rows is rejected. Export is assembled from bounded, oldest-first projected message pages;
it never forwards Hermes' raw export. The stream is capped at 10,000 physical messages and 25 MiB,
propagates cancellation upstream, and uses `Cache-Control: private, no-store` plus
`X-Content-Type-Options: nosniff`.

## Mutation consistency

Writes serialize per profile. Before mutation the gateway rereads the exact full Hermes id; after a
successful PATCH it rereads and returns the authoritative row. DELETE rereads until absence is
confirmed and remains idempotent when the row was already absent.

A timeout after a mutation may mean Hermes committed after the gateway stopped waiting. That case
is `503 backend_unavailable` with `refreshRequired: true`; a client MUST refresh authoritative state
before retrying or restoring optimistic UI. All destructive client UI MUST require explicit user
confirmation before sending DELETE.
