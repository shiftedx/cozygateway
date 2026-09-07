import { validateObservationSnapshotRecord, isObservationToolName, validateObservationSnapshotPayload, OBSERVATION_SNAPSHOT_MAX_BYTES, type ObservationSnapshotPayload } from "./snapshot.ts";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  identityHash,
  isAllowedEventKind,
  isAllowedSeries,
  isIdentityHash,
  isStorableValue,
  serializeDetail,
  type ObserveDetail,
} from "./privacy.ts";

/** One aggregate over a window, always with the number of samples it was computed from.
 *
 *  Section 11: "every aggregate shows its sample count". A p95 over four samples is not a p95, and a
 *  caller that cannot see the count cannot know that. `p50` and `p95` are undefined exactly when
 *  `count` is zero, so a reader never has to invent a meaning for a placeholder number. */
export interface ObserveSummary {
  count: number;
  p50: number | undefined;
  p95: number | undefined;
  min: number | undefined;
  max: number | undefined;
}

export interface ObserveSeriesRow {
  series: string;
  bot: string | null;
  at: number;
  value: number;
}

export interface ObserveEventRow {
  at: number;
  kind: string;
  bot: string | null;
  ref: string | null;
  detailJson: string | null;
}

/** Rows removed in one statement of the trim, and how many statements one pass will run.
 *
 *  `node:sqlite` is synchronous and the trim runs on the gateway's event loop, so an unbounded
 *  DELETE is a stall the length of whatever it finds. In steady state an hourly pass removes an
 *  hour of rows and neither bound is reached; they exist for the day an operator lowers
 *  `retentionDays` from a year to a week and the first pass would otherwise delete 358 days of rows
 *  in one statement. Reaching the cap simply leaves the rest for the next pass. */
const TRIM_BATCH_ROWS = 5_000;
const TRIM_BATCHES_PER_PASS = 20;

/** Nearest rank percentile over an already sorted ascending array. Nearest rank rather than a linear
 *  interpolation because every value in this ring is a real measurement: reporting a duration
 *  nothing ever measured, however plausibly interpolated, is the derived-as-measured mistake
 *  section 11 forbids. */
function nearestRank(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** `_` and `%` are LIKE wildcards and every series name contains an underscore, so
 *  `series LIKE 'turn_ms|%'` would also match `turnXms|lan`. Harmless while every caller passes a
 *  member of a closed enum and not harmless the moment D3 passes a query parameter, so the prefix is
 *  escaped and the statement declares its escape character. */
const LIKE_ESCAPE = "\\";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

/** The durable half of the observation ring: two capped tables, the privacy rule that decides what
 *  may enter them, and the read helpers D3 charts from.
 *
 *  THE PRIVACY RULE LIVES HERE, at the last line before SQLite, not at the call sites. Every writer
 *  in the gateway funnels through `sample` and `event`, and a row that fails the rule is refused and
 *  counted rather than scrubbed and written: a partially redacted row would invite a reader to trust
 *  the fields that survived.
 *
 *  The rule is an allowlist with no free string in it. `series` and `kind` come from closed enums,
 *  `bot` and `ref` are 16 hex identity hashes or null and nothing else, and `detail_json` is checked
 *  against its kind's own closed schema. */
export class ObserveStore {
  readonly #db: DatabaseSync;
  #identityKey: string | undefined;
  #refused = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Rows this store declined to write because they failed the privacy or shape rule. A test asserts
   *  it is zero after exercising the real writers; a nonzero count in production is a bug in a call
   *  site, never an expected outcome. */
  get refused(): number {
    return this.#refused;
  }

  /** This gateway's identity key, minted once and kept in its own database.
   *
   *  Per gateway and durable, so a bot hashes to the same value across restarts (a chart survives a
   *  restart) and to a different value on a different gateway (two exports cannot be joined by
   *  guessing a name). Nothing outside this process ever needs it, and nothing writes it anywhere
   *  else. */
  #key(): string {
    if (this.#identityKey !== undefined) return this.#identityKey;
    const existing = this.#db
      .prepare("SELECT key FROM observe_identity WHERE id = 1")
      .get() as unknown as { key: string } | undefined;
    if (existing !== undefined) {
      this.#identityKey = existing.key;
      return existing.key;
    }
    const minted = randomBytes(32).toString("hex");
    this.#db
      .prepare("INSERT OR IGNORE INTO observe_identity (id, key) VALUES (1, ?)")
      .run(minted);
    const stored = this.#db
      .prepare("SELECT key FROM observe_identity WHERE id = 1")
      .get() as unknown as { key: string };
    this.#identityKey = stored.key;
    return stored.key;
  }

  /** Turns any identifier into the value the ring stores for it. The only way a caller gets a legal
   *  `bot` or `ref`, and therefore the only way an identifier reaches a row. D3 calls this on the
   *  names it already knows to look a chart up. */
  identify(value: string): string {
    return identityHash(this.#key(), value);
  }

  /** Writes one sample. Returns false when the row was refused, so a caller that cares (a test, the
   *  fuzz check) can see it; the gateway's hot paths ignore the result on purpose, because a refused
   *  metric must never change what a turn does. */
  sample(series: string, bot: string | null, at: number, value: number): boolean {
    if (!isAllowedSeries(series) || !isStorableValue(value) || !Number.isFinite(at)) {
      this.#refused += 1;
      return false;
    }
    if (bot !== null && !isIdentityHash(bot)) {
      this.#refused += 1;
      return false;
    }
    this.#db
      .prepare("INSERT INTO observe_series (series, bot, at, value) VALUES (?, ?, ?, ?)")
      .run(series, bot, Math.trunc(at), value);
    return true;
  }

  /** Writes one event marker. `bot` and `ref` are identity hashes and nothing else. */
  event(
    kind: string,
    at: number,
    bot: string | null,
    ref: string | null,
    detail?: ObserveDetail,
  ): boolean {
    const detailJson = serializeDetail(kind, detail);
    if (!isAllowedEventKind(kind) || !Number.isFinite(at) || detailJson === undefined) {
      this.#refused += 1;
      return false;
    }
    if ((bot !== null && !isIdentityHash(bot)) || (ref !== null && !isIdentityHash(ref))) {
      this.#refused += 1;
      return false;
    }
    this.#db
      .prepare("INSERT INTO observe_events (at, kind, bot, ref, detail_json) VALUES (?, ?, ?, ?, ?)")
      .run(Math.trunc(at), kind, bot, ref, detailJson);
    return true;
  }

  /** Deletes everything older than the cutoff from the ring, in bounded batches.
   *
   *  Three tables, not two. `observe_lifetime_folds` is the replay ledger behind
   *  `accumulateLifetime`, and it is the one table here whose rows are neither a measurement nor
   *  bounded by anything else: left alone it grows by one row per snapshot forever, which is the
   *  only unbounded thing the packet would have shipped. It ages out on the same window as the ring,
   *  and the ring refuses to fold a snapshot older than that window at all, so the pair holds the
   *  no-double-count property for all time without an ever-growing ledger.
   *
   *  Returns the row counts so the maintenance pass can say what it reclaimed rather than only that
   *  it ran, and `complete` so a caller can tell "nothing left" from "hit the cap, more next hour".
   *  `complete` covers every table: a pass that capped out on any one of them is not complete. */
  trim(before: number): { series: number; events: number; folds: number; complete: boolean } {
    const cutoff = Math.trunc(before);
    let series = 0;
    let events = 0;
    let folds = 0;
    let complete = true;
    for (const [table, key, add] of [
      ["observe_series", "rowid", (rows: number) => { series += rows; }],
      ["observe_events", "rowid", (rows: number) => { events += rows; }],
      ["observe_tool_durations", "rowid", (_rows: number) => {}],
      ["observe_snapshot_records", "rowid", (_rows: number) => {}],
      // WITHOUT ROWID, so the batch is taken by its primary key instead.
      ["observe_lifetime_folds", "snapshot_id", (rows: number) => { folds += rows; }],
    ] as const) {
      const statement = this.#db.prepare(
        `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE at < ? LIMIT ?)`,
      );
      let batches = 0;
      for (;;) {
        const removed = Number(statement.run(cutoff, TRIM_BATCH_ROWS).changes);
        add(removed);
        batches += 1;
        if (removed < TRIM_BATCH_ROWS) break;
        if (batches >= TRIM_BATCHES_PER_PASS) {
          complete = false;
          break;
        }
      }
    }
    return { series, events, folds, complete };
  }

  /** How many replay claims the ledger currently holds. For the trim's own tests; nothing in the
   *  gateway reads it. */
  lifetimeFoldCount(): number {
    return Number((this.#db
      .prepare("SELECT COUNT(*) AS n FROM observe_lifetime_folds")
      .get() as unknown as { n: number }).n);
  }

  /** p50, p95 and the sample count over one window, for one series and optionally one bot.
   *
   *  `series` may name a qualified sample (`device_rtt_ms|tunnel`) for one tag, or a bare base name
   *  with `includeTags` to fold every tag of that base into one distribution. */
  summarize(query: {
    series: string;
    bot?: string | null;
    from: number;
    to: number;
    includeTags?: boolean;
  }): ObserveSummary {
    const folded = query.includeTags === true;
    const clauses = [
      folded ? `(series = ? OR series LIKE ? ESCAPE '${LIKE_ESCAPE}')` : "series = ?",
      "at >= ?", "at < ?",
    ];
    const args: Array<string | number> = folded
      ? [query.series, `${escapeLike(query.series)}|%`, Math.trunc(query.from), Math.trunc(query.to)]
      : [query.series, Math.trunc(query.from), Math.trunc(query.to)];
    if (query.bot !== undefined && query.bot !== null) {
      clauses.push("bot = ?");
      args.push(query.bot);
    }
    const rows = this.#db
      .prepare(`SELECT value FROM observe_series WHERE ${clauses.join(" AND ")} ORDER BY value ASC`)
      .all(...args) as unknown as Array<{ value: number }>;
    const sorted = rows.map((row) => row.value);
    return {
      count: sorted.length,
      p50: nearestRank(sorted, 0.5),
      p95: nearestRank(sorted, 0.95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  /** Raw samples in a window, oldest first. Bounded because a caller charting a week of 5 second
   *  heartbeats would otherwise ask for a hundred thousand rows to draw a hundred pixels. */
  samples(query: {
    series: string;
    bot?: string | null;
    from: number;
    to: number;
    limit?: number;
  }): ObserveSeriesRow[] {
    const clauses = ["series = ?", "at >= ?", "at < ?"];
    const args: Array<string | number> = [query.series, Math.trunc(query.from), Math.trunc(query.to)];
    if (query.bot !== undefined && query.bot !== null) {
      clauses.push("bot = ?");
      args.push(query.bot);
    }
    args.push(Math.min(query.limit ?? 5_000, 20_000));
    return this.#db
      .prepare(
        `SELECT series, bot, at, value FROM observe_series
         WHERE ${clauses.join(" AND ")} ORDER BY at ASC LIMIT ?`,
      )
      .all(...args) as unknown as ObserveSeriesRow[];
  }

  /** Event markers in a window, newest first. */
  events(query: { kind?: string; bot?: string | null; from: number; to: number; limit?: number }): ObserveEventRow[] {
    const clauses = ["at >= ?", "at < ?"];
    const args: Array<string | number> = [Math.trunc(query.from), Math.trunc(query.to)];
    if (query.kind !== undefined) {
      clauses.push("kind = ?");
      args.push(query.kind);
    }
    if (query.bot !== undefined && query.bot !== null) {
      clauses.push("bot = ?");
      args.push(query.bot);
    }
    args.push(Math.min(query.limit ?? 500, 5_000));
    return this.#db
      .prepare(
        `SELECT at, kind, bot, ref, detail_json AS detailJson FROM observe_events
         WHERE ${clauses.join(" AND ")} ORDER BY at DESC LIMIT ?`,
      )
      .all(...args) as unknown as ObserveEventRow[];
  }

  /** Section 12's lifetime counters, which live outside the seven day ring precisely so the trim
   *  cannot reach them. D5 owns the producer; the table and this accumulator are declared here
   *  because they are part of the same storage decision.
   *
   *  `snapshotId` is the replay guard and is not optional. These counters are ADDITIVE and are never
   *  trimmed, so a snapshot folded twice inflates a lifetime token and cost figure permanently, with
   *  nothing downstream able to correct it. The id is recorded in the same statement as the
   *  addition, and a repeat is a no-op rather than an error. */
  accumulateLifetime(input: {
    snapshotId: string;
    bot: string;
    model: string;
    prompt: number;
    completion: number;
    cached: number;
    costMicros: number;
    turns: number;
    priced?: number;
    unpriced?: number;
    at: number;
  }): boolean {
    if (!isIdentityHash(input.bot) || !isIdentityHash(input.model) || !isIdentityHash(input.snapshotId)) {
      this.#refused += 1;
      return false;
    }
    for (const value of [input.prompt, input.completion, input.cached, input.costMicros, input.turns]) {
      if (!isStorableValue(value)) {
        this.#refused += 1;
        return false;
      }
    }
    this.#db.exec("SAVEPOINT observe_lifetime_write");
    try {
      const claimed = this.#db
        .prepare("INSERT OR IGNORE INTO observe_lifetime_folds (snapshot_id, at) VALUES (?, ?)")
        .run(input.snapshotId, Math.trunc(input.at)).changes;
      if (Number(claimed) !== 1) {
        this.#db.exec("RELEASE observe_lifetime_write");
        return false;
      }
      this.#db
        .prepare(
          `INSERT INTO observe_lifetime (bot, model, prompt, completion, cached, cost_micros, turns, updated_at, priced, unpriced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (bot, model) DO UPDATE SET
             prompt = prompt + excluded.prompt,
             completion = completion + excluded.completion,
             cached = cached + excluded.cached,
             cost_micros = cost_micros + excluded.cost_micros,
             turns = turns + excluded.turns,
             priced = priced + excluded.priced,
             unpriced = unpriced + excluded.unpriced,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.bot, input.model,
          Math.trunc(input.prompt), Math.trunc(input.completion), Math.trunc(input.cached),
          Math.trunc(input.costMicros), Math.trunc(input.turns), Math.trunc(input.at), input.priced ?? 0, input.unpriced ?? 0,
        );
      this.#db.exec("RELEASE observe_lifetime_write");
    } catch (error) {
      this.#db.exec("ROLLBACK TO observe_lifetime_write; RELEASE observe_lifetime_write");
      throw error;
    }
    return true;
  }

  lifetime(bot?: string): Array<{
    bot: string; model: string; prompt: number; completion: number; cached: number;
    costMicros: number; turns: number; updatedAt: number; priced: number; unpriced: number;
  }> {
    const sql = `SELECT bot, model, prompt, completion, cached, cost_micros AS costMicros,
                        turns, priced, unpriced, updated_at AS updatedAt FROM observe_lifetime`;
    return (bot === undefined
      ? this.#db.prepare(`${sql} ORDER BY bot ASC, model ASC`).all()
      : this.#db.prepare(`${sql} WHERE bot = ? ORDER BY model ASC`).all(bot)) as unknown as Array<{
        bot: string; model: string; prompt: number; completion: number; cached: number;
        costMicros: number; turns: number; updatedAt: number; priced: number; unpriced: number;
      }>;
  }

  putSnapshotRecord(bot: string, kind: "step" | "tool", record: object, at: number): void {
    if (!isIdentityHash(bot) || !Number.isSafeInteger(at) || validateObservationSnapshotRecord(kind, record) === undefined) {
      this.#refused++; return;
    }
    this.#db.prepare("INSERT INTO observe_snapshot_records (bot, kind, at, record_json) VALUES (?, ?, ?, ?)")
      .run(bot, kind, at, JSON.stringify(record));
  }

  snapshotRecords(query: { bot?: string; kind: "step" | "tool"; from: number; to: number }): Array<{ bot: string; at: number; record: Record<string, unknown> }> {
    const sql = "SELECT bot, at, record_json AS json FROM observe_snapshot_records WHERE kind = ? AND at >= ? AND at < ?";
    const rows = (query.bot === undefined
      ? this.#db.prepare(sql + " ORDER BY at").all(query.kind, query.from, query.to)
      : this.#db.prepare(sql + " AND bot = ? ORDER BY at").all(query.kind, query.from, query.to, query.bot)) as unknown as Array<{ bot: string; at: number; json: string }>;
    return rows.map(row => ({ bot: row.bot, at: row.at, record: JSON.parse(row.json) as Record<string, unknown> }));
  }

  transaction<T>(write: () => T): T {
    this.#db.exec("SAVEPOINT observe_snapshot_write");
    try {
      const result = write();
      this.#db.exec("RELEASE observe_snapshot_write");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK TO observe_snapshot_write; RELEASE observe_snapshot_write");
      throw error;
    }
  }

  /** A durable, hashed claim shared by snapshot records and their lifetime counters. */
  claimSnapshotRecord(key: string, at: number): boolean {
    return Number(this.#db.prepare("INSERT OR IGNORE INTO observe_lifetime_folds (snapshot_id, at) VALUES (?, ?)")
      .run(this.identify(key), at).changes) === 1;
  }

  putSnapshot(bot: string, payload: ObservationSnapshotPayload, receivedAt: number): boolean {
    const json = JSON.stringify(payload);
    if (!isIdentityHash(bot) || !Number.isSafeInteger(receivedAt)
      || Buffer.byteLength(json) > OBSERVATION_SNAPSHOT_MAX_BYTES
      || validateObservationSnapshotPayload(payload) === undefined) {
      this.#refused += 1;
      return false;
    }
    this.#db.prepare(`INSERT INTO observe_snapshots (bot, snapshot_json, received_at) VALUES (?, ?, ?)
      ON CONFLICT (bot) DO UPDATE SET snapshot_json = excluded.snapshot_json, received_at = excluded.received_at`)
      .run(bot, json, receivedAt);
    return true;
  }

  snapshot(bot: string): { payload: ObservationSnapshotPayload; receivedAt: number } | undefined {
    const row = this.#db.prepare("SELECT snapshot_json AS json, received_at AS receivedAt FROM observe_snapshots WHERE bot = ?")
      .get(bot) as { json: string; receivedAt: number } | undefined;
    return row === undefined ? undefined : { payload: JSON.parse(row.json) as ObservationSnapshotPayload, receivedAt: row.receivedAt };
  }

  snapshotSubjects(): string[] {
    return (this.#db.prepare("SELECT bot FROM observe_snapshots ORDER BY bot").all() as unknown as Array<{ bot: string }>).map(row => row.bot);
  }

  accumulateToolLifetime(input: {
    bot: string; tool: string; calls: number; tokens: number; failures: number;
    costMicros: number; priced: number; unpriced: number; at: number;
  }): void {
    if (!isIdentityHash(input.bot) || !isObservationToolName(input.tool)
      || ![input.calls, input.tokens, input.failures, input.costMicros, input.priced, input.unpriced, input.at].every(value => Number.isSafeInteger(value) && value >= 0)) {
      this.#refused++; return;
    }
    this.#db.prepare(`INSERT INTO observe_tool_lifetime
      (bot, tool, calls, tokens, failures, cost_micros, priced, unpriced, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (bot, tool) DO UPDATE SET calls = calls + excluded.calls, tokens = tokens + excluded.tokens,
      failures = failures + excluded.failures, cost_micros = cost_micros + excluded.cost_micros,
      priced = priced + excluded.priced, unpriced = unpriced + excluded.unpriced, updated_at = excluded.updated_at`)
      .run(input.bot, input.tool, input.calls, input.tokens, input.failures, input.costMicros, input.priced, input.unpriced, input.at);
  }

  toolLifetime(bot?: string): Array<{ bot: string; tool: string; calls: number; tokens: number; failures: number; costMicros: number; priced: number; unpriced: number; updatedAt: number }> {
    const sql = "SELECT bot, tool, calls, tokens, failures, cost_micros AS costMicros, priced, unpriced, updated_at AS updatedAt FROM observe_tool_lifetime";
    return (bot === undefined ? this.#db.prepare(sql + " ORDER BY bot, tool").all()
      : this.#db.prepare(sql + " WHERE bot = ? ORDER BY tool").all(bot)) as unknown as ReturnType<ObserveStore["toolLifetime"]>;
  }

  sampleToolDuration(bot: string, tool: string, at: number, value: number): void {
    if (!isIdentityHash(bot) || !isObservationToolName(tool) || !Number.isSafeInteger(at) || !isStorableValue(value)) {
      this.#refused++; return;
    }
    this.#db.prepare("INSERT INTO observe_tool_durations (bot, tool, at, value) VALUES (?, ?, ?, ?)").run(bot, tool, at, value);
  }

  toolDurations(query: { bot?: string; tool?: string; from: number; to: number }): ObserveSummary {
    const clauses = ["at >= ?", "at < ?"];
    const args: Array<string | number> = [query.from, query.to];
    for (const key of ["bot", "tool"] as const) {
      if (query[key] !== undefined) { clauses.push(`${key} = ?`); args.push(query[key]); }
    }
    const values = (this.#db.prepare(`SELECT value FROM observe_tool_durations WHERE ${clauses.join(" AND ")} ORDER BY value`).all(...args) as unknown as Array<{ value: number }>).map(row => row.value);
    return { count: values.length, p50: nearestRank(values, .5), p95: nearestRank(values, .95), min: values[0], max: values.at(-1) };
  }
}
