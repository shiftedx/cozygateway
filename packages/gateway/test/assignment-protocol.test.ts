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

describe("Result: artifacts are paths, file names or links, never prose", () => {
  const artifactsOf = (block: string) => parseResultBlock(`Result: done\n${block}`)?.artifacts;

  // [what the reply says after `Result: done`, the artifacts it names]
  const table: Array<[string, string[]]> = [
    // A path, a file name, a link, each on its own.
    ["artifacts: src/a.ts", ["src/a.ts"]],
    ["artifacts: notes.md", ["notes.md"]],
    ["artifacts: https://ci/run/9", ["https://ci/run/9"]],
    ["artifacts: `src/a.ts`, https://ci/run/9, notes.md,", ["src/a.ts", "https://ci/run/9", "notes.md"]],
    // A Markdown link counts by its URL, and a comma inside a URL does not split it.
    ["artifacts: [CI run](https://ci/run/9)", ["https://ci/run/9"]],
    ["artifacts: [CI, run 9](https://ci/run/9), b.md", ["https://ci/run/9", "b.md"]],
    ["artifacts: https://ci/runs?ids=1,2,3", ["https://ci/runs?ids=1,2,3"]],
    ["artifacts:\n- [CI run](https://ci/run/9)\n- https://ci/runs?ids=1,2", ["https://ci/run/9", "https://ci/runs?ids=1,2"]],
    // Placeholders, versions, addresses and abbreviations are prose.
    ["artifacts: N/A", []],
    ["artifacts: n/a", []],
    ["artifacts: none", []],
    ["artifacts: v1.2", []],
    ["artifacts: kyle@example.com", []],
    ["artifacts: e.g.", []],
    ["artifacts:\n- N/A\n- none\n- v1.2\n- kyle@example.com\n- e.g.", []],
    // Each part is judged on its own: a reference beside prose is kept.
    ["artifacts: src/a.ts, the rest is in chat", ["src/a.ts"]],
    // Prose on the `artifacts:` line does not cost the bullets under it.
    ["artifacts: two files\n- a.md\n- b/c.ts", ["a.md", "b/c.ts"]],
    ["artifacts:\n- b/c.md\n- see above\n- d.txt", ["b/c.md", "d.txt"]],
    // The e2e reply's line, which the old parser split into two nonsense references.
    ["- artifacts: none; the three names above with the init timestamp, with the tie caveat noted", []],
  ];

  it.each(table)("%j names %j", (block, expected) => {
    expect(artifactsOf(block)).toEqual(expected);
  });

  it("never adds the artifacts line's own text to the summary", () => {
    expect(parseResultBlock("Result: done\nartifacts: none")).toEqual({ status: "done", summary: "", artifacts: [] });
    const reply = [
      "Caveat: these timestamps are the workspace init checkpoint time.",
      "",
      "Result:",
      "- status: partial",
      "- what changed: nothing (read-only)",
      "- artifacts: none; the three names above with the init timestamp, with the tie caveat noted",
    ].join("\n");
    expect(parseResultBlock(reply)).toEqual({ status: "partial", summary: "nothing (read-only)", artifacts: [] });
  });

  it("reads a key bullet after the artifacts as its key, not as an artifact", () => {
    expect(parseResultBlock("Result:\n- status: done\n- artifacts: a.txt\n- what changed: the docs\nThen more.")).toEqual({
      status: "done", summary: "the docs Then more.", artifacts: ["a.txt"],
    });
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
