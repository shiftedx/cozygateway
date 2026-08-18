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

/** The desktop's own three constants (plugin.js:5230-5232), with ONE deliberate tightening.
 *
 *  The desktop's tag regex ends at `\]\s*`, which means it matches a PREFIX of the name and stops
 *  wherever the first `]` falls. A profile named `a]b` writes the job name `[bot:a]b] Title`, and
 *  that regex reads it as bot `a`: bot `a` then lists, edits and DELETES a routine belonging to
 *  another bot, and `a]b`'s own routines are orphaned the moment they are created. The lookahead
 *  requires the tag to be followed by whitespace or by nothing at all, which is exactly how both
 *  clients WRITE it (`routineJobName`), so a name carrying a bracket inside the tag now belongs to
 *  nobody instead of belonging to the wrong bot. Invisible is the safe side of that trade; owned by
 *  a bot that did not create it is not.
 *
 *  The routes apply the profile-id charset rule as well, which keeps this gateway from ever writing
 *  such a name. This is the half that also holds for a job some other client wrote. */
export const BOT_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\](?=\s|$)\s*/i;
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
  /** True when the refused call carried something the CLIENT chose, which is what makes the refusal
   *  a 400 rather than a 502. See `ROUTINE_CLIENT_INPUT_ACTIONS`. */
  readonly clientInput: boolean;

  constructor(action: string, message: string) {
    super(message);
    this.name = "RoutineRefused";
    this.action = action;
    this.clientInput = ROUTINE_CLIENT_INPUT_ACTIONS.has(action);
  }
}

/** The cron actions whose params carry client input, and therefore the only ones whose refusal can
 *  honestly be reported as "check what you typed".
 *
 *  `add` carries a schedule, a title and an instruction the user wrote, so a refusal there really is
 *  a 400. `list` carries no user input at all, and `pause` / `resume` / `remove` carry only a job id
 *  this gateway already resolved inside the bot's own namespace (an id that resolved to nothing is a
 *  404 long before the call goes out). A refusal on one of those is the backend failing to do
 *  something it was asked to do, and reporting it as invalid input puts "check what you typed" over
 *  a GET with no body. */
export const ROUTINE_CLIENT_INPUT_ACTIONS: ReadonlySet<string> = new Set(["add"]);

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

/** A routine the backend ACCEPTED but whose stored row could not be read back.
 *
 *  It exists so that "I could not confirm what was stored" can never be answered as "here is what
 *  was stored". The only other thing this gateway could put on the wire is the client's own request,
 *  and the request is not what the backend holds: the schedule is normalized on the way in (`every
 *  2h` becomes `every 120m`), the first run time is computed, and a run cap comes back as a display
 *  string. Echoing the input showed a user a schedule nobody had persisted, on the one path where
 *  something had actually gone wrong.
 *
 *  `createdId` is the id the `add` reported, when it reported one. It is carried because the job may
 *  well exist: a client that gets this error can list the routines and find out, and the id is what
 *  makes the leftover deletable. */
export class RoutineUnconfirmed extends Error {
  /** The id the `add` reply carried, or undefined when it carried none. */
  readonly createdId: string | undefined;

  constructor(createdId: string | undefined, detail: string) {
    super(
      createdId === undefined
        ? `the cron add answered without the created job and without its id, so the stored routine could not be read back: ${detail}`
        : `the routine was created as "${createdId}" but could not be read back: ${detail}`,
    );
    this.name = "RoutineUnconfirmed";
    this.createdId = createdId;
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

  // A job with no id cannot be paused: `cron.manage` resolves the row by the `name` param, and an
  // empty one names nothing, so the call is a guaranteed refusal against a store this gateway would
  // rather not be poking blind. It stays in the list, reported as the legacy row it is.
  const legacyActive = mine.filter(
    (job) =>
      isLegacyDelegatedRoutine(job) &&
      (asString(job.job_id) ?? "").length > 0 &&
      job.enabled !== false &&
      job.state !== "paused",
  );
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
  if (bot.length > 0 && bot === scheduler) {
    // The bare instruction, except when the user's own words happen to begin with the legacy
    // sentence: the legacy check is a `startsWith`, so an instruction that starts that way would be
    // read as a pre-marker delegated job and auto-paused on every list, forever, for text the user
    // wrote themselves. The marker in front costs nothing and is what the check looks past.
    return input.instruction.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX)
      ? `${SAFE_ROUTINE_MARKER}${input.instruction}`
      : input.instruction;
  }
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

/** Which of a patch's fields need the job to be rewritten rather than merely paused or resumed.
 *
 *  `repeat` and `continuity` count, and leaving them out was not a shortcut but a silent data loss:
 *  `cron.manage` has no update action, so the ONLY way either reaches the backend is on an `add`. A
 *  patch carrying `enabled` plus `repeat` took the row-action branch, answered 200, and threw the run
 *  cap away. There is no branch here that can write them without a rewrite, so a patch that names
 *  them is a rewrite. */
export function patchNeedsRewrite(patch: BotRoutinePatch): boolean {
  return (
    patch.title !== undefined ||
    patch.schedule !== undefined ||
    patch.prompt !== undefined ||
    patch.repeat !== undefined ||
    patch.continuity !== undefined
  );
}

/** The run cap still owed on an existing job, read back out of the DISPLAY string the backend
 *  reports (`forever`, `once`, `3 times`, `1/3`).
 *
 *  A rewrite is a delete and a create, so anything the patch does not restate is gone unless it is
 *  recovered here, and a bounded routine silently becoming a forever one because the user fixed a
 *  typo in its title is the worst version of that. `1/3` is "run 1 of 3", so what the replacement
 *  should be capped at is what REMAINS. A shape this cannot read returns undefined, which is the
 *  old behavior (uncapped) for a string nothing can honestly interpret. */
export function routineRepeatCount(job: CronJob): number | undefined {
  const text = (asString(job.repeat) ?? "").trim().toLowerCase();
  if (text.length === 0 || text === "forever") return undefined;
  if (text === "once") return 1;
  const times = /^(\d+)\s+times?$/.exec(text);
  if (times !== null) {
    const count = Number(times[1]);
    return Number.isFinite(count) && count > 0 ? count : undefined;
  }
  const progress = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (progress !== null) {
    const done = Number(progress[1]);
    const total = Number(progress[2]);
    if (!Number.isFinite(done) || !Number.isFinite(total)) return undefined;
    return Math.max(1, total - done);
  }
  return undefined;
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
 *  request back would show a schedule the backend does not have.
 *
 *  A build that answers without that row is READ BACK once, by the id the reply carried, and the
 *  stored job is what goes on the wire. It is not assembled from the request, which is what used to
 *  happen and is the one case where the answer was fiction: a routines pane showed the schedule the
 *  user typed, in a shape the backend never stores, precisely when the round trip had failed. If the
 *  read-back does not produce the job, the failure is reported (`RoutineUnconfirmed`) with the id the
 *  `add` reported, so the caller can go and look rather than being told a story. */
export async function createBotRoutine(
  rpc: HermesRpc,
  bot: string,
  input: BotRoutineCreateRequest,
  schedulerProfile?: string,
): Promise<BotRoutine> {
  const reply = readCronReply("add", await rpc.request("cron.manage", buildRoutineAddParams(bot, input, schedulerProfile)));
  const job = asRecord(reply["job"]) as CronJob | undefined;
  if (job !== undefined) return mapRoutine(job);

  const createdId = asString(reply["job_id"]) ?? "";
  // Nothing to read back BY. The add reported success, so a routine may exist, and the only honest
  // answer is that this gateway cannot say which one.
  if (createdId.length === 0) throw new RoutineUnconfirmed(undefined, "the reply carried no job_id");

  let stored: CronJob;
  try {
    stored = await findBotRoutineJob(rpc, bot, createdId);
  } catch (err) {
    throw new RoutineUnconfirmed(createdId, err instanceof Error ? err.message : String(err));
  }
  return mapRoutine(stored);
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
 *    id changes. `enabled` COMPOSES with a rewrite rather than being ignored by it: the replacement
 *    ends in the state the patch asked for, and in the state the routine already had when it did
 *    not ask.
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
  // What the routine should end up as, which is NOT simply what it was: a patch may carry `enabled`
  // alongside the fields that force the rewrite, and answering 200 while ignoring it told the user
  // their switch had been honored when it had not.
  const desiredActive = patch.enabled ?? wasActive;
  if (wasActive) {
    readCronReply("pause", await rpc.request("cron.manage", buildRoutineActionParams("pause", bot, jobId)));
  }

  const title = patch.title ?? routineTitle(existing);
  // Guarded by the route, which refuses a rewrite with no prompt: the backend reports a 100-char
  // PREVIEW of a stored prompt and never the whole thing, so there is nothing here to fall back on.
  const prompt = patch.prompt ?? "";
  // Every field the patch did not restate is carried over from the job being replaced, because a
  // rewrite is a delete and a create and anything not carried is DELETED. The run cap comes back out
  // of the display string (`routineRepeatCount`), so a title edit no longer turns a bounded routine
  // into a forever one.
  const repeat = patch.repeat ?? routineRepeatCount(existing);
  const continuity = patch.continuity ?? (existing.continuity === true ? true : undefined);
  const create: BotRoutineCreateRequest = {
    title,
    schedule: patch.schedule ?? (asString(existing.schedule) ?? ""),
    prompt,
    ...(repeat === undefined ? {} : { repeat }),
    ...(continuity === undefined ? {} : { continuity }),
  };

  let created: BotRoutine;
  try {
    created = await createBotRoutine(rpc, bot, create, schedulerProfile);
  } catch (err) {
    // A replacement that could not be READ BACK may well be running: the `add` succeeded and only
    // the confirmation failed. Resuming the old job on top of that is the one outcome this whole
    // ordering exists to prevent, so an unconfirmed create rolls nothing back. The old job stays
    // paused, nothing double-fires, and the next list reports whichever jobs are really there.
    if (wasActive && !(err instanceof RoutineUnconfirmed)) {
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

  // The replacement is put into the state the patch asked for, which defaults to the state the
  // routine already had: an edit is not a resume, and a routine the user had switched off must not
  // come back on because they fixed a typo in its title. `add` always creates a RUNNING job, so only
  // the off case has anything to do here.
  let routine = created;
  if (!desiredActive && routineActive(created)) {
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
