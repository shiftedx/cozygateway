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

  /** Deletes generic ring rows older than the cutoff in bounded batches.
   *
   *  `node:sqlite` is synchronous, so each statement is capped. Reaching the cap leaves
   *  remaining rows for the next maintenance pass instead of stalling the gateway. */
  trim(before: number): { series: number; events: number; folds: number; complete: boolean } {
    const cutoff = Math.trunc(before);
    let series = 0;
    let events = 0;
    let folds = 0;
    let complete = true;
    for (const [table, key, add] of [
      ["observe_series", "rowid", (rows: number) => { series += rows; }],
      ["observe_events", "rowid", (rows: number) => { events += rows; }],
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

  /** p50, p95 and the sample count over one window, for one series and optionally one bot.
   *
   *  `series` may name a qualified sample (`device_rtt_ms|tunnel`) for one tag, or a bare base name
   *  with `includeTags` to fold every tag of that base into one distribution. */
  summarize(query: {
    series: string;
    bot?: string | null;
    bots?: readonly string[];
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
    if (query.bots !== undefined) {
      clauses.push(query.bots.length === 0 ? "0" : `bot IN (${query.bots.map(() => "?").join(",")})`);
      args.push(...query.bots);
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
    includeTags?: boolean;
  }): ObserveSeriesRow[] {
    const clauses = [query.includeTags ? `(series = ? OR series LIKE ? ESCAPE '${LIKE_ESCAPE}')` : "series = ?", "at >= ?", "at < ?"];
    const args: Array<string | number> = [query.series, ...(query.includeTags ? [`${escapeLike(query.series)}|%`] : []), Math.trunc(query.from), Math.trunc(query.to)];
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

  /** Full-window receipt measurements for same-device comparisons, never a capped event feed. */
  receiptMeasurements(query: { bot?: string; from: number; to: number }): Array<{ bot: string; device: string; detail: Record<string, unknown> }> {
    const rows = this.#db.prepare(`SELECT bot, ref AS device, detail_json AS detailJson FROM observe_events
      WHERE kind = 'receipt_measurement' AND at >= ? AND at < ?${query.bot === undefined ? "" : " AND bot = ?"}`)
      .all(Math.trunc(query.from), Math.trunc(query.to), ...(query.bot === undefined ? [] : [query.bot])) as Array<{ bot: string; device: string; detailJson: string }>;
    return rows.map(({ detailJson, ...row }) => ({ ...row, detail: JSON.parse(detailJson) as Record<string, unknown> }));
  }

  /** Full-window counts are independent of the bounded event feed used for rendering. */
  countEvents(query: { kind?: string; bot?: string; from: number; to: number; status?: string }): number {
    const clauses = ["at >= ?", "at < ?"];
    const args: Array<string | number> = [Math.trunc(query.from), Math.trunc(query.to)];
    if (query.kind !== undefined) { clauses.push("kind = ?"); args.push(query.kind); }
    if (query.bot !== undefined) { clauses.push("bot = ?"); args.push(query.bot); }
    if (query.status !== undefined) { clauses.push("json_extract(detail_json, '$.status') = ?"); args.push(query.status); }
    return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM observe_events WHERE ${clauses.join(" AND ")}`)
      .get(...args) as { n: number }).n);
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


}
