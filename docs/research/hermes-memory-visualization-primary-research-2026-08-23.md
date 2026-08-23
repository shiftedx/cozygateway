# Hermes memory visualization: primary-source research

**Scope.** This note answers how CozyChat/Gateway can give a human a
per-bot, searchable, editable view of Hermes memories without pretending that
all providers have the same data model. It uses only the current upstream
Hermes Agent source and official Hermes documentation, pinned to upstream
commit `981101239a064c020a9d18fc3b1060ae306934ed` (the installed
`Hermes Agent v0.20.5` reports that commit). It does not propose changes to
Hermes or any product code.

## Executive conclusion

Build a **Memory** area at the bot level, not a single cross-bot “facts”
database. Every bot page should show a provider-aware overview, then expose
two first-class source types when they exist:

1. **Curated files** — Hermes' always-on `MEMORY.md` and `USER.md`, displayed
   as individual entries/cards and edited through their validated memory
   semantics.
2. **Holographic facts** — SQLite facts, entities, trust and retrieval
   signals, searched and edited through a Holographic-specific adapter.

The app can provide one consistent shell (search, source filters, activity,
history, edit/review UI), but it must not flatten external provider data into
an invented common “fact” model. Upstream permits exactly one external memory
provider per profile while built-in files remain additive, and each provider
defines its own tools, metadata and lifecycle.

For Cleo specifically, a non-mutating `hermes --profile cleo memory status`
check on 2026-08-23 reports built-in memory enabled and `holographic` as the
active external provider. Her profile has the expected profile-scoped
`memories/MEMORY.md`, `memories/USER.md`, and `memory_store.db` artifacts.
This is the ideal first supported configuration.

There is one actionable health finding for Cleo: the active upstream
Holographic plugin reads its settings from
`plugins.hermes-memory-store`, exactly as the official provider documentation
specifies, but Cleo's existing configuration puts Holographic settings under
`plugins.holographic`. That means values such as `auto_extract` and
`default_trust` may currently be ignored while the provider itself still
loads. The future overview must validate the active provider's **canonical
configuration namespace** and surface this as a configuration-health warning;
do not silently report configured behavior that Hermes is not using.

## What upstream Hermes actually provides

| Layer | Storage and scope | What a human can see/manage today | Implication for Cozy |
|---|---|---|---|
| Built-in curated memory | `$HERMES_HOME/memories/MEMORY.md` and `USER.md`; one profile/Hermes home | Bounded, §-delimited entries; add/replace/remove through `memory`; journey graph/card view and edit/delete are already upstream concepts | Provide entry cards, exact source labels, usage meter and a “takes effect next session” note |
| Holographic | `$HERMES_HOME/memory_store.db` by default (configurable) | Structured facts with IDs, category, tags, trust, timestamps, helpful/retrieval counts, entity links, FTS5 and optional HRR vectors | Provide a facts table/list plus entity and relationship views; use fact ID as the stable UI key |
| Other external provider | Provider-defined local/remote storage and tools | Hermes can configure one at a time; tool schemas/lifecycles differ | Show a provider-specific read-only/status surface until a dedicated adapter exists; never scrape unknown storage |

**Provider model.** The upstream `MemoryManager` admits the built-in provider
plus at most one non-built-in provider, explicitly rejecting a second external
provider to avoid conflicting backends and tool bloat. The provider contract
supplies lifecycle hooks, prompt context, prefetch, persistence, provider tool
schemas, and optional session/compaction/memory-write hooks. That means the
correct integration seam is a **Cozy memory-source adapter per provider**, not
one generic SQL/filesystem reader. [Memory manager source][memory-manager]
[provider contract][provider-contract]

**Profile isolation.** Hermes documents local Holographic storage as an
`$HERMES_HOME` path and says profile homes isolate provider state. A Cozy API
must therefore always require a bot/profile identifier and resolve every
source beneath that profile; it must never search a shared global path by
default. [Provider documentation][provider-docs]

### Built-in `MEMORY.md` and `USER.md`

These are curated, prompt-injected memories—not an arbitrary Obsidian vault.
Upstream splits them into entries with a `§` delimiter, bounds `MEMORY.md` to
2,200 characters and `USER.md` to 1,375 by default, rejects exact duplicate
entries, and refuses writes that exceed the budget rather than silently
truncating. [Persistent-memory documentation][persistent-memory]

The memory tool's storage implementation also protects mutations with a file
lock, atomic replacement, injection/exfiltration scanning, and drift/read
failure checks. It deliberately keeps the prompt snapshot frozen for the
active session: a successful file edit is durable immediately, but is loaded
into the system prompt at the next session start. [Built-in storage source][memory-tool]

Upstream already has a useful visual metaphor: `hermes journey`/`/journey`
builds a timeline/graph of built-in memory cards and learned skills; memory
node IDs are `memory:<source>:<index>` and its edit/delete commands operate on
the individual `§` chunks. Crucially, that graph reads only `MEMORY.md` and
`USER.md`; it does **not** show Holographic facts. It is a good interaction
reference, but not a complete multi-provider solution. [Learning graph][learning-graph]
[Journey mutations][journey-mutations]

### Holographic facts

Holographic is a local SQLite provider with FTS5, trust scoring and optional
HRR algebra. Its upstream schema has:

- `facts`: stable `fact_id`, content, `category`, comma-separated `tags`,
  `trust_score`, retrieval/helpful counts, creation/update timestamps and an
  optional HRR vector;
- `entities` plus a `fact_entities` join table;
- FTS5 `facts_fts` maintained by insert/update/delete triggers; and
- category-level `memory_banks` when NumPy/HRR is available.

Facts are unique by content. The store exposes add, full-text list/search,
update, remove and feedback; content edits rebuild entity links and the
relevant HRR bank. Helpful feedback raises trust by 0.05; unhelpful feedback
lowers it by 0.10, clamped to 0–1. [Holographic store][holographic-store]

The model-facing interface is deliberately richer than basic keyword search:
`fact_store` supports `add`, `search`, `probe`, `related`, `reason`,
`contradict`, `update`, `remove`, and `list`; `fact_feedback` records
helpful/unhelpful outcomes. Search uses FTS candidates, Jaccard reranking,
trust weighting and optional temporal decay. With NumPy unavailable, the
algebraic entity operations fall back to keyword search. [Holographic
provider][holographic-provider] [Holographic retrieval][holographic-retrieval]

Holographic prefetches up to five matching facts before a turn and can
auto-extract only at session end when `auto_extract` is enabled. The built-in
files remain active alongside it, and built-in **add** writes may be mirrored
to Holographic. Do not call the resulting records duplicates: they are
different source systems with different lifecycle semantics. [Holographic
provider][holographic-provider]

## Recommended Cozy product shape

### Bot-level information architecture

Add `Memory` to each bot's detail/navigation surface. The top summary is
compact and truthful:

```
Cleo › Memory
Built-in notes + Holographic facts                 Last refreshed just now
[Notes 12] [Profile 7] [Facts 286] [Entities 53] [Pending 0]
Search this bot's memory…                         Source  Type  Trust  Updated
```

Below it, use source-specific tabs (or chips) rather than a giant page title:

- **All** — blended search results, but every result keeps a conspicuous
  `Notes`, `Profile`, or `Holographic` source badge.
- **Notes** — cards for `MEMORY.md`; supports entry-level inspect, edit,
  delete, and capacity management.
- **Profile** — equivalent cards for `USER.md`, separated because it has a
  different purpose and budget.
- **Facts** — Holographic fact list with trust, category, tags, entities,
  retrieval count and timestamps. Search/filter by text, entity, category,
  trust band, and updated period.
- **Relationships** — only for Holographic: entity-to-fact graph/list and
  `related`/multi-entity `reason` results. Make it an optional exploration
  view, not the default for a user trying to find one fact.
- **Activity** — explicit human edits and agent/background changes. This is a
  Cozy audit log, because neither built-in `MEMORY.md` nor the Holographic
  schema provides sufficient first-class human audit provenance on its own.

The bot selector is the privacy boundary. A global *search across my bots*
can be a later opt-in convenience that returns a bot name and source badge for
every match; its default must be off, because profiles intentionally isolate
memory.

### Backend contract to design before UI

Use a narrow, provider-aware read/write API. Suggested neutral envelope:

```text
GET  /v1/bots/:botId/memory/overview
GET  /v1/bots/:botId/memory/search?q=&source=&cursor=
GET  /v1/bots/:botId/memory/sources/:source/items/:id
PATCH /v1/bots/:botId/memory/sources/:source/items/:id  (If-Match revision)
DELETE /v1/bots/:botId/memory/sources/:source/items/:id (If-Match revision)
POST /v1/bots/:botId/memory/sources/:source/items
```

Each returned item should keep source-native data under `attributes`, while
the shared envelope has only:

```json
{
  "id": "holographic:fact:42",
  "source": "holographic",
  "kind": "fact",
  "title": "…",
  "snippet": "…",
  "updatedAt": "…",
  "revision": "…",
  "attributes": { "trustScore": 0.8, "category": "project", "tags": ["gateway"] }
}
```

`MEMORY.md`/`USER.md` adapters should present a stable Cozy entry ID plus a
revision derived from the full source snapshot and item content. Holographic
items should use the upstream `fact_id` plus `updated_at` (and, ideally, a
returned content hash) as the optimistic-concurrency revision. The UI should
not expose SQL, arbitrary file paths, or raw HRR vectors.

### Safe mutation policy

1. **Read fresh, then conditional write.** Reject stale revisions with a
   refresh/compare view; never last-writer-wins an agent's concurrent change.
2. **Use source-native mutation paths.** Built-in writes must preserve the
   upstream delimiter, limits, lock, atomic write, safety scan and drift
   protection. Holographic edits must use a transaction-aware provider adapter
   so entity links, FTS and HRR banks remain coherent. Do not have the app
   write Markdown or SQLite files directly.
3. **Human intent is authority, but destructive actions are explicit.** A
   human's save can commit immediately; delete requires confirmation and
   offers undo where Cozy has an audit snapshot. Agent-originated writes may
   continue to use Hermes' existing approval/pending model for built-in
   memory. [Persistent-memory write approval][persistent-memory]
4. **State the visibility timing.** After a built-in file edit, label it
   “saved; active in Cleo’s next session,” because upstream intentionally
   freezes the current prompt snapshot. A Holographic edit can influence a
   subsequent prefetch/turn, but never rewrite text already streamed to the
   user.
5. **Do not edit provider configuration from the viewer.** Showing active
   provider, safe config summaries and storage health is useful; provider
   selection and credentials belong in explicit bot settings with a restart
   plan. Hermes’ one-external-provider rule makes a switch a migration
   decision, not a filter toggle.

### Implementation sequencing

1. Ship a read-only bot Memory overview for the built-in files and
   Holographic provider, including provider detection and redacted health.
2. Add unified, source-labelled search; use Holographic's native search and
   built-in entry matching rather than an early duplicate index.
3. Add built-in entry edits through a controlled Hermes-facing adapter and
   Holographic fact CRUD/feedback through its provider-aware adapter, all with
   revisions and Cozy audit events.
4. Add entities/relationships and the cross-bot search opt-in only after the
   core source-of-truth and conflict behavior are proven.

This ordering gives Cleo’s “Markdown + Holographic” setup a genuinely useful
human interface without creating a speculative abstraction that cannot serve
other providers faithfully.

## Important gaps and non-goals

- Hermes currently has no provider-neutral REST administration API for listing
  and mutating every provider's records. Its generic contract is for agent
  lifecycle/context/tools; provider-specific admin capabilities are not part
  of that interface. Cozy must add adapters deliberately, beginning with the
  two local sources it can verify.
- `hermes journey` is not a Holographic fact visualizer. Reusing its visual
  language is reasonable, relying on its data payload for all memory is not.
- An Obsidian vault or Markdown mirror is not automatically an editable source
  of truth. If Cleo maintains a vault export, treat it as a **derived,
  read-only mirror** unless its exporter specifies safe reverse sync; editing
  the vault blindly can diverge it from `memory_store.db`.
- Do not make “AI-generated memory is correct” a product assumption. Trust,
  feedback, contradiction review, source labels and a change history are the
  right human controls.

## Primary sources

- [Persistent Memory — official Hermes docs][persistent-memory]
- [Memory Providers — official Hermes docs][provider-docs]
- [Memory provider contract — upstream source][provider-contract]
- [Memory manager — upstream source][memory-manager]
- [Built-in memory store — upstream source][memory-tool]
- [Holographic provider — upstream source][holographic-provider]
- [Holographic SQLite store — upstream source][holographic-store]
- [Holographic retrieval — upstream source][holographic-retrieval]
- [Learning graph — upstream source][learning-graph]
- [Journey mutations — upstream source][journey-mutations]

[persistent-memory]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/website/docs/user-guide/features/memory.md
[provider-docs]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/website/docs/user-guide/features/memory-providers.md
[provider-contract]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/agent/memory_provider.py
[memory-manager]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/agent/memory_manager.py
[memory-tool]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/tools/memory_tool.py
[holographic-provider]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/plugins/memory/holographic/__init__.py
[holographic-store]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/plugins/memory/holographic/store.py
[holographic-retrieval]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/plugins/memory/holographic/retrieval.py
[learning-graph]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/agent/learning_graph.py
[journey-mutations]: https://github.com/NousResearch/hermes-agent/blob/981101239a064c020a9d18fc3b1060ae306934ed/agent/learning_mutations.py
