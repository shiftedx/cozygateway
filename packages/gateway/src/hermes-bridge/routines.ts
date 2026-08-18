import type { BotRoutine, BotRoutineCreateRequest, BotRoutinePatch } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";

/** The routines surface: the desktop's Routines pane (dissection section 8), reimplemented
 *  server-side so a phone schedules a bot's cron jobs exactly as a desktop does.
 *
 *  Everything here rests on ONE convention, and it is the whole reason a routine belongs to a bot
 *  at all: a routine is an ordinary Hermes cron job whose NAME is `[bot:<name>] <title>`. There is
 *  no bot field on a cron job, no per-bot cron API, nothing server-side that says a job belongs to
 *  a bot. The tag in the name is the entire relationship, which means:
 *
 *  - a job whose tag names another bot is NOT this bot's routine and must never appear in its list,
 *    even when the backend hands both over in the same answer (an older gateway that ignores the
 *    `profile` param returns the launch profile's whole store);
 *  - an untagged job is nobody's routine and stays invisible here, which is what keeps a routine
 *    pane from offering to delete the operator's own unrelated cron jobs;
 *  - the tag must be written byte-for-byte the way the desktop writes it, or the two clients stop
 *    seeing each other's routines.
 *
 *  The `profile` param is sent on every call anyway (dissection 8.2): a gateway that understands it
 *  scopes the call to that bot's own cron store, and one that does not ignores it, at which point
 *  the tag filter is what keeps the answer correct. Neither behavior is probed for, because the tag
 *  filter is required under both. */

/** The desktop's own three constants, verbatim (plugin.js:5230-5232). */
export const BOT_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\]\s*/i;
export const SAFE_ROUTINE_MARKER = "[bot-mode:routine:v2] ";
export const LEGACY_DELEGATED_ROUTINE_PREFIX = 'You are running the scheduled routine "';

/** The title shown for a tagged job with nothing after its tag. The desktop's own fallback. */
export const UNTITLED_ROUTINE = "Untitled cronjob";

/** The wording the desktop renders on an auto-paused legacy routine. Carried here so the gateway
 *  and the app cannot drift on what the user is told. */
export const LEGACY_PAUSED_NOTE =
  "Paused for security: delete and recreate this legacy cronjob before running it again.";

/** A `cron.manage` call that the backend ANSWERED with a refusal.
 *
 *  This is its own error type because the backend does not reject those calls: the cron tool
 *  returns `{"success": false, "error": "..."}` and the gateway wraps that in a perfectly ordinary
 *  JSON-RPC RESULT. A bridge that only looked at rejections would report "routine created" for a
 *  schedule the backend threw away. Every action's reply is therefore inspected, and the backend's
 *  own text rides along untouched. */
export class RoutineRefused extends Error {
  readonly action: string;

  constructor(action: string, message: string) {
    super(message);
    this.name = "RoutineRefused";
    this.action = action;
  }
}

/** A routine that does not exist in this bot's namespace. Its own type so the route can answer the
 *  404 it is rather than a backend failure, the same way an unknown bot name does. */
export class RoutineNotFound extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`no routine with id "${id}"`);
    this.name = "RoutineNotFound";
    this.id = id;
  }
}

export interface CronJob {
  job_id?: unknown;
  name?: unknown;
  schedule?: unknown;
  enabled?: unknown;
  state?: unknown;
  next_run_at?: unknown;
  last_run_at?: unknown;
  prompt?: unknown;
  prompt_preview?: unknown;
  repeat?: unknown;
  continuity?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The bot a cron job belongs to, lowercased, or null for a job that carries no tag. */
export function routineBot(job: CronJob): string | null {
  const match = BOT_TAG_RE.exec(asString(job.name) ?? "");
  return match === null ? null : (match[1] ?? "").toLowerCase();
}

/** The display title: the job name with its tag stripped. */
export function routineTitle(job: CronJob): string {
  const stripped = (asString(job.name) ?? "").replace(BOT_TAG_RE, "");
  return stripped.length === 0 ? UNTITLED_ROUTINE : stripped;
}

/** The cron job name a routine is stored under. The ONE place the namespace is written. */
export function routineJobName(bot: string, title: string): string {
  return `[bot:${bot}] ${title}`;
}

/** Whichever prompt text the backend sent for a job. A list answer usually carries a PREVIEW and a
 *  describe carries the whole thing; both are read the same way, which is what the legacy check and
 *  the prompt echo both need. */
export function routinePromptText(job: CronJob): string | undefined {
  return asString(job.prompt_preview) ?? asString(job.prompt);
}

/** True for a pre-marker delegated routine: a TAGGED job whose prompt begins with the legacy
 *  sentence. Those jobs interpolate a title into a shell command with no marker and no quoting
 *  discipline, which is why the desktop pauses them on sight rather than running them again. The
 *  tag requirement is not incidental: an untagged job with that text is not a bot routine and is
 *  none of this gateway's business. */
export function isLegacyDelegatedRoutine(job: CronJob): boolean {
  const preview = routinePromptText(job);
  return routineBot(job) !== null && preview !== undefined && preview.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX);
}

/** The desktop's row state: enabled unless the backend says otherwise, and never for a legacy job
 *  (which this gateway is in the middle of pausing anyway). */
export function routineActive(job: CronJob): boolean {
  return !isLegacyDelegatedRoutine(job) && job.enabled !== false && job.state !== "paused";
}

/** The desktop's `scheduleLabel` (plugin.js:5355-5387), returning `undefined` instead of the raw
 *  string for a shape it cannot name, so the wire carries a `human` field only when there IS one and
 *  a client renders `raw` verbatim otherwise. A label that merely echoes the schedule tells a client
 *  nothing and invites it to hide the string the user actually typed. */
export function scheduleHuman(schedule: string): string | undefined {
  const once = /^once in (.+)$/.exec(schedule);
  if (once !== null) return `Once (${once[1] ?? ""})`;

  const bare = /^(\d+)([mhd])$/.exec(schedule);
  if (bare !== null) return `Once (${bare[1] ?? ""}${bare[2] ?? ""})`;

  const every = /^every (\d+)m$/.exec(schedule);
  if (every !== null) {
    const minutes = Number(every[1]);
    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return days === 1 ? "Daily" : `Every ${days} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Hourly" : `Every ${hours}h`;
    }
    return `Every ${minutes}m`;
  }
  return undefined;
}

/** Hermes stamps `next_run_at` as a parsable date STRING (ISO on 0.20.x) and some builds send
 *  nothing at all. Milliseconds or null, never a string, because every other timestamp on this wire
 *  is milliseconds and a client should not be parsing two formats. A number is accepted too and is
 *  read as seconds when it is small enough to be seconds, the same rule the roster applies to
 *  `last_session.last_active`. */
export function routineTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // A UNIX SECONDS stamp for any date this century is below this bound; a milliseconds stamp is
    // far above it. Nothing else distinguishes them on the wire.
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = asString(value);
  if (text === undefined || text.trim().length === 0) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Maps one cron job into the wire shape. Tolerant throughout: a job that is missing a field the
 *  backend did not send degrades to a sane value rather than failing the list, because ONE
 *  malformed job must not blank a routines pane. */
export function mapRoutine(job: CronJob, opts: { autoPaused?: boolean } = {}): BotRoutine {
  const legacyUnsafe = isLegacyDelegatedRoutine(job);
  const raw = asString(job.schedule) ?? "";
  const human = scheduleHuman(raw);
  const prompt = routinePromptText(job);
  const state = asString(job.state);
  const repeat = asString(job.repeat);
  const lastStatus = asString(job.last_status);
  return {
    id: asString(job.job_id) ?? "",
    title: routineTitle(job),
    schedule: { raw, ...(human === undefined ? {} : { human }) },
    // An auto-paused job reads as paused in the very response that paused it, exactly as the
    // desktop's overlay does, so a pane never renders a legacy job as running.
    enabled: opts.autoPaused === true ? false : routineActive(job),
    ...(state === undefined || state.length === 0 ? {} : { state: opts.autoPaused === true ? "paused" : state }),
    legacyUnsafe,
    ...(opts.autoPaused === true ? { autoPaused: true } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    lastRun: routineTimestamp(job.last_run_at),
    nextRun: routineTimestamp(job.next_run_at),
    ...(lastStatus === undefined || lastStatus.length === 0 ? {} : { lastStatus }),
    ...(repeat === undefined || repeat.length === 0 ? {} : { repeat }),
    ...(job.continuity === true ? { continuity: true } : {}),
  };
}

/** Reads one `cron.manage` reply, turning the backend's SOFT refusal into a thrown error.
 *
 *  `success: false` is the shape every validation failure takes (an unparsable schedule, a job id
 *  that resolves to nothing, an ambiguous name), and it arrives as a successful RPC result. The
 *  `error` text is passed through untouched, because it is the only description of what was wrong.
 *  A reply with no `success` key at all is accepted: older builds answered some actions without one,
 *  and inventing a failure for a call that worked is the worse error. */
export function readCronReply(action: string, result: unknown): Record<string, unknown> {
  const record = asRecord(result) ?? {};
  if (record["success"] === false) {
    throw new RoutineRefused(action, asString(record["error"]) ?? `cron ${action} failed`);
  }
  return record;
}

/** Every job the backend returned, whatever its tag. Kept separate from the per-bot filter so the
 *  scoping rule has exactly one implementation and the raw answer stays available for a caller that
 *  needs to find a job by id. */
export function cronJobsOf(result: unknown): CronJob[] {
  const jobs = asRecord(result)?.["jobs"];
  return Array.isArray(jobs) ? jobs.flatMap((entry) => (asRecord(entry) === undefined ? [] : [entry as CronJob])) : [];
}

/** The jobs that belong to ONE bot. The single scoping rule of this whole module. */
export function selectRoutineJobs(jobs: readonly CronJob[], bot: string): CronJob[] {
  return jobs.filter((job) => routineBot(job) === bot);
}

/** The raw cron store this bot's routines live in, scoped by `profile`.
 *
 *  `include_disabled` is not optional in practice: without it the backend omits paused jobs
 *  entirely, which in any surface with an on/off switch reads as the routine having been DELETED.
 *
 *  0.20.4 echoes `scoped: "<profile>"` to prove it honored the scope, and 0.20.3 does not. The echo
 *  is deliberately NOT branched on. A scoped store still holds the operator's own unrelated cron
 *  jobs, so the `[bot:]` tag filter is required either way, and a probe whose only effect would be
 *  to WIDEN what a bot claims to own is a probe worth not having. */
export async function listCronJobs(rpc: HermesRpc, bot: string): Promise<CronJob[]> {
  const result = await rpc.request("cron.manage", { action: "list", include_disabled: true, profile: bot });
  readCronReply("list", result);
  return cronJobsOf(result);
}

/** One of a bot's routines by job id, or `RoutineNotFound`.
 *
 *  Scoped through the same tag filter as the list, which is what makes a job id from ANOTHER bot's
 *  namespace (or from an untagged operator cron job) a 404 rather than an edit: ids are guessable
 *  strings, and `cron.manage` itself will happily pause any job in the store by id. */
export async function findBotRoutineJob(rpc: HermesRpc, bot: string, jobId: string): Promise<CronJob> {
  const mine = selectRoutineJobs(await listCronJobs(rpc, bot), bot);
  const job = mine.find((entry) => asString(entry.job_id) === jobId);
  if (job === undefined) throw new RoutineNotFound(jobId);
  return job;
}

export interface RoutineListResult {
  routines: BotRoutine[];
  /** Job ids this call actually paused. Empty on every ordinary list. */
  autoPaused: string[];
}

/** Lists one bot's routines, performing the desktop's security auto-pause on the way through
 *  (dissection 8.2).
 *
 *  The auto-pause is not a nicety: a legacy delegated routine builds a shell command by
 *  interpolating a title that syncs from `ui_meta`, so anything that can write a bot's look can
 *  write a command line, and those jobs keep FIRING until something pauses them. Every client that
 *  lists them pauses them, which is why this gateway does it too rather than leaving it to the app:
 *  a phone that only reads would let a desktop's dangerous job keep running.
 *
 *  Each pause SWALLOWS ITS OWN ERROR, and this is load-bearing. A pause that fails must not fail the
 *  list: the pane would report "could not load routines" over data that loaded perfectly, and the
 *  20 s poll would retry the failing pause inside a failing query forever. Only the jobs the backend
 *  actually paused are reported as paused, so the next list retries the rest.
 *
 *  Scoped with `profile` on every call, and filtered by tag regardless: see the module note. */
export async function listBotRoutines(rpc: HermesRpc, bot: string): Promise<RoutineListResult> {
  const jobs = await listCronJobs(rpc, bot);
  const mine = selectRoutineJobs(jobs, bot);

  const legacyActive = mine.filter((job) => isLegacyDelegatedRoutine(job) && job.enabled !== false && job.state !== "paused");
  const paused = await Promise.all(
    legacyActive.map(async (job) => {
      try {
        // Inspected, not merely awaited: a refusal arrives as a SUCCESSFUL result carrying
        // `success: false`, and claiming a pause that did not happen is the one thing this overlay
        // must never do.
        readCronReply(
          "pause",
          await rpc.request("cron.manage", { action: "pause", name: asString(job.job_id) ?? "", profile: bot }),
        );
        return asString(job.job_id) ?? "";
      } catch {
        return undefined;
      }
    }),
  );
  const autoPaused = new Set(paused.filter((id): id is string => id !== undefined && id.length > 0));

  return {
    routines: mine.map((job) => {
      const id = asString(job.job_id) ?? "";
      return mapRoutine(job, { autoPaused: autoPaused.has(id) });
    }),
    autoPaused: [...autoPaused],
  };
}

/** Quotes a value for a POSIX shell single-quoted string, the desktop's `shellQuote` (5320-5322).
 *  Every embedded `'` closes the quote, escapes a literal quote, and reopens, which is the one form
 *  that is safe for arbitrary text including newlines. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The prompt a routine is stored with, the desktop's `routinePrompt` (5343-5354).
 *
 *  Two deliveries, and which one is used decides WHERE the run's transcript lands:
 *
 *  - When the routine's bot is the profile the scheduler itself runs as, the prompt is the BARE
 *    instruction and the run lands in that profile's own history, as an ordinary session.
 *  - Otherwise the instruction is wrapped in a marker-prefixed shell delegation that runs
 *    `hermes -p <bot> chat -c "Routine: <title>" -q "[Scheduled routine] <instruction>"`, so the run
 *    reaches the OTHER bot's history rather than the scheduler's.
 *
 *  The wrapper's marker (`SAFE_ROUTINE_MARKER`) is what keeps a routine this gateway writes from
 *  being read as the legacy delegated shape and auto-paused on the next list: the legacy check is a
 *  `startsWith` against the bare sentence, and the marker sits in front of it.
 *
 *  `schedulerProfile` is the gateway's `hermes.bridgeProfile` when the operator configured one. It
 *  is not detectable: the JSON-RPC surface reports the profile a SESSION is routed to, never the one
 *  the gateway process runs as. Unset means the delegation wrapper is always used, which is the
 *  conservative choice, since a bare prompt whose job did NOT land in the bot's own store would run
 *  as somebody else. */
export function routinePrompt(input: {
  bot: string;
  title: string;
  instruction: string;
  schedulerProfile?: string | undefined;
}): string {
  const scheduler = (input.schedulerProfile ?? "").trim().toLowerCase();
  const bot = input.bot.trim().toLowerCase();
  if (bot.length > 0 && bot === scheduler) return input.instruction;
  return (
    `${SAFE_ROUTINE_MARKER}You are running the scheduled routine "${input.title}" for agent '${input.bot}'. ` +
    `Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\n` +
    `hermes -p ${shellQuote(input.bot)} chat -c ${shellQuote(`Routine: ${input.title}`)} -q ${shellQuote(
      `[Scheduled routine] ${input.instruction}`,
    )}\n\n` +
    `If the command fails, report the error instead.`
  );
}

/** The `cron.manage { action: "add" }` params for a create. Built here rather than at the call site
 *  so the namespace, the prompt delivery and the optional params have exactly one spelling. */
export function buildRoutineAddParams(
  bot: string,
  input: BotRoutineCreateRequest,
  schedulerProfile?: string,
): Record<string, unknown> {
  const title = input.title.trim();
  return {
    action: "add",
    name: routineJobName(bot, title),
    schedule: input.schedule.trim(),
    prompt: routinePrompt({
      bot,
      title,
      instruction: input.prompt.trim(),
      schedulerProfile,
    }),
    profile: bot,
    ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
    ...(input.continuity === true ? { continuity: true } : {}),
  };
}

/** Row actions, dissection 8.5: `name` carries the JOB ID, not the display name. Getting this
 *  backwards is silent (the backend simply finds no job by that name) and is why it is stated once,
 *  here, instead of at three call sites. */
export function buildRoutineActionParams(
  action: "pause" | "resume" | "remove",
  bot: string,
  jobId: string,
): Record<string, unknown> {
  return { action, name: jobId, profile: bot };
}

/** Which of a patch's fields need the job to be rewritten rather than merely paused or resumed. */
export function patchNeedsRewrite(patch: BotRoutinePatch): boolean {
  return patch.title !== undefined || patch.schedule !== undefined || patch.prompt !== undefined;
}

export interface RoutineWriteResult {
  routine: BotRoutine;
  /** The id this routine had before a rewrite replaced it. */
  replacedId?: string;
  /** A replaced job that could not be removed. It is left PAUSED, so it never fires. */
  orphanedId?: string;
}

/** Creates a routine and answers with the row the backend just made.
 *
 *  `add` echoes the created job under `job`, so the answer is the backend's own row rather than one
 *  this gateway assembled from the request: the schedule comes back NORMALIZED (`every 2h` is stored
 *  and reported as `every 120m`) and `next_run_at` is computed, and a client that rendered its own
 *  request back would show a schedule the backend does not have. */
export async function createBotRoutine(
  rpc: HermesRpc,
  bot: string,
  input: BotRoutineCreateRequest,
  schedulerProfile?: string,
): Promise<BotRoutine> {
  const reply = readCronReply("add", await rpc.request("cron.manage", buildRoutineAddParams(bot, input, schedulerProfile)));
  const job = asRecord(reply["job"]) as CronJob | undefined;
  if (job !== undefined) return mapRoutine(job);
  // An older build that answered without the embedded row still told us the id and the schedule it
  // stored, so the row is assembled from THAT rather than from the request.
  return mapRoutine({
    job_id: reply["job_id"],
    name: routineJobName(bot, input.title.trim()),
    schedule: reply["schedule"],
    next_run_at: reply["next_run_at"],
    enabled: true,
  });
}

/** Deletes a routine. Scoped: an id that is not in this bot's namespace is a 404, never a delete. */
export async function deleteBotRoutine(rpc: HermesRpc, bot: string, jobId: string): Promise<void> {
  await findBotRoutineJob(rpc, bot, jobId);
  readCronReply("remove", await rpc.request("cron.manage", buildRoutineActionParams("remove", bot, jobId)));
}

/** Applies a patch.
 *
 *  Two very different operations behind one route, and the difference is the backend's, not this
 *  API's invention:
 *
 *  - `enabled` alone is a ROW ACTION (`pause` / `resume`) and keeps the routine's id.
 *  - anything else is a REWRITE, because `cron.manage` exposes no update action at all: the tool
 *    behind it has one, and the gateway does not route to it. So the routine is recreated, and its
 *    id changes.
 *
 *  The rewrite order is chosen so that no failure can leave a routine firing twice or firing with
 *  half an edit applied:
 *
 *  1. PAUSE the existing job first. From here on it cannot fire, whatever else happens. A pause that
 *     fails aborts the whole rewrite, because the alternative is a window where the old schedule and
 *     the new one are both live.
 *  2. ADD the replacement. If this fails (an unparsable schedule is the common one), the old job is
 *     RESUMED back to the state it was in and the failure is reported: the user's routine is exactly
 *     as it was before they tried to edit it.
 *  3. REMOVE the old job. If THIS fails, the new routine still exists and the old one is still
 *     paused, so nothing double-fires; the leftover id is reported as `orphanedId` rather than
 *     swallowed, because it is real and it is deletable. */
export async function patchBotRoutine(
  rpc: HermesRpc,
  bot: string,
  jobId: string,
  patch: BotRoutinePatch,
  schedulerProfile?: string,
): Promise<RoutineWriteResult> {
  const existing = await findBotRoutineJob(rpc, bot, jobId);

  if (!patchNeedsRewrite(patch)) {
    if (patch.enabled === undefined) return { routine: mapRoutine(existing) };
    const action = patch.enabled ? "resume" : "pause";
    const reply = readCronReply(action, await rpc.request("cron.manage", buildRoutineActionParams(action, bot, jobId)));
    const job = asRecord(reply["job"]) as CronJob | undefined;
    // `pause` and `resume` echo the updated row. When they do not, the local view is updated the
    // same way the desktop's optimistic switch does, rather than reporting the pre-call state.
    return { routine: mapRoutine(job ?? { ...existing, enabled: patch.enabled, state: patch.enabled ? "active" : "paused" }) };
  }

  const wasActive = routineActive(existing);
  if (wasActive) {
    readCronReply("pause", await rpc.request("cron.manage", buildRoutineActionParams("pause", bot, jobId)));
  }

  const title = patch.title ?? routineTitle(existing);
  // Guarded by the route, which refuses a rewrite with no prompt: the backend reports a 100-char
  // PREVIEW of a stored prompt and never the whole thing, so there is nothing here to fall back on.
  const prompt = patch.prompt ?? "";
  const create: BotRoutineCreateRequest = {
    title,
    schedule: patch.schedule ?? (asString(existing.schedule) ?? ""),
    prompt,
    ...(patch.repeat === undefined ? {} : { repeat: patch.repeat }),
    ...(patch.continuity === undefined ? {} : { continuity: patch.continuity }),
  };

  let created: BotRoutine;
  try {
    created = await createBotRoutine(rpc, bot, create, schedulerProfile);
  } catch (err) {
    if (wasActive) {
      // Best effort, and its failure must not replace the failure the caller needs to see: the
      // routine that could not be edited is now paused, which the next list will report.
      try {
        await rpc.request("cron.manage", buildRoutineActionParams("resume", bot, jobId));
      } catch {
        /* reported by the next list */
      }
    }
    throw err;
  }

  let orphanedId: string | undefined;
  try {
    readCronReply("remove", await rpc.request("cron.manage", buildRoutineActionParams("remove", bot, jobId)));
  } catch {
    orphanedId = jobId;
  }

  // The replacement inherits the row state the routine had: an edit is not a resume, and a routine
  // the user had switched off must not come back on because they fixed a typo in its title.
  let routine = created;
  if (!wasActive && routineActive(created)) {
    try {
      const reply = readCronReply(
        "pause",
        await rpc.request("cron.manage", buildRoutineActionParams("pause", bot, created.id)),
      );
      const job = asRecord(reply["job"]) as CronJob | undefined;
      routine = job === undefined ? { ...created, enabled: false, state: "paused" } : mapRoutine(job);
    } catch {
      /* the routine exists and is running; the next list reports the truth */
    }
  }

  return {
    routine,
    replacedId: jobId,
    ...(orphanedId === undefined ? {} : { orphanedId }),
  };
}
