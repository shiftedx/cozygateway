/** Capability 66: typed scoped approvals (contract/ext-bots-v1.md row 66). A runtime peer that
 *  must ask before acting sends one typed `scope` block naming the action, the target, the exact
 *  material change, the side effects, why approval is required, the payload hash, the expiration
 *  and the retry behaviour. The gateway validates the block, carries it on every approval surface,
 *  and records the person's decision as a standing grant bound to profile, user, conversation,
 *  task, target, payload hash and expiration. A grant is consulted, never replayed: a changed
 *  payload hash, a passed expiration, a revoked grant, or an always-require category all force a
 *  fresh decision. */
import { describe, expect, it } from "vitest";
import type { BotApprovalPendingFrame, BotApprovalScope, ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  resolutions: Array<{ approvalId: string; decision: string }>;
  setNow: (value: number) => void;
  close: () => void;
}

async function startTurn(): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000;
  let sent: Record<string, unknown> | undefined;
  const resolutions: Array<{ approvalId: string; decision: string }> = [];
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      sent = input;
      storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
      return true;
    },
    sendNativeInterrupt: () => true,
    sendApprovalResolution: () => true,
    // Mirrors the real ingress, including capability 66's override: a replacement command carries
    // its own id, because the outbox holds one command per id per peer.
    requestNativeApprovalResolution: (
      _peer: string,
      input: { threadId: string; turnId: string; approvalId: string; decision: string },
      sourceBot: string,
      opts?: { override?: boolean },
    ) => {
      resolutions.push({ approvalId: input.approvalId, decision: input.decision });
      const result = storage.requestNativeInteractionResolution({
        bot: sourceBot,
        kind: "approval",
        interactionId: input.approvalId,
        decision: input.decision,
        commandId: opts?.override === true
          ? `approval:${sourceBot}:${input.approvalId}:${input.decision}`
          : `approval:${sourceBot}:${input.approvalId}`,
        command: { kind: "resolve_approval", ...input } as never,
        requestedAt: now,
        ...(opts?.override === true ? { override: true } : {}),
      });
      return result;
    },
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "move the money", {
    clientId: "client-1",
  });
  return {
    storage,
    plane,
    frames,
    resolutions,
    sessionId: accepted.sessionId,
    turnId: String(sent?.turnId),
    setNow: (value) => {
      now = value;
    },
    close: () => {
      plane.close();
      storage.close();
    },
  };
}

function approvalEvent(
  sessionId: string,
  turnId: string,
  approvalId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "event" as const,
    sequence: 1,
    eventId: approvalId,
    event: {
      kind: "approval" as const,
      threadId: sessionId,
      turnId,
      approvalId,
      callId: `call-${approvalId}`,
      name: "workspace_write",
      status: "pending" as const,
      ...extra,
    },
  };
}

function pendingFrames(frames: ServerFrame[]): BotApprovalPendingFrame[] {
  return frames.filter(
    (frame): frame is BotApprovalPendingFrame => frame.type === "bot_approval_pending",
  );
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const scope: BotApprovalScope = {
  kind: "scoped_approval",
  action: "workspace.write",
  category: "other",
  system: "workspace",
  resource: "repo/notes.md",
  change: "append one line to notes.md",
  effects: ["one file changes on disk"],
  reason: "guardrail",
  payloadHash: HASH_A,
  expiresAt: 9_000_000,
  retry: "idempotent",
  requested: "once",
};

describe("typed scoped approvals (capability 66)", () => {
  it("carries the validated block on the live frame, the durable row, the inbox and the rebroadcast", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }))).toBe(true);

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending[0]!.scope)).toBe(JSON.stringify(scope));

    const row = storage.nativeInteraction("sage", "approval", "approval-1");
    expect(JSON.stringify((row?.payload as { scope?: unknown }).scope)).toBe(JSON.stringify(scope));

    const inbox = plane.surface().pendingApprovals();
    expect(JSON.stringify(inbox[0]!.scope)).toBe(JSON.stringify(scope));

    await plane.surface().chatHistory("sage");
    const rebroadcast = pendingFrames(harness.frames).slice(1);
    expect(JSON.stringify(rebroadcast[0]!.scope)).toBe(JSON.stringify(scope));
    harness.close();
  });

  it("drops an invalid block and keeps the approval", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    const invalid: Record<string, unknown> = {
      "approval-hash": { ...scope, payloadHash: "not-a-sha256" },
      "approval-category": { ...scope, category: "vibes" },
      // \u0000 (NUL, C0) inside the target resource.
      "approval-control": { ...scope, resource: "repo/no\u0000tes.md" },
      "approval-retry": { ...scope, retry: "maybe" },
    };
    for (const [approvalId, block] of Object.entries(invalid))
      expect(plane.handle("sage", approvalEvent(sessionId, turnId, approvalId, { scope: block }))).toBe(true);

    expect(pendingFrames(harness.frames).map((frame) => frame.toolCallId).sort())
      .toEqual(Object.keys(invalid).sort());
    for (const frame of pendingFrames(harness.frames)) expect(frame).not.toHaveProperty("scope");
    for (const approvalId of Object.keys(invalid))
      expect(storage.nativeInteraction("sage", "approval", approvalId)?.payload).not.toHaveProperty("scope");
    harness.close();
  });

  it("leaves an approval without a block byte identical to its pre-66 self", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1"))).toBe(true);

    const frame = pendingFrames(harness.frames)[0]!;
    expect(Object.keys(frame).sort()).toEqual(
      ["bot", "sessionId", "toolCallId", "turnId", "type", "name", "updatedAt"].sort(),
    );
    expect(storage.nativeInteraction("sage", "approval", "approval-1")?.payload)
      .toEqual({ name: "workspace_write" });
    expect(Object.keys(plane.surface().pendingApprovals()[0]!).sort())
      .toEqual(["bot", "sessionId", "turnId", "toolCallId", "ruleName", "createdAt"].sort());
    harness.close();
  });

  it("records no standing grant for a plain approve, so the next identical ask asks again", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    // A body-less approve is one decision on one ask. It is the request every client below 66
    // sends and the request a person makes by tapping Approve, and it leaves no policy behind.
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1"))
      .toBe("requested");
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { scope }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    expect(pendingFrames(harness.frames).map((frame) => frame.toolCallId))
      .toEqual(["approval-1", "approval-2"]);
    harness.close();
  });

  it("covers exactly one later ask with an explicit once grant, and asks again after that", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "once",
    })).toBe("requested");

    // The same target and the same payload, retried inside the same task: the standing grant is
    // consulted once and the decision relayed without asking again.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { scope }));
    expect(harness.resolutions.filter((row) => row.approvalId === "approval-2"))
      .toEqual([{ approvalId: "approval-2", decision: "approve" }]);
    expect(pendingFrames(harness.frames).find((frame) => frame.toolCallId === "approval-2")?.grantId)
      .toBe("grant:sage:approval-1");

    // Spent. A second retry is a fresh question, and the grant is gone from the view.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-3", { scope }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-3")).toBe(false);
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);

    // One material field changed, so the payload hash changed: no standing approval covers it.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-4", {
      scope: { ...scope, change: "append two lines to notes.md", payloadHash: HASH_B },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-4")).toBe(false);
    harness.close();
  });

  it("bounds a once grant by the ask and by its own ceiling, never by the value the peer chose", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    // A peer asking for a grant that outlives the decade gets the gateway's ceiling instead.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", {
      scope: { ...scope, expiresAt: 4_102_444_800_000 },
    }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", { grant: "once" });
    const ceiling = plane.surface().approvalGrants!("sage")[0]!;
    expect(ceiling.expiresAt).toBeLessThanOrEqual(2_000 + 10 * 60 * 1_000);

    // A shorter ask wins over the ceiling: the grant dies with the question it answered.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", {
      scope: { ...scope, expiresAt: 1_500 },
    }));
    await plane.surface().resolveApproval("sage", "approval-2", "approve", "device-1", { grant: "once" });
    const shortest = plane.surface().approvalGrants!("sage")
      .find((grant) => grant.grantId === "grant:sage:approval-2")!;
    expect(shortest.expiresAt).toBe(1_500);
    harness.close();
  });

  it("never consults a grant for a non-idempotent action", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;
    const once = { ...scope, retry: "not_idempotent" as const };

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope: once }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", { grant: "once" });
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { scope: once }));

    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    harness.close();
  });

  it("refuses to replay an expired grant regardless of category policy", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;
    const shortLived = { ...scope, expiresAt: 2_000 };

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope: shortLived }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", { grant: "once" });

    harness.setNow(3_000);
    // A FRESH ask, still live, over a grant that is not: the storage-level expiry filter is the
    // only thing that can refuse this one.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-fresh", {
      scope: { ...shortLived, expiresAt: 9_000_000 },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-fresh")).toBe(false);
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { scope: shortLived }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    harness.close();
  });

  it("honors a category grant across payloads inside its bounds and never outside them", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category",
      expiresAt: 8_000_000,
    })).toBe("requested");

    // A different payload for the same action and resource is inside the category bounds.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", {
      scope: { ...scope, payloadHash: HASH_B, retry: "not_idempotent" },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(true);

    // A different resource is outside them.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-3", {
      scope: { ...scope, resource: "repo/secrets.md", payloadHash: HASH_B },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-3")).toBe(false);
    harness.close();
  });

  it("blocks a category grant over an always-require action and never consults one", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;
    const money = {
      ...scope,
      action: "payments.transfer",
      category: "money_movement" as const,
      reason: "always_require" as const,
    };

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope: money }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category",
      expiresAt: 8_000_000,
    })).toBe("category_forbidden");

    // The per-invocation decision still works, and it leaves no standing approval behind.
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1"))
      .toBe("requested");
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { scope: money }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    harness.close();
  });

  it("removes a standing category grant the moment it is revoked", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category",
      expiresAt: 8_000_000,
    });
    const grants = plane.surface().approvalGrants!("sage");
    expect(grants.map((grant) => grant.scope)).toEqual(["category"]);

    expect(plane.surface().revokeApprovalGrant!("sage", grants[0]!.grantId)).toBe("revoked");
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", {
      scope: { ...scope, payloadHash: HASH_B },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    harness.close();
  });

  it("keeps no payload value in what it stores: hashes, ids and reason codes only", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category",
      expiresAt: 8_000_000,
    });

    const grant = plane.surface().approvalGrants!("sage")[0]!;
    expect(Object.keys(grant).sort()).toEqual(
      ["grantId", "scope", "action", "category", "system", "resource", "sessionId", "expiresAt", "createdAt"].sort(),
    );
    // The material change sentence and the payload hash are the approval's, not the grant's.
    expect(JSON.stringify(grant)).not.toContain(scope.change);
    harness.close();
  });

  it("creates the grant a duplicate decision asks for, and never reports one it did not create", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1"))
      .toBe("requested");

    // The person taps Approve, then decides to make it a policy. The decision already stands, so
    // the relay is a duplicate, but the policy they asked for is new and is created.
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category", expiresAt: 8_000_000,
    })).toBe("requested");
    expect(plane.surface().approvalGrants!("sage").map((grant) => grant.scope)).toEqual(["category"]);

    // Asking again for a DIFFERENT policy on the same decision creates nothing, and says so rather
    // than answering success for a policy change that did not happen.
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "once",
    })).toBe("grant_not_recorded");
    expect(plane.surface().approvalGrants!("sage").map((grant) => grant.scope)).toEqual(["category"]);
    harness.close();
  });

  it("says what covered an auto-approved ask on the rebroadcast and the inbox, and lets the person deny it", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category", expiresAt: 8_000_000,
    });
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", {
      scope: { ...scope, payloadHash: HASH_B },
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(true);

    // Persisted, so a reconnect and a cold inbox read both say why the card settled itself.
    expect((storage.nativeInteraction("sage", "approval", "approval-2")?.payload as { grantId?: string }).grantId)
      .toBe("grant:sage:approval-1");
    const inbox = plane.surface().pendingApprovals().find((row) => row.toolCallId === "approval-2");
    expect(inbox?.grantId).toBe("grant:sage:approval-1");

    const before = pendingFrames(harness.frames).length;
    await plane.surface().chatHistory("sage");
    const rebroadcast = pendingFrames(harness.frames).slice(before)
      .find((frame) => frame.toolCallId === "approval-2");
    expect(rebroadcast?.grantId).toBe("grant:sage:approval-1");

    // The person disagrees with their own standing policy on this one ask. A deny is admitted, not
    // refused as a conflicting decision, and the peer's terminal remains the only proof.
    expect(await plane.surface().resolveApproval("sage", "approval-2", "deny", "device-1"))
      .toBe("requested");
    expect(harness.resolutions.filter((row) => row.approvalId === "approval-2")
      .map((row) => row.decision)).toEqual(["approve", "deny"]);
    harness.close();
  });

  it("keeps every grant that can auto-approve inside the view a person can revoke from", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    // One more live grant than the view holds. The window is the same on both sides, so the grant
    // that falls out of the list falls out of the consult too rather than deciding invisibly.
    for (let index = 0; index <= 100; index += 1) {
      storage.recordApprovalGrant({
        bot: "sage",
        grantId: `grant:sage:filler-${String(index).padStart(3, "0")}`,
        scope: "category",
        deviceId: "device-1",
        sessionId,
        turnId: null,
        approvalId: `filler-${index}`,
        action: index === 0 ? scope.action : `filler.action.${index}`,
        category: "other",
        system: scope.system,
        resource: scope.resource,
        payloadHash: null,
        expiresAt: 8_000_000,
        createdAt: 1_000 + index,
      });
    }
    const listed = plane.surface().approvalGrants!("sage");
    expect(listed).toHaveLength(100);
    expect(listed.some((grant) => grant.grantId === "grant:sage:filler-000")).toBe(false);

    // filler-000 is the oldest and the only one whose action matches this ask. It is outside the
    // view, so it is outside the consult: the ask is raised for a person to answer.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { scope }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-1")).toBe(false);
    harness.close();
  });

  it("covers a later identical plain approval from a grant a person made on the plain card", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;
    // A Hermes-shaped ask: no scope block, but the capability-56 sentence the peer sent names what
    // it concretely covers, and that plus the rule name is deterministic content.
    const detail = "opens Chrome with the Work profile";

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { detail }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "once",
    })).toBe("requested");
    const grant = plane.surface().approvalGrants!("sage")[0]!;
    // Derived bindings live in their own target namespace, so one can never match a grant a typed
    // peer made against a real system it named.
    expect(grant).toMatchObject({ scope: "once", action: "workspace_write", system: "attach" });

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { detail }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(true);
    expect(pendingFrames(harness.frames).find((frame) => frame.toolCallId === "approval-2")?.grantId)
      .toBe("grant:sage:approval-1");

    // Single use, exactly as a typed once grant is.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-3", { detail }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-3")).toBe(false);

    // A second single-use grant covers the next one, and different content is a different ask: the
    // sentence is part of what was bound.
    await plane.surface().resolveApproval("sage", "approval-3", "approve", "device-1", { grant: "once" });
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-4", { detail }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-4")).toBe(true);
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-5", {
      detail: "opens Chrome with the Personal profile",
    }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-5")).toBe(false);
    harness.close();
  });

  it("never lets a category grant cover a plain approval, and refuses to create one on a plain card", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;
    const detail = "opens Chrome with the Work profile";

    // A plain ask declares no category, so nothing can say it is not a destructive or a publishing
    // one. A standing category policy over an undeclared action is refused at the source.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { detail }));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category", expiresAt: 8_000_000,
    })).toBe("category_undeclared");
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);

    // And refused again at the consult, so a category grant that matches a plain ask's derived
    // binding by any other route still cannot answer for it.
    storage.recordApprovalGrant({
      bot: "sage",
      grantId: "grant:sage:planted",
      scope: "category",
      deviceId: "device-1",
      sessionId,
      turnId: null,
      approvalId: "planted",
      action: "workspace_write",
      category: "other",
      system: "attach",
      resource: detail,
      payloadHash: null,
      expiresAt: 8_000_000,
      createdAt: 1_000,
    });
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2", { detail }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);

    // The person's own single-use grant is still the way to cover one.
    expect(await plane.surface().resolveApproval("sage", "approval-2", "approve", "device-1", {
      grant: "once",
    })).toBe("requested");
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-3", { detail }));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-3")).toBe(true);
    harness.close();
  });

  it("refuses to cover a plain approval that carries no deterministic content", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    // A rule name alone says what KIND of thing is being asked, never which one, so binding a
    // payload hash to it would cover asks a person never saw. There is nothing to bind: no grant.
    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1"));
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "category", expiresAt: 8_000_000,
    })).toBe("scope_required");
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device-1", {
      grant: "once",
    })).toBe("scope_required");
    expect(plane.surface().approvalGrants!("sage")).toEqual([]);

    plane.handle("sage", approvalEvent(sessionId, turnId, "approval-2"));
    expect(harness.resolutions.some((row) => row.approvalId === "approval-2")).toBe(false);
    // And the plain card is still the pre-66 card, whatever a person asked for on it.
    const frame = pendingFrames(harness.frames).find((item) => item.toolCallId === "approval-2")!;
    expect(Object.keys(frame).sort()).toEqual(
      ["bot", "sessionId", "toolCallId", "turnId", "type", "name", "updatedAt"].sort(),
    );
    harness.close();
  });
});
