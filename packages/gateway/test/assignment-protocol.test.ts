import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_DEFAULT_DEADLINE_MS,
  ASSIGNMENT_MAX_OPEN_PER_LEADER,
  ASSIGNMENT_OPEN_STATES,
  ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS,
  buildAssignmentPrompt,
  deriveAssignmentState,
  parseResultBlock,
  refusalMessage,
} from "../src/hermes-bridge/assignment-protocol.ts";

describe("assignment prompt", () => {
  it("reproduces the spec's five lines and never names a council", () => {
    const text = buildAssignmentPrompt({ leaderDisplayName: "Lead", brief: "Check CI", doneCriteria: "main is green", deadlineAt: 10 }, () => "3:30 PM");
    expect(text.split("\n")).toEqual([
      "[Task from Lead] Check CI",
      "Done when: main is green",
      "Reply format: a short result followed by a `Result:` block",
      "Deadline: 3:30 PM",
      "End your reply with a `Result:` block listing status (done | partial | blocked), what changed, and any artifacts as paths or links.",
    ]);
    expect(text.toLowerCase()).not.toContain("council");
  });

  it("uses the leader's output format when given", () => {
    const text = buildAssignmentPrompt({ leaderDisplayName: "Lead", brief: "b", doneCriteria: "d", outputFormat: "JSON", deadlineAt: 10 }, () => "x");
    expect(text).toContain("Reply format: JSON");
  });
});

describe("Result: block", () => {
  it("parses status, summary and artifacts from the last Result: block", () => {
    const parsed = parseResultBlock("Result:\nstatus: partial\nold\nI looked.\nResult:\nstatus: done\nCI is green on main.\nartifacts:\n- ci/log.txt\n- https://ci/run/9");
    expect(parsed).toEqual({ status: "done", summary: "CI is green on main.", artifacts: ["ci/log.txt", "https://ci/run/9"] });
  });

  it("returns undefined when there is no block or the status is not one of the three words", () => {
    expect(parseResultBlock("I looked and it is fine.")).toBeUndefined();
    expect(parseResultBlock("Result:\nstatus: finished")).toBeUndefined();
    expect(parseResultBlock("Result:\nIt went fine.")).toBeUndefined();
  });

  it("accepts an inline comma list and bulleted keys, dedupes, and caps at 32", () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.txt`).join(", ");
    const parsed = parseResultBlock(`Result:\n- Status: Blocked\n- what changed: nothing yet\nartifacts: a.txt, a.txt, ${many}`);
    expect(parsed?.status).toBe("blocked");
    expect(parsed?.summary).toBe("nothing yet");
    expect(parsed?.artifacts).toHaveLength(32);
    expect(parsed?.artifacts[0]).toBe("a.txt");
  });
});

describe("Result: artifacts are paths or links, never prose", () => {
  it("keeps a prose artifacts line whole in the summary instead of comma-splitting it", () => {
    // The e2e reply: the old parser split this line at its comma into two nonsense references.
    const reply = [
      "Caveat: these timestamps are the workspace init checkpoint time.",
      "",
      "Result:",
      "- status: partial",
      "- what changed: nothing (read-only)",
      "- artifacts: none; the three names above with the init timestamp, with the tie caveat noted",
      "",
      "Deadline 9:39 AM CDT met.",
    ].join("\n");
    expect(parseResultBlock(reply)).toEqual({
      status: "partial",
      summary: "nothing (read-only) artifacts: none; the three names above with the init timestamp, with the tie caveat noted Deadline 9:39 AM CDT met.",
      artifacts: [],
    });
    expect(parseResultBlock("Result: done\nartifacts: none")).toEqual({ status: "done", summary: "artifacts: none", artifacts: [] });
  });

  it("splits a line only when every part is one path, file name or link, backticks aside", () => {
    expect(parseResultBlock("Result: done\nartifacts: `src/a.ts`, https://ci/run/9, notes.md,")?.artifacts)
      .toEqual(["src/a.ts", "https://ci/run/9", "notes.md"]);
    expect(parseResultBlock("Result: done\nartifacts: src/a.ts, the rest is in chat")).toEqual({
      status: "done", summary: "artifacts: src/a.ts, the rest is in chat", artifacts: [],
    });
  });

  it("tests each bullet under artifacts on its own", () => {
    const parsed = parseResultBlock("Result:\n- status: done\n- artifacts: a.txt\n- what changed: the docs\nartifacts:\n- b/c.md\n- see above\n- d.txt");
    expect(parsed).toEqual({ status: "done", summary: "the docs see above", artifacts: ["a.txt", "b/c.md", "d.txt"] });
  });
});

describe("Result: block tolerance", () => {
  it("accepts a bolded header, bolded keys, and a status on the header line", () => {
    expect(parseResultBlock("Done.\n**Result:**\n**Status:** partial\nHalf of it.")).toEqual({ status: "partial", summary: "Half of it.", artifacts: [] });
    expect(parseResultBlock("**Result**:\nstatus: done")?.status).toBe("done");
    expect(parseResultBlock("Result: done\nAll green.\nartifacts: a.txt")).toEqual({ status: "done", summary: "All green.", artifacts: ["a.txt"] });
    expect(parseResultBlock("Result: blocked")?.status).toBe("blocked");
    expect(parseResultBlock("Result: it went fine")).toBeUndefined();
    expect(parseResultBlock("Resulting in nothing\nstatus: done")).toBeUndefined();
  });
});

describe("state derivation", () => {
  const base = { deadlineAt: 1_000 };
  it("mirrors a live Task, with a device wait as blocked and a Task still proving its work as running", () => {
    expect(deriveAssignmentState({ ...base, taskState: "queued" }, 0)).toBe("queued");
    expect(deriveAssignmentState({ ...base, taskState: "running" }, 0)).toBe("running");
    expect(deriveAssignmentState({ ...base, taskState: "waiting_for_approval" }, 0)).toBe("waiting_for_approval");
    expect(deriveAssignmentState({ ...base, taskState: "waiting_for_device" }, 0)).toBe("blocked");
    expect(deriveAssignmentState({ ...base, taskState: "verifying" }, 0)).toBe("running");
  });

  it("verifies on Task completion until the leader acknowledges or 24 hours pass", () => {
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0 }, 5)).toBe("verifying");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0 }, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS)).toBe("completed");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0, acknowledgedOutcome: "failed" }, 5)).toBe("failed");
  });

  it("fails past the deadline, and says cancelled only once the Task has settled", () => {
    expect(deriveAssignmentState({ ...base, taskState: "running" }, 1_000)).toBe("failed");
    expect(deriveAssignmentState({ ...base, taskState: "running", failure: "boom" }, 0)).toBe("failed");
    expect(deriveAssignmentState({ ...base, taskState: "running", cancelledBy: "leader" }, 0)).toBe("running");
    expect(deriveAssignmentState({ ...base, taskState: "cancelled", cancelledBy: "leader" }, 0)).toBe("cancelled");
    expect(deriveAssignmentState({ ...base, taskState: "cancelled", failure: "deadline" }, 2_000)).toBe("failed");
    expect(deriveAssignmentState({ ...base, taskState: "cancelled" }, 0)).toBe("cancelled");
    expect(deriveAssignmentState({ ...base, taskState: "failed" }, 0)).toBe("failed");
  });

  it("ignores a cancel that lost the race to a completed Task, and closes a blocked result as failed", () => {
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0, cancelledBy: "leader" }, 5)).toBe("verifying");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0, resultStatus: "blocked" }, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS)).toBe("failed");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0, resultStatus: "partial" }, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS)).toBe("completed");
    expect(deriveAssignmentState({ ...base, frozenState: "cancelled" }, 0)).toBe("cancelled");
  });

  it("exports the caps and the open set the spec names", () => {
    expect(ASSIGNMENT_MAX_OPEN_PER_LEADER).toBe(8);
    expect(ASSIGNMENT_DEFAULT_DEADLINE_MS).toBe(30 * 60_000);
    expect([...ASSIGNMENT_OPEN_STATES].sort()).toEqual(["blocked", "queued", "running", "verifying", "waiting_for_approval", "waiting_for_user_input"]);
    expect(refusalMessage("not_a_report", { leader: "lead", assignee: "scout" })).toBe("scout is not on lead's team");
  });
});
