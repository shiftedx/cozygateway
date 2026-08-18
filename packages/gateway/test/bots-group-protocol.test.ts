import { describe, expect, it } from "vitest";

import {
  GROUP_HISTORY_LIMIT,
  GROUP_LOG_LIMIT,
  GROUP_MAX_MEMBERS,
  GROUP_MAX_MESSAGES,
  GROUP_MAX_ROUNDS,
  GROUP_MIN_MEMBERS,
  buildTurnPrompt,
  deltaSince,
  formatLine,
  groupSessionTitle,
  highestSeq,
  isPassText,
  memberMentionForms,
  mentionsUser,
  parseMentions,
  resolveResponders,
  rotateSpeakers,
  type GroupLogEntry,
  type GroupMember,
} from "../src/hermes-bridge/group-protocol.ts";

/** The deliberation rules, in isolation. Every expectation here is the Hermes desktop plugin's
 *  behavior (dissection 9.1 and 9.3 to 9.5): a room hosted by this gateway has to be recognizable to
 *  someone who has used the desktop one, and these are the rules that make it so. */

const scout: GroupMember = { name: "scout", handle: "scout", displayName: "Scout" };
const luna: GroupMember = { name: "luna", handle: "luna", displayName: "Luna the Planner" };
const opsRunner: GroupMember = { name: "ops-runner", handle: "ops-runner", displayName: "Ops Runner" };
const members = [scout, luna, opsRunner];

function entry(seq: number, kind: "user" | "member", name: string, text: string): GroupLogEntry {
  const member = members.find((candidate) => candidate.name === name);
  return {
    seq,
    kind,
    name,
    displayName: kind === "user" ? "You" : (member?.displayName ?? name),
    text,
    at: 1_800_000_000_000 + seq,
  };
}

describe("caps", () => {
  it("are the desktop's own numbers", () => {
    expect(GROUP_MAX_ROUNDS).toBe(3);
    expect(GROUP_MAX_MESSAGES).toBe(10);
    expect(GROUP_HISTORY_LIMIT).toBe(24);
    expect(GROUP_LOG_LIMIT).toBe(96);
    expect(GROUP_MIN_MEMBERS).toBe(2);
    expect(GROUP_MAX_MEMBERS).toBe(6);
  });
});

describe("memberMentionForms", () => {
  it("covers the name, the collapsed name, the title, and the title's first word", () => {
    expect(memberMentionForms(luna)).toEqual(
      expect.arrayContaining(["luna", "luna the planner", "lunatheplanner", "luna"]),
    );
    expect(memberMentionForms(opsRunner)).toEqual(expect.arrayContaining(["ops-runner", "opsrunner", "ops runner"]));
  });
});

describe("parseMentions", () => {
  it("resolves a member by name, by separator variant, and by the title's first word", () => {
    expect(parseMentions("@scout can you look", members).members).toEqual(new Set(["scout"]));
    expect(parseMentions("@ops_runner deploy it", members).members).toEqual(new Set(["ops-runner"]));
    expect(parseMentions("@opsrunner deploy it", members).members).toEqual(new Set(["ops-runner"]));
    expect(parseMentions("@Luna thoughts?", members).members).toEqual(new Set(["luna"]));
  });

  it("treats @everyone and @all as the whole room", () => {
    expect(parseMentions("@everyone standup", members).everyone).toBe(true);
    expect(parseMentions("@all standup", members).everyone).toBe(true);
  });

  it("never resolves @user to a member: it is the human", () => {
    const parsed = parseMentions("@user should decide", members);
    expect(parsed.everyone).toBe(false);
    expect(parsed.members.size).toBe(0);
  });

  it("ignores a mention that names nobody in the room", () => {
    expect(parseMentions("@nobody hello", members).members.size).toBe(0);
  });
});

describe("mentionsUser", () => {
  it("is word bounded", () => {
    expect(mentionsUser("@user please confirm")).toBe(true);
    expect(mentionsUser("ask @User about it")).toBe(true);
    expect(mentionsUser("the @userland build")).toBe(false);
    expect(mentionsUser("nothing to see")).toBe(false);
  });

  it("is bounded on the LEFT too, so an email address is not a summons", () => {
    // Upstream's rule fires on both of these. Here the escalation sets durable room state and
    // raises a push, so a bot quoting a support address must not page the human.
    expect(mentionsUser("mail me at a@user.io")).toBe(false);
    expect(mentionsUser("escalate to ops@user.example.com")).toBe(false);
    expect(mentionsUser("see docs.@user")).toBe(false);
    // Still an escalation in every shape a model actually writes one.
    expect(mentionsUser("@user")).toBe(true);
    expect(mentionsUser("hey @user, thoughts?")).toBe(true);
    expect(mentionsUser("(@user should decide)")).toBe(true);
    expect(mentionsUser("line one\n@user look at this")).toBe(true);
  });
});

describe("resolveResponders", () => {
  it("returns everyone when the user named nobody", () => {
    const log = [entry(1, "user", "You", "how is the release looking")];
    expect(resolveResponders(log, members).map((m) => m.name)).toEqual(["scout", "luna", "ops-runner"]);
  });

  it("scopes to the members mentioned since the last user message", () => {
    const log = [
      entry(1, "user", "You", "@scout status?"),
      entry(2, "member", "scout", "CI is green"),
    ];
    expect(resolveResponders(log, members).map((m) => m.name)).toEqual(["scout"]);
  });

  it("pulls in a member a teammate mentioned, on the next round", () => {
    const log = [
      entry(1, "user", "You", "@scout status?"),
      entry(2, "member", "scout", "green, @luna can you plan the cut"),
    ];
    expect(resolveResponders(log, members).map((m) => m.name)).toEqual(["scout", "luna"]);
  });

  it("expands to everyone when @everyone appears anywhere in the slice", () => {
    const log = [
      entry(1, "user", "You", "@scout status?"),
      entry(2, "member", "scout", "@everyone weigh in"),
    ];
    expect(resolveResponders(log, members)).toHaveLength(3);
  });

  it("only reads the slice since the LAST user message", () => {
    const log = [
      entry(1, "user", "You", "@scout status?"),
      entry(2, "member", "scout", "green"),
      entry(3, "user", "You", "@luna next steps?"),
    ];
    expect(resolveResponders(log, members).map((m) => m.name)).toEqual(["luna"]);
  });
});

describe("rotateSpeakers", () => {
  it("left-rotates by the round so a different member leads each time", () => {
    expect(rotateSpeakers(members, 0).map((m) => m.name)).toEqual(["scout", "luna", "ops-runner"]);
    expect(rotateSpeakers(members, 1).map((m) => m.name)).toEqual(["luna", "ops-runner", "scout"]);
    expect(rotateSpeakers(members, 2).map((m) => m.name)).toEqual(["ops-runner", "scout", "luna"]);
    expect(rotateSpeakers(members, 3).map((m) => m.name)).toEqual(["scout", "luna", "ops-runner"]);
  });

  it("is a no-op below two speakers", () => {
    expect(rotateSpeakers([scout], 1).map((m) => m.name)).toEqual(["scout"]);
    expect(rotateSpeakers([], 2)).toEqual([]);
  });
});

describe("isPassText", () => {
  it("accepts every shape of pass a model actually emits", () => {
    for (const text of ["(pass)", "pass", "Pass.", " (PASS) ", "(pass).", "", "   "]) {
      expect(isPassText(text)).toBe(true);
    }
  });

  it("treats a null or absent reply as a pass, and real text as speech", () => {
    expect(isPassText(null)).toBe(true);
    expect(isPassText(undefined)).toBe(true);
    expect(isPassText("passing the build to luna")).toBe(false);
  });
});

describe("formatLine", () => {
  it("tags the human, the viewer, and leaves peers untagged", () => {
    expect(formatLine(entry(1, "user", "You", "hi"), scout)).toBe("You (user): hi");
    expect(formatLine(entry(2, "member", "scout", "on it"), scout)).toBe("Scout (you): on it");
    expect(formatLine(entry(3, "member", "luna", "plan drafted"), scout)).toBe("Luna the Planner: plan drafted");
  });
});

describe("buildTurnPrompt", () => {
  const log = [entry(1, "user", "You", "how is the release looking"), entry(2, "member", "luna", "plan drafted")];

  it("names the viewer, lists the peers with their handles, and quotes the delta", () => {
    const prompt = buildTurnPrompt("Release Room", members, scout, log);
    expect(prompt.startsWith('[Group chat: "Release Room"] You are @scout, one participant in a group chat with ')).toBe(
      true,
    );
    expect(prompt).toContain("Luna the Planner (@luna), Ops Runner (@ops-runner) and the user.");
    expect(prompt).toContain("New messages in the room since your last turn (oldest first):");
    expect(prompt).toContain("  You (user): how is the release looking");
    expect(prompt).toContain("  Luna the Planner: plan drafted");
  });

  it("carries the room rules in the turn payload, so no bot needs a profile migration", () => {
    const prompt = buildTurnPrompt("Release Room", members, scout, log);
    expect(prompt).toContain("Rules for this room:");
    expect(prompt).toContain('reply with exactly "(pass)"');
    expect(prompt).toContain("mention @user only for a judgment call");
    expect(prompt).toContain("Never reveal content from your private 1:1 chats");
  });

  it("says so plainly when the viewer has no peers yet", () => {
    expect(buildTurnPrompt("Solo", [scout], scout, log)).toContain("with no one else yet and the user.");
  });

  it("quotes at most the last 24 delta lines", () => {
    const long = Array.from({ length: 40 }, (_, index) => entry(index + 1, "user", "You", `line ${index + 1}`));
    const prompt = buildTurnPrompt("Room", members, scout, long);
    expect(prompt).toContain("line 40");
    expect(prompt).toContain("line 17");
    expect(prompt).not.toContain("line 16");
  });
});

describe("watermarks", () => {
  const log = [entry(1, "user", "You", "a"), entry(2, "member", "scout", "b"), entry(3, "member", "luna", "c")];

  it("hands a member exactly what it has not seen", () => {
    expect(deltaSince(log, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(deltaSince(log, 2).map((e) => e.seq)).toEqual([3]);
    expect(deltaSince(log, 3)).toEqual([]);
  });

  it("survives a trimmed head, which an index-based watermark would not", () => {
    // The desktop shifts every watermark down when it trims; a seq cannot be invalidated that way.
    const trimmed = log.slice(2);
    expect(deltaSince(trimmed, 2).map((e) => e.seq)).toEqual([3]);
    expect(highestSeq(trimmed)).toBe(3);
    expect(highestSeq([], 7)).toBe(7);
  });
});

describe("groupSessionTitle", () => {
  it("is the desktop's exact convention, since the title doubles as a lookup key", () => {
    expect(groupSessionTitle("Release Room")).toBe("Group: Release Room");
  });
});
