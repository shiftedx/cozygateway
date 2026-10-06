import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage } from "../src/storage.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function start(
  desktopSessions: () => Promise<unknown[]>,
  desktopSessionTranscript: () => Promise<unknown[]> = async () => [],
) {
  const storage = openStorage(":memory:");
  const frames: unknown[] = [];
  const turns: Array<{ threadId?: string }> = [];
  const resumes: Array<{ threadId: string; hermesSessionId: string; resumeId: string }> = [];
  const control = {
    desktopSessions: vi.fn(desktopSessions),
    desktopSessionTranscript: vi.fn(desktopSessionTranscript),
  } as unknown as BotsSurface;
  const ingress = {
    sendNativeTurn: (_peer: string, turn: { threadId?: string }) => { turns.push(turn); return true; },
    sendNativeDesktopResume: (_peer: string, resume: { threadId: string; hermesSessionId: string; resumeId: string }) => {
      resumes.push(resume); return true;
    },
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "",
    broadcast: (frame) => frames.push(frame), staleTurnSweepMs: 0,
  });
  return {
    control, storage, plane, surface: plane.surface(), frames, turns, resumes,
    close: () => { plane.close(); storage.close(); },
  };
}

describe("automatic desktop-session reconciliation latency", () => {
  afterEach(() => vi.useRealTimers());

  it("does not hold normal canonical/history/send behind a stalled optional desktop index", async () => {
    vi.useFakeTimers();
    const index = deferred<unknown[]>();
    const h = start(() => index.promise);
    let canonicalDone = false;
    let historyDone = false;
    let sendDone = false;
    const canonical = h.surface.canonicalChat("sage").then((value) => { canonicalDone = true; return value; });
    const history = h.surface.chatHistory("sage").then((value) => { historyDone = true; return value; });
    const send = h.surface.sendChatMessage("sage", "send without waiting").then((value) => { sendDone = true; return value; });

    await vi.advanceTimersByTimeAsync(751);
    expect(canonicalDone).toBe(true);
    expect(historyDone).toBe(true);
    expect(sendDone).toBe(true);
    await Promise.all([canonical, history, send]);
    expect(h.turns).toHaveLength(1);
    // The uncancellable raw lookup remains coalesced after the bounded caller path has returned.
    await h.surface.canonicalChat("sage");
    expect(h.control.desktopSessions).toHaveBeenCalledTimes(1);
    h.close();
  });

  it("ignores a desktop-index result that arrives after the automatic budget", async () => {
    vi.useFakeTimers();
    const index = deferred<unknown[]>();
    const h = start(() => index.promise);
    const opening = h.surface.canonicalChat("sage");
    await vi.advanceTimersByTimeAsync(751);
    const before = (await opening).sessionId;
    index.resolve([{
      source: "hermes_desktop", origin: "desktop", hermesSessionId: "late-session",
      startedAt: 1, lastActiveAt: 9_000,
    }]);
    await vi.runAllTicks();
    expect(h.resumes).toEqual([]);
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).toBe(before);
    h.close();
  });

  it("also abandons a transcript read that misses the automatic budget before staging", async () => {
    vi.useFakeTimers();
    const transcript = deferred<unknown[]>();
    const h = start(async () => [{
      source: "hermes_desktop", origin: "desktop", hermesSessionId: "slow-transcript",
      startedAt: 1, lastActiveAt: 9_000,
    }], () => transcript.promise);
    const opening = h.surface.canonicalChat("sage");

    await vi.advanceTimersByTimeAsync(751);
    const before = (await opening).sessionId;
    transcript.resolve([{ id: "late", role: "user", text: "must stay remote" }]);
    await vi.runAllTicks();
    expect(h.resumes).toEqual([]);
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).toBe(before);
    h.close();
  });

  it("waits for an already-queued automatic resume so a send cannot race its confirmed selection", async () => {
    vi.useFakeTimers();
    const h = start(async () => [{
      source: "hermes_desktop", origin: "cli", hermesSessionId: "resume-before-send",
      startedAt: 1, lastActiveAt: 9_000,
    }]);
    let sent = false;
    const sending = h.surface.sendChatMessage("sage", "use the latest session")
      .then((value) => { sent = true; return value; });

    await vi.advanceTimersByTimeAsync(751);
    expect(h.resumes).toHaveLength(1);
    expect(sent).toBe(false);
    const resume = h.resumes[0]!;
    expect(h.plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "late-but-valid-confirm",
      event: { kind: "desktop_session_resumed", threadId: resume.threadId, hermesSessionId: resume.hermesSessionId, resumeId: resume.resumeId },
    } as never)).toBe(true);

    await expect(sending).resolves.toMatchObject({ sessionId: resume.threadId });
    expect(h.turns).toMatchObject([{ threadId: resume.threadId }]);
    h.close();
  });

  it("does not let a pre-queue explicit transcript read hold an automatic normal send", async () => {
    vi.useFakeTimers();
    const transcript = deferred<unknown[]>();
    const sessions = [{
      source: "hermes_desktop", origin: "cli", hermesSessionId: "explicit-reading",
      startedAt: 1, lastActiveAt: 9_000,
    }];
    const h = start(async () => sessions, () => transcript.promise);
    const explicit = h.surface.resumeDesktopSession("sage", "explicit-reading");
    const sending = h.surface.sendChatMessage("sage", "do not wait for the picker read");

    await vi.advanceTimersByTimeAsync(751);
    const sent = await sending;
    expect(h.resumes).toEqual([]);
    expect(h.turns).toMatchObject([{ threadId: sent.sessionId }]);

    // The explicit read finally returns after ordinary chat is active. Its recheck declines the
    // stale selection instead of enqueueing a resume that could redirect the new turn.
    transcript.resolve([]);
    await expect(explicit).resolves.toMatchObject({ status: "pending" });
    expect(h.resumes).toEqual([]);
    h.close();
  });

  it("keeps waiting when a joined explicit read queues before the automatic deadline", async () => {
    vi.useFakeTimers();
    const transcript = deferred<unknown[]>();
    const sessions = [{
      source: "hermes_desktop", origin: "cli", hermesSessionId: "joined-then-queued",
      startedAt: 1, lastActiveAt: 9_000,
    }];
    const h = start(async () => sessions, () => transcript.promise);
    const explicit = h.surface.resumeDesktopSession("sage", "joined-then-queued");
    let sent = false;
    const sending = h.surface.sendChatMessage("sage", "wait for the joined proof")
      .then((value) => { sent = true; return value; });

    await vi.advanceTimersByTimeAsync(500);
    transcript.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.resumes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(251);
    expect(sent).toBe(false);
    const resume = h.resumes[0]!;
    expect(h.plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "joined-confirm",
      event: { kind: "desktop_session_resumed", threadId: resume.threadId, hermesSessionId: resume.hermesSessionId, resumeId: resume.resumeId },
    } as never)).toBe(true);
    await expect(sending).resolves.toMatchObject({ sessionId: resume.threadId });
    await expect(explicit).resolves.toMatchObject({ status: "resumed", sessionId: resume.threadId });
    h.close();
  });

  it("still selects a latest fast desktop session, while explicit desktop resume stays unbounded", async () => {
    const sessions = [{
      source: "hermes_desktop", origin: "cli", hermesSessionId: "latest-session",
      startedAt: 1, lastActiveAt: 9_000,
    }];
    const h = start(async () => sessions);
    const opening = h.surface.canonicalChat("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    const automatic = h.resumes[0]!;
    expect(h.plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "auto-confirm",
      event: { kind: "desktop_session_resumed", threadId: automatic.threadId, hermesSessionId: automatic.hermesSessionId, resumeId: automatic.resumeId },
    } as never)).toBe(true);
    await expect(opening).resolves.toMatchObject({ sessionId: automatic.threadId });

    const explicit = h.surface.resumeDesktopSession("sage", "latest-session");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(2));
    const command = h.resumes[1]!;
    expect(h.plane.handle("sage", {
      kind: "event", sequence: 2, eventId: "explicit-confirm",
      event: { kind: "desktop_session_resumed", threadId: command.threadId, hermesSessionId: command.hermesSessionId, resumeId: command.resumeId },
    } as never)).toBe(true);
    await expect(explicit).resolves.toMatchObject({ status: "resumed", sessionId: command.threadId });
    h.close();
  });
});
