import type { AssignmentRefusal, AssignmentResult } from "cozygateway-contract";

/** agent-inbox 1. The pure rules of a leader assignment: caps, the prompt the assignee reads, the
 * `Result:` block it answers with, and the refusal wording. No I/O and no clock. */

export const ASSIGNMENT_MAX_OPEN_PER_LEADER = 8;
export const ASSIGNMENT_MAX_REPORTS = 16;
export const ASSIGNMENT_DEFAULT_DEADLINE_MS = 30 * 60_000;
// The state rules live beside Storage, which freezes a deleted assignee's rows with them.
export {
  ASSIGNMENT_OPEN_STATES, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS, deriveAssignmentState, frozenOnDelete,
  type AssignmentFacts,
} from "../assignment-state.ts";

export interface AssignmentBrief {
  leaderDisplayName: string;
  brief: string;
  doneCriteria: string;
  outputFormat?: string;
  deadlineAt: number;
}

/** The whole turn text. It depends on nothing in the turn's typed `context`, which is what keeps
 * capability 47's byte-identical rule for a peer that ignores the context. */
export function buildAssignmentPrompt(input: AssignmentBrief, formatDeadline: (at: number) => string): string {
  return [
    `[Task from ${input.leaderDisplayName}] ${input.brief}`,
    `Done when: ${input.doneCriteria}`,
    `Reply format: ${input.outputFormat ?? "a short result followed by a `Result:` block"}`,
    `Deadline: ${formatDeadline(input.deadlineAt)}`,
    "End your reply with a `Result:` block listing status (done | partial | blocked), what changed, and any artifacts as paths or links.",
  ].join("\n");
}

const STATUSES = new Set(["done", "partial", "blocked"]);
/** `Result:`, also bolded (`**Result:**`, `**Result**:`) and with text after it on the same line. */
const RESULT_LINE = /^(?:\*\*|__)?Result(?::(?:\*\*|__)?|(?:\*\*|__):)(.*)$/;
const SUMMARY_KEY = /^(?:summary|changed|what changed)\s*:\s*(.*)$/i;

/** The artifact references in one `artifacts:` text: the text after the key, or one bullet under
 * it. Each Markdown link `[text](url)` is first replaced by its URL; the text is then split at
 * each comma followed by whitespace or ending it, so a comma inside a URL splits nothing. Each
 * part is judged on its own by `artifactReference`, and prose parts are dropped. CozyAgents'
 * bundled gateway applies the same rule (contract/ext-bots-v1.md, Leader assignments). */
export function artifactReferences(text: string): string[] {
  return text.replace(/\[[^\]]*\]\(([^()\s]+)\)/g, "$1").split(/,(?=\s|$)/)
    .map(artifactReference).filter((reference) => reference !== undefined);
}

/** One part, trimmed and unwrapped from one pair of backticks, is a reference when it has no
 * whitespace and is: a URL (`scheme://...`); else, never `n/a` in any case, nor an email address
 * (an `@` with no `/`); a path (a `/`); or a file name (ending in `.` and an extension of letters
 * and digits with at least one letter). So `none`, `N/A`, `v1.2`, `kyle@example.com` and `e.g.`
 * are prose. */
export function artifactReference(part: string): string | undefined {
  const token = part.trim().replace(/^`([^`]+)`$/, "$1");
  if (token.length === 0 || /\s/.test(token)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return token;
  if (/^n\/a$/i.test(token) || (token.includes("@") && !token.includes("/"))) return undefined;
  return token.includes("/") || /\.[a-z0-9]*[a-z][a-z0-9]*$/i.test(token) ? token : undefined;
}

/** The last `Result:` block in the reply, or `undefined` when there is none or its status is not
 * one of the three words. A missing result is recorded as missing and never invented. */
export function parseResultBlock(text: string): AssignmentResult | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findLastIndex((line) => RESULT_LINE.test(line));
  if (start < 0) return undefined;
  let status: string | undefined;
  const summary: string[] = [];
  const artifacts: string[] = [];
  let listing = false;
  // `Result: done` names the status on the header line; other text there is summary.
  const inline = RESULT_LINE.exec(lines[start]!)![1]!.trim();
  const body = inline.length === 0 ? [] : [STATUSES.has(inline.toLowerCase().replace(/[.*_]/g, "")) ? `status: ${inline.replace(/[.*_]/g, "")}` : inline];
  for (const raw of [...body, ...lines.slice(start + 1)]) {
    // Markdown emphasis around a key (`**Status:** done`) is formatting, not content.
    const line = raw.replace(/\*\*|__/g, "").trim();
    if (line.length === 0) continue;
    const bullet = /^[-*]\s+/.test(line);
    const content = line.replace(/^[-*]\s+/, "");
    const statusMatch = /^status\s*:\s*(.*)$/i.exec(content);
    const artifactsMatch = /^artifacts\s*:\s*(.*)$/i.exec(content);
    const summaryMatch = SUMMARY_KEY.exec(content);
    // Keys first. The `artifacts:` text and each bullet under it keep only their references and
    // never reach `summary`; any other line ends the listing.
    if (statusMatch !== null) {
      status = statusMatch[1]!.trim().toLowerCase();
      listing = false;
    } else if (artifactsMatch !== null) {
      artifacts.push(...artifactReferences(artifactsMatch[1]!));
      listing = true;
    } else if (summaryMatch !== null) {
      summary.push(summaryMatch[1]!);
      listing = false;
    } else if (bullet && listing) {
      artifacts.push(...artifactReferences(content));
    } else {
      summary.push(content);
      listing = false;
    }
  }
  if (status === undefined || !STATUSES.has(status)) return undefined;
  const kept = [...new Set(artifacts.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 1024))];
  return {
    status: status as AssignmentResult["status"],
    summary: summary.join(" ").trim().slice(0, 4096),
    artifacts: kept.slice(0, 32),
  };
}

export function refusalMessage(reason: AssignmentRefusal, detail: { leader: string; assignee: string }): string {
  switch (reason) {
    case "not_leader": return `${detail.leader} is not a leader`;
    case "not_a_report": return `${detail.assignee} is not on ${detail.leader}'s team`;
    case "assignee_busy": return `${detail.assignee} already has an open assignment`;
    case "assignee_unavailable": return `${detail.assignee} is not attached to this gateway`;
    case "leader_task_cap": return `${detail.leader} already has ${ASSIGNMENT_MAX_OPEN_PER_LEADER} open assignments`;
    case "not_verifying": return `the assignment for ${detail.assignee} is not waiting on ${detail.leader}'s acknowledgement`;
  }
}
