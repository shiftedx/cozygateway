import type {
  BotRoutine,
  BotRoutineBlueprint,
  BotRoutineCreateRequest,
  BotRoutinePatch,
  BotRoutineRunRecord,
} from "cozygateway-contract";

import { asRecord, asString } from "./rpc.ts";
import type { HermesRpc } from "./rpc.ts";
import { projectHermesSessionText, redactHermesSessionPaths } from "./session-management.ts";

/** The routines surface stores new bot routines as ordinary Hermes cron jobs named
 * `[bot:<name>] <title>`. Existing untagged cron jobs are also shown because `cron.manage` scopes
 * this call to the bot's profile; otherwise live schedules disappear from the only UI that can
 * manage them. A tag naming another bot is always excluded. */

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
const BOT_TAG_CLAIM_RE = /^\[bot:/i;

export const SAFE_ROUTINE_MARKER = "[bot-mode:routine:v2] ";
const SILENCE_FIRST =
  "Silence-first: send a user-facing reply only when there is a concrete, useful result. If there is nothing worth delivering, reply with no text.";

/** The title shown for a tagged job with nothing after its tag. The desktop's own fallback. */
export const UNTITLED_ROUTINE = "Untitled cronjob";
export const ROUTINE_DELIVERY_ERROR_MAX_LENGTH = 512;


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

/** The Hermes connection the routines surface needs: the JSON-RPC socket (`cron.manage`) and, since
 *  capability 83, the dashboard REST routes for the four things `cron.manage` cannot do (update in
 *  place, trigger, run history, blueprints). `dashboardJson` is optional so a list still works on a
 *  bare RPC (tests, and a dashboard read that failed only costs the full-prompt merge). */
export interface HermesRoutinesPort extends HermesRpc {
  dashboardJson?<T = unknown>(
    path: string,
    init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
  ): Promise<T>;
}

/** A capability-83 operation that needs the dashboard REST surface on a connection that has none. */
export class RoutineDashboardUnavailable extends Error {
  constructor(operation: string) {
    super(`this Hermes connection has no dashboard REST surface, so a routine ${operation} is not possible`);
    this.name = "RoutineDashboardUnavailable";
  }
}

function dashboard(port: HermesRoutinesPort, operation: string): NonNullable<HermesRoutinesPort["dashboardJson"]> {
  const call = port.dashboardJson;
  if (call === undefined) throw new RoutineDashboardUnavailable(operation);
  return call.bind(port);
}

function cronJobPath(jobId: string, bot: string, suffix = ""): string {
  return `/api/cron/jobs/${encodeURIComponent(jobId)}${suffix}?profile=${encodeURIComponent(bot)}`;
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
 * describe carries the whole thing. */
export function routinePromptText(job: CronJob): string | undefined {
  return asString(job.prompt_preview) ?? asString(job.prompt);
}

/** The row state is enabled unless Hermes says otherwise. */
export function routineActive(job: CronJob): boolean {
  return job.enabled !== false && job.state !== "paused";
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

/** Projects Hermes' `_format_job.last_delivery_error` as display text, never as diagnostic host
 * data. Delivery adapters commonly include their spool/config path in failures, so every absolute
 * POSIX, drive-letter, UNC and home-relative path family is removed before the bound is applied.
 * Whitespace is flattened for a routine-row label and control bytes are discarded. */
/** `~/...` paths, which the absolute-path rules of `redactHermesSessionPaths` do not cover. */
function redactHomePaths(value: string): string {
  return value.replace(/(^|[\s("'`])~[\\/][^\s"'<>]*/g, "$1<path>");
}

export function routineDeliveryError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = redactHermesSessionPaths(redactHomePaths(value))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length === 0) return undefined;
  const bounded = clean.slice(0, ROUTINE_DELIVERY_ERROR_MAX_LENGTH);
  // Do not leave an unmatched leading surrogate when the UTF-16 bound cuts an emoji pair.
  return /[\ud800-\udbff]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

/** Maps one cron job into the wire shape. Tolerant throughout: a job that is missing a field the
 *  backend did not send degrades to a sane value rather than failing the list, because ONE
 *  malformed job must not blank a routines pane. */
export function mapRoutine(job: CronJob): BotRoutine {
  const raw = asString(job.schedule) ?? "";
  const human = scheduleHuman(raw);
  const prompt = routinePromptText(job);
  const state = asString(job.state);
  const repeat = asString(job.repeat);
  const lastStatus = asString(job.last_status);
  const lastDeliveryError = routineDeliveryError(job.last_delivery_error);
  const deliver = asString(job.deliver);
  return {
    id: asString(job.job_id) ?? "",
    title: routineTitle(job),
    schedule: { raw, ...(human === undefined ? {} : { human }) },
    enabled: routineActive(job),
    ...(state === undefined || state.length === 0 ? {} : { state }),
    ...(prompt === undefined ? {} : { prompt }),
    lastRun: routineTimestamp(job.last_run_at),
    nextRun: routineTimestamp(job.next_run_at),
    ...(lastStatus === undefined || lastStatus.length === 0 ? {} : { lastStatus }),
    ...(lastDeliveryError === undefined ? {} : { lastDeliveryError }),
    ...(repeat === undefined || repeat.length === 0 ? {} : { repeat }),
    ...(job.continuity === true ? { continuity: true } : {}),
    ...(deliver === undefined || deliver.length === 0 ? {} : { deliver }),
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

/** Jobs owned by the bot profile requested from `cron.manage`: its tagged routines and its older,
 *  untagged cron jobs. A malformed or foreign tag is still somebody else's ownership claim and is
 *  therefore excluded rather than adopted as an existing cron. */
export function selectRoutineJobs(jobs: readonly CronJob[], bot: string): CronJob[] {
  return jobs.filter((job) => {
    const owner = routineBot(job);
    return owner === bot || (owner === null && !BOT_TAG_CLAIM_RE.test(asString(job.name) ?? ""));
  });
}

/** The raw cron store this bot's routines live in, scoped by `profile`.
 *
 *  `include_disabled` is not optional in practice: without it the backend omits paused jobs
 *  entirely, which in any surface with an on/off switch reads as the routine having been DELETED.
 *
 *  The tag filter is unconditional, so a backend that ignores this hint cannot widen what a bot
 *  claims. */
export async function listCronStore(rpc: HermesRpc, bot: string): Promise<CronJob[]> {
  const result = await rpc.request("cron.manage", { action: "list", include_disabled: true, profile: bot });
  readCronReply("list", result);
  return cronJobsOf(result);
}

/** One of a bot's routine rows by job id, or `RoutineNotFound`.
 *
 *  The tag filter is the authorization boundary: ids are guessable and `cron.manage` can otherwise
 *  mutate any job in the returned store. */
export async function findBotRoutineJob(rpc: HermesRpc, bot: string, jobId: string): Promise<CronJob> {
  const job = selectRoutineJobs(await listCronStore(rpc, bot), bot).find((entry) => asString(entry.job_id) === jobId);
  if (job === undefined) throw new RoutineNotFound(jobId);
  return job;
}

export interface RoutineListResult {
  routines: BotRoutine[];
  /** Hermes's `gateway_running`, when it said true or false. */
  schedulerRunning?: boolean;
}

/** Lists one bot's current tagged routines.
 *
 *  `cron.manage list` reports a 100-character PREVIEW of each prompt. Capability 83 reads the full
 *  stored prompts from the dashboard (`GET /api/cron/jobs?profile=`) and unwraps the instruction
 *  the user wrote, so an editor can show and edit the whole thing. That read is best effort: when
 *  it fails the preview stays, exactly as before. */
export async function listBotRoutines(port: HermesRoutinesPort, bot: string): Promise<RoutineListResult> {
  const result = await port.request("cron.manage", { action: "list", include_disabled: true, profile: bot });
  readCronReply("list", result);
  const jobs = selectRoutineJobs(cronJobsOf(result), bot);
  const full = await fullPrompts(port, bot, jobs.length);
  const running = asRecord(result)?.["gateway_running"];
  return {
    routines: jobs.map((job) => {
      const routine = mapRoutine(job);
      const prompt = full.get(routine.id);
      return prompt === undefined ? routine : { ...routine, prompt: routineInstruction(prompt) };
    }),
    ...(typeof running === "boolean" ? { schedulerRunning: running } : {}),
  };
}

async function fullPrompts(port: HermesRoutinesPort, bot: string, count: number): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  if (count === 0 || port.dashboardJson === undefined) return prompts;
  try {
    const rows = await port.dashboardJson<unknown>(`/api/cron/jobs?profile=${encodeURIComponent(bot)}`);
    const list = Array.isArray(rows) ? rows : asRecord(rows)?.["jobs"];
    if (!Array.isArray(list)) return prompts;
    for (const row of list) {
      const record = asRecord(row);
      const id = asString(record?.["id"]);
      const prompt = asString(record?.["prompt"]);
      if (id !== undefined && prompt !== undefined) prompts.set(id, prompt);
    }
  } catch {
    /* the previews stand */
  }
  return prompts;
}

/** A routine row with its WHOLE instruction: `cron.manage` reports a 100-character preview of the
 *  wrapped prompt, so a write's answer would otherwise put that preview in front of an editor. The
 *  stored prompt is read from the dashboard (best effort; the preview stands when it fails). */
async function withFullInstruction(port: HermesRoutinesPort, bot: string, job: CronJob): Promise<BotRoutine> {
  const routine = mapRoutine(job);
  if (port.dashboardJson === undefined) return routine;
  try {
    const stored = asRecord(await port.dashboardJson<unknown>(cronJobPath(routine.id, bot)));
    const prompt = asString(stored?.["prompt"]);
    return prompt === undefined ? routine : { ...routine, prompt: routineInstruction(prompt) };
  } catch {
    return routine;
  }
}

const SCHEDULED_ARGUMENT = " -q '[Scheduled routine] ";

/** The instruction a user wrote, out of the prompt a routine is stored with: the reverse of
 *  `routinePrompt`, and of the desktop's own wrapper (which has no silence-first line). A prompt
 *  that is not one of those shapes is returned whole, because it IS the instruction. */
export function routineInstruction(prompt: string): string {
  let text = prompt;
  if (text.startsWith(SAFE_ROUTINE_MARKER)) {
    // The LAST ` -q '[Scheduled routine] `: the title also appears raw in the wrapper's first
    // sentence, so a title carrying that text must not be taken for the quoted argument. Inside a
    // shell-quoted argument every `'` is escaped, so the real one is the last literal match.
    const open = text.lastIndexOf(SCHEDULED_ARGUMENT);
    const close = text.lastIndexOf("'\n\nIf the command fails");
    if (open === -1 || close <= open) return prompt;
    text = text.slice(open + SCHEDULED_ARGUMENT.length, close).replaceAll(`'"'"'`, "'");
  }
  if (text.startsWith(`${SILENCE_FIRST}\n\n`)) text = text.slice(SILENCE_FIRST.length + 2);
  return text;
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
    return `${SILENCE_FIRST}\n\n${input.instruction}`;
  }
  return (
    `${SAFE_ROUTINE_MARKER}You are running the scheduled routine "${input.title}" for agent '${input.bot}'. ` +
    `${SILENCE_FIRST} Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\n` +
    `hermes -p ${shellQuote(input.bot)} chat -c ${shellQuote(`Routine: ${input.title}`)} -q ${shellQuote(
      `[Scheduled routine] ${SILENCE_FIRST}\n\n${input.instruction}`,
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
    ...(input.deliver === undefined ? {} : { deliver: input.deliver }),
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

/** Whether a patch writes anything beyond the on/off switch. Since capability 83 such a patch is
 *  an in-place update rather than a rewrite; the name is kept for the callers that ask. */
export function patchNeedsRewrite(patch: BotRoutinePatch): boolean {
  return (
    patch.title !== undefined ||
    patch.schedule !== undefined ||
    patch.prompt !== undefined ||
    patch.repeat !== undefined ||
    patch.continuity !== undefined ||
    patch.deliver !== undefined
  );
}

/** Runs a job has already completed, read from the backend's run-cap display string (`1/3` means
 *  one of three done). Every other shape has completed none that matter to a cap. */
export function routineCompletedRuns(job: CronJob): number {
  const progress = /^(\d+)\s*\/\s*(\d+)$/.exec((asString(job.repeat) ?? "").trim());
  const done = progress === null ? 0 : Number(progress[1]);
  return Number.isFinite(done) && done > 0 ? done : 0;
}

/** The prompt an EDITED instruction is stored with, in the shape the job already has. Only a job
 *  that carries the gateway's own delegation wrapper is re-wrapped (with its current title); a bare
 *  prompt stays bare, keeping the silence-first line only if it was there. A blueprint's job is a
 *  bare prompt whose `skills` load into the outer agent, and wrapping it would run the instruction
 *  in a nested agent without them. A job whose stored prompt could not be read is wrapped as a
 *  create would wrap it. */
export function rewrapRoutinePrompt(input: {
  stored: string | undefined;
  bot: string;
  title: string;
  instruction: string;
  schedulerProfile?: string | undefined;
}): string {
  const { stored, bot, title, instruction } = input;
  if (stored === undefined) return routinePrompt(input);
  if (stored.startsWith(SAFE_ROUTINE_MARKER)) return routinePrompt({ bot, title, instruction });
  if (stored.startsWith(`${SILENCE_FIRST}\n\n`)) return `${SILENCE_FIRST}\n\n${instruction}`;
  return instruction;
}

/** Runs the job has completed, from the stored record's `repeat.completed`. The `cron.manage`
 *  display string cannot be trusted for this: it reads `forever` for any uncapped job, however
 *  many times it has run. The display string is only the fallback. */
function storedCompletedRuns(stored: Record<string, unknown> | undefined, job: CronJob): number {
  const completed = asRecord(stored?.["repeat"])?.["completed"];
  return typeof completed === "number" && Number.isFinite(completed) && completed >= 0
    ? Math.trunc(completed)
    : routineCompletedRuns(job);
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
  const instruction = input.prompt.trim();
  if (job !== undefined) return { ...mapRoutine(job), prompt: instruction };

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
  return { ...mapRoutine(stored), prompt: instruction };
}

/** A bot's profile was renamed. Its cron jobs moved with the profile directory, but their names
 *  still carry `[bot:<from>]`, which `selectRoutineJobs` reads as another bot's claim, so every
 *  routine would vanish from the new name. Hermes's own rename does not touch job names (the
 *  namespace is Bot Mode's, and this gateway is the one place it is written, `routineJobName`), so
 *  the gateway rewrites them: the tag and, for a job carrying the gateway's delegation wrapper, the
 *  prompt, whose `hermes -p <bot>` would otherwise name a profile that no longer exists.
 *
 *  Best effort per job: a failure is returned by id rather than thrown, since the rename itself
 *  has already happened and a job left behind is still visible in Hermes's Cron view. */
export async function retagBotRoutines(
  port: HermesRoutinesPort,
  from: string,
  to: string,
): Promise<{ retagged: string[]; failed: string[] }> {
  const retagged: string[] = [];
  const failed: string[] = [];
  const jobs = (await listCronStore(port, to)).filter((job) => routineBot(job) === from);
  if (jobs.length === 0) return { retagged, failed };
  const call = dashboard(port, "retag");
  for (const job of jobs) {
    const id = asString(job.job_id) ?? "";
    if (id.length === 0) continue;
    try {
      const title = routineTitle(job);
      const updates: Record<string, unknown> = { name: routineJobName(to, title) };
      const stored = asString(asRecord(await call<unknown>(cronJobPath(id, to)))?.["prompt"]);
      if (stored?.startsWith(SAFE_ROUTINE_MARKER) === true) {
        updates["prompt"] = routinePrompt({ bot: to, title, instruction: routineInstruction(stored) });
      }
      await call(cronJobPath(id, to), { method: "PUT", body: { updates } });
      retagged.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { retagged, failed };
}

/** Deletes a tagged routine. An id outside this bot's namespace is a 404, never a delete. */
export async function deleteBotRoutine(rpc: HermesRpc, bot: string, jobId: string): Promise<void> {
  await findBotRoutineJob(rpc, bot, jobId);
  readCronReply("remove", await rpc.request("cron.manage", buildRoutineActionParams("remove", bot, jobId)));
}

/** Applies a patch IN PLACE (capability 83).
 *
 *  `enabled` alone stays the row action it always was (`cron.manage` pause/resume). Anything else is
 *  one `PUT /api/cron/jobs/:id?profile=` with only the fields the patch names, so the routine keeps
 *  its id and everything it did not name. Before 83 this was a pause-add-remove rewrite, because
 *  `cron.manage` has no update action; Hermes's dashboard has had one all along.
 *
 *  - `prompt` keeps the stored prompt's shape (`rewrapRoutinePrompt`): the gateway's wrapper is
 *    re-wrapped, a bare prompt stays bare. A rename re-wraps the wrapper with the new title.
 *  - `repeat` counts runs from now: the completed runs (the stored `repeat.completed`) are added
 *    back, because Hermes stores a total and keeps its completed counter across an update.
 *  - `continuity` is Hermes's `self` entry in `context_from`; other references are kept. */
export async function patchBotRoutine(
  port: HermesRoutinesPort,
  bot: string,
  jobId: string,
  patch: BotRoutinePatch,
  schedulerProfile?: string,
): Promise<RoutineWriteResult> {
  const existing = await findBotRoutineJob(port, bot, jobId);

  if (patchNeedsRewrite(patch)) {
    const call = dashboard(port, "edit");
    const updates: Record<string, unknown> = {};
    const title = patch.title?.trim() ?? routineTitle(existing);
    // The stored record: the full prompt (to keep its shape), the real completed-run count and the
    // continuity references. Read once, and only when the patch needs one of them.
    const needsStored =
      patch.title !== undefined || patch.prompt !== undefined || typeof patch.repeat === "number" ||
      patch.continuity !== undefined;
    const stored = needsStored ? asRecord(await call<unknown>(cronJobPath(jobId, bot))) : undefined;
    const storedPrompt = asString(stored?.["prompt"]);
    if (patch.title !== undefined) updates["name"] = routineJobName(bot, title);
    if (patch.schedule !== undefined) updates["schedule"] = patch.schedule.trim();
    // A rename re-wraps the gateway's wrapper too, since the wrapper names the routine's title.
    const instruction =
      patch.prompt?.trim() ??
      (patch.title !== undefined && storedPrompt?.startsWith(SAFE_ROUTINE_MARKER) === true
        ? routineInstruction(storedPrompt)
        : undefined);
    if (instruction !== undefined) {
      updates["prompt"] = rewrapRoutinePrompt({ stored: storedPrompt, bot, title, instruction, schedulerProfile });
    }
    // `null` is "forever": Hermes's update_job stores `{times: None}` and keeps the completed count.
    if (patch.repeat !== undefined)
      updates["repeat"] = patch.repeat === null ? null : patch.repeat + storedCompletedRuns(stored, existing);
    if (patch.deliver !== undefined) updates["deliver"] = patch.deliver;
    if (patch.continuity !== undefined) {
      const raw = stored?.["context_from"];
      const refs = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
        .flatMap((ref) => (typeof ref === "string" ? [ref] : []))
        .filter((ref) => ref.trim().toLowerCase() !== "self" && ref !== jobId);
      updates["context_from"] = patch.continuity ? [...refs, "self"] : refs;
    }
    await call(cronJobPath(jobId, bot), { method: "PUT", body: { updates } });
  }

  let current = patchNeedsRewrite(patch) ? await findBotRoutineJob(port, bot, jobId) : existing;
  if (patch.enabled !== undefined && patch.enabled !== routineActive(current)) {
    const action = patch.enabled ? "resume" : "pause";
    const reply = readCronReply(action, await port.request("cron.manage", buildRoutineActionParams(action, bot, jobId)));
    // `pause` and `resume` echo the updated row. When they do not, the local view is updated the
    // same way the desktop's optimistic switch does, rather than reporting the pre-call state.
    current = (asRecord(reply["job"]) as CronJob | undefined)
      ?? { ...current, enabled: patch.enabled, state: patch.enabled ? "active" : "paused" };
  }
  return { routine: await withFullInstruction(port, bot, current) };
}

/** How long a run-now waits for Hermes to refuse before answering that the run started. Hermes's
 *  trigger holds its HTTP answer until the whole run has finished, which can be minutes, so the
 *  route answers once the trigger has been accepted and lets the run finish in the background. */
export const ROUTINE_RUN_ACCEPT_MS = 1_500;

export interface RoutineRunStart {
  routine: BotRoutine;
  startedAt: number;
  /** Settles when Hermes's trigger answers (the run ended, or it was refused late). Never rejects. */
  settled: Promise<void>;
}

/** Fires a routine now through Hermes's own trigger (`POST /api/cron/jobs/:id/trigger`), after the
 *  namespace check every write makes. A refusal inside `acceptMs` (an unknown job, a run already
 *  in flight) is thrown; past it the run is reported started. */
export async function runBotRoutine(
  port: HermesRoutinesPort,
  bot: string,
  jobId: string,
  now: () => number = Date.now,
  acceptMs: number = ROUTINE_RUN_ACCEPT_MS,
): Promise<RoutineRunStart> {
  const existing = await findBotRoutineJob(port, bot, jobId);
  const call = dashboard(port, "run");
  const startedAt = now();
  const trigger = call<unknown>(cronJobPath(jobId, bot, "/trigger"), { method: "POST", body: {} });
  const settled = trigger.then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accepted = new Promise<"accepted">((resolve) => {
    timer = setTimeout(() => resolve("accepted"), acceptMs);
  });
  try {
    await Promise.race([trigger, accepted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { routine: await withFullInstruction(port, bot, existing), startedAt, settled };
}

/** Milliseconds from Hermes's epoch-seconds session stamps. */
function secondsToMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null;
}

/** A routine's past runs, newest first. Only the handful of facts a run row shows are projected:
 *  a Hermes session row also carries its system prompt and billing, which never leave the host. */
export async function listBotRoutineRuns(
  port: HermesRoutinesPort,
  bot: string,
  jobId: string,
  limit = 20,
): Promise<BotRoutineRunRecord[]> {
  await findBotRoutineJob(port, bot, jobId);
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
  const reply = asRecord(await dashboard(port, "run history")<unknown>(
    `${cronJobPath(jobId, bot, "/runs")}&limit=${bounded}`,
  ));
  const runs = Array.isArray(reply?.["runs"]) ? (reply["runs"] as unknown[]) : [];
  return runs.flatMap((entry) => {
    const run = asRecord(entry);
    const id = asString(run?.["id"]);
    if (run === undefined || id === undefined) return [];
    const status = asString(run["end_reason"]);
    const title = asString(run["title"]);
    return [{
      id,
      startedAt: secondsToMs(run["started_at"]),
      endedAt: secondsToMs(run["ended_at"]),
      ...(status === undefined ? {} : { status }),
      ...(title === undefined ? {} : { title }),
      ...(typeof run["is_active"] === "boolean" ? { active: run["is_active"] } : {}),
    }];
  });
}

export const ROUTINE_RUN_OUTPUT_MAX_LENGTH = 16_000;

/** One run's final reply: the last non-empty assistant message of that run's session. The run id
 *  must be one of THIS routine's runs (`cron_<jobId>_...`), so the route cannot read an arbitrary
 *  conversation of the bot. */
export async function readBotRoutineRunOutput(
  port: HermesRoutinesPort,
  bot: string,
  jobId: string,
  runId: string,
): Promise<string | null> {
  await findBotRoutineJob(port, bot, jobId);
  if (!runId.startsWith(`cron_${jobId}_`)) throw new RoutineNotFound(runId);
  const reply = asRecord(await dashboard(port, "run output")<unknown>(
    `/api/sessions/${encodeURIComponent(runId)}/messages?profile=${encodeURIComponent(bot)}`,
  ));
  const messages = Array.isArray(reply?.["messages"]) ? (reply["messages"] as unknown[]) : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.["role"] !== "assistant") continue;
    const text = messageText(message["content"]);
    if (text === undefined) continue;
    // The same projection every other transcript surface applies (control bytes, image directives,
    // host paths), plus the `~/` rule routine delivery errors use.
    const output = projectHermesSessionText(redactHomePaths(text), ROUTINE_RUN_OUTPUT_MAX_LENGTH);
    if (output.length > 0) return output;
  }
  return null;
}

/** A message's text: a plain string, or the text parts of a content-part array. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = asRecord(part);
    const type = record?.["type"];
    const text = asString(record?.["text"]);
    return text === undefined || (type !== undefined && type !== "text") ? [] : [text];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** Hermes's automation blueprint catalog, for this bot's profile (the deliver slot's options are
 *  the platforms that profile has configured). */
export async function listRoutineBlueprints(port: HermesRoutinesPort, bot: string): Promise<BotRoutineBlueprint[]> {
  const reply = asRecord(await dashboard(port, "blueprint list")<unknown>(
    `/api/cron/blueprints?profile=${encodeURIComponent(bot)}`,
  ));
  const list = Array.isArray(reply?.["blueprints"]) ? (reply["blueprints"] as unknown[]) : [];
  return list.flatMap((entry) => {
    const row = asRecord(entry);
    const key = asString(row?.["key"]);
    const title = asString(row?.["title"]);
    if (row === undefined || key === undefined || title === undefined) return [];
    const fields = (Array.isArray(row["fields"]) ? (row["fields"] as unknown[]) : []).flatMap((value) => {
      const field = asRecord(value);
      const name = asString(field?.["name"]);
      if (field === undefined || name === undefined) return [];
      const fallback = field["default"];
      const help = asString(field["help"]);
      return [{
        name,
        type: asString(field["type"]) ?? "text",
        label: asString(field["label"]) ?? name,
        ...(fallback === undefined || fallback === null ? {} : { default: String(fallback) }),
        options: (Array.isArray(field["options"]) ? (field["options"] as unknown[]) : []).map(String),
        optional: field["optional"] === true,
        ...(help === undefined || help.length === 0 ? {} : { help }),
      }];
    });
    const description = asString(row["description"]);
    const category = asString(row["category"]);
    const scheduleHuman = asString(row["scheduleHuman"]);
    return [{
      key,
      title,
      ...(description === undefined ? {} : { description }),
      ...(category === undefined ? {} : { category }),
      ...(scheduleHuman === undefined ? {} : { scheduleHuman }),
      fields,
    }];
  });
}

/** Creates a blueprint's job in this bot's cron store, and answers the routine as `cron.manage`
 *  lists it. */
export async function instantiateRoutineBlueprint(
  port: HermesRoutinesPort,
  bot: string,
  key: string,
  values: Record<string, string>,
): Promise<BotRoutine> {
  const created = asRecord(await dashboard(port, "blueprint create")<unknown>(
    `/api/cron/blueprints/instantiate?profile=${encodeURIComponent(bot)}`,
    { method: "POST", body: { blueprint: key, values } },
  ));
  const job = asRecord(created?.["job"]) ?? created;
  const id = asString(job?.["id"]) ?? asString(job?.["job_id"]);
  if (id === undefined) throw new RoutineUnconfirmed(undefined, "the blueprint reply carried no job id");
  try {
    return await withFullInstruction(port, bot, await findBotRoutineJob(port, bot, id));
  } catch (err) {
    throw new RoutineUnconfirmed(id, err instanceof Error ? err.message : String(err));
  }
}
