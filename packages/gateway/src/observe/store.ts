import type { DatabaseSync } from "node:sqlite";

import {
  isAllowedEventKind,
  isAllowedSeries,
  isIdLike,
  isStorableValue,
  serializeDetail,
  type ObserveDetail,
} from "./privacy.ts";

/** One aggregate over a window, always with the number of samples it was computed from.
 *
 *  Section 11: "every aggregate shows its sample count". A p95 over four samples is not a p95, and
 *  a caller that cannot see the count cannot know that. `p50` and `p95` are undefined exactly when
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

/** Nearest rank percentile over an already sorted ascending array. Nearest rank rather than a
 *  linear interpolation because every value in this ring is a real measurement: reporting a
 *  duration nothing ever measured, however plausibly interpolated, is the derived-as-measured
 *  mistake section 11 forbids. */
function nearestRank(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** The durable half of the observation ring: two capped tables, the privacy rule that decides what
 *  may enter them, and the read helpers D3 charts from.
 *
 *  THE PRIVACY RULE LIVES HERE, at the last line before SQLite, not at the call sites. Every
 *  writer in the gateway funnels through `sample` and `event`, and a row that fails the rule is
 *  refused and counted rather than scrubbed and written: a partially redacted row would invite a
 *  reader to trust the fields that survived. */
export class ObserveStore {
  readonly #db: DatabaseSync;
  #refused = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Rows this store declined to write because they failed the privacy or shape rule. A test
   *  asserts it is zero after exercising the real writers; a nonzero count in production is a bug
   *  in a call site, never an expected outcome. */
  get refused(): number {
    return this.#refused;
  }

  /** Writes one sample. Returns false when the row was refused, so a caller that cares (a test,
   *  the fuzz check) can see it; the gateway's hot paths ignore the result on purpose, because a
   *  refused metric must never change what a turn does. */
  sample(series: string, bot: string | null, at: number, value: number): boolean {
    if (!isAllowedSeries(series) || !isStorableValue(value) || !Number.isFinite(at)) {
      this.#refused += 1;
      return false;
    }
    if (bot !== null && !isIdLike(bot)) {
      this.#refused += 1;
      return false;
    }
    this.#db
      .prepare("INSERT INTO observe_series (series, bot, at, value) VALUES (?, ?, ?, ?)")
      .run(series, bot, Math.trunc(at), value);
    return true;
  }

  /** Writes one event marker. `ref` is an id and nothing else: a turn id, a device id, a grant id. */
  event(
    kind: string,
    at: number,
    bot: string | null,
    ref: string | null,
    detail?: ObserveDetail,
  ): boolean {
    const detailJson = serializeDetail(detail);
    if (!isAllowedEventKind(kind) || !Number.isFinite(at) || detailJson === undefined) {
      this.#refused += 1;
      return false;
    }
    if ((bot !== null && !isIdLike(bot)) || (ref !== null && !isIdLike(ref))) {
      this.#refused += 1;
      return false;
    }
    this.#db
      .prepare("INSERT INTO observe_events (at, kind, bot, ref, detail_json) VALUES (?, ?, ?, ?, ?)")
      .run(Math.trunc(at), kind, bot, ref, detailJson);
    return true;
  }

  /** Deletes everything older than the cutoff from both tables. Returns the row counts so the
   *  maintenance pass can say what it reclaimed rather than only that it ran. */
  trim(before: number): { series: number; events: number } {
    const cutoff = Math.trunc(before);
    const series = this.#db.prepare("DELETE FROM observe_series WHERE at < ?").run(cutoff).changes;
    const events = this.#db.prepare("DELETE FROM observe_events WHERE at < ?").run(cutoff).changes;
    return { series: Number(series), events: Number(events) };
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
    const clauses = [query.includeTags === true ? "(series = ? OR series LIKE ? || '|%')" : "series = ?", "at >= ?", "at < ?"];
    const args: Array<string | number> = query.includeTags === true
      ? [query.series, query.series, Math.trunc(query.from), Math.trunc(query.to)]
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
   *  because they are part of the same storage decision. */
  accumulateLifetime(input: {
    bot: string;
    model: string;
    prompt: number;
    completion: number;
    cached: number;
    costMicros: number;
    turns: number;
    at: number;
  }): boolean {
    if (!isIdLike(input.bot) || !isIdLike(input.model)) {
      this.#refused += 1;
      return false;
    }
    for (const value of [input.prompt, input.completion, input.cached, input.costMicros, input.turns]) {
      if (!isStorableValue(value)) {
        this.#refused += 1;
        return false;
      }
    }
    this.#db
      .prepare(
        `INSERT INTO observe_lifetime (bot, model, prompt, completion, cached, cost_micros, turns, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot, model) DO UPDATE SET
           prompt = prompt + excluded.prompt,
           completion = completion + excluded.completion,
           cached = cached + excluded.cached,
           cost_micros = cost_micros + excluded.cost_micros,
           turns = turns + excluded.turns,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.bot, input.model,
        Math.trunc(input.prompt), Math.trunc(input.completion), Math.trunc(input.cached),
        Math.trunc(input.costMicros), Math.trunc(input.turns), Math.trunc(input.at),
      );
    return true;
  }

  lifetime(bot?: string): Array<{
    bot: string; model: string; prompt: number; completion: number; cached: number;
    costMicros: number; turns: number; updatedAt: number;
  }> {
    const sql = `SELECT bot, model, prompt, completion, cached, cost_micros AS costMicros,
                        turns, updated_at AS updatedAt FROM observe_lifetime`;
    return (bot === undefined
      ? this.#db.prepare(`${sql} ORDER BY bot ASC, model ASC`).all()
      : this.#db.prepare(`${sql} WHERE bot = ? ORDER BY model ASC`).all(bot)) as unknown as Array<{
        bot: string; model: string; prompt: number; completion: number; cached: number;
        costMicros: number; turns: number; updatedAt: number;
      }>;
  }
}
