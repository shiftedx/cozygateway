import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const crash = process.platform === "win32" ? describe.skip : describe;
let fixtureDirectory: string;
let childBundle: string;
const databaseDirectories = new Set<string>();

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "attach-batch-crash-"));
  const source = join(fixtureDirectory, "child.ts");
  childBundle = join(fixtureDirectory, "child.cjs");
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  writeFileSync(source, `
    import { CachedDatabaseSync } from ${JSON.stringify(resolve(sourceRoot, "src/sqlite.ts"))};
    import { AttachV1Ingress } from ${JSON.stringify(resolve(sourceRoot, "src/adapters/attach/ingress-v1.ts"))};
    import { NativeBotDataPlane } from ${JSON.stringify(resolve(sourceRoot, "src/hermes-bridge/native-data-plane.ts"))};
    import { openStorage } from ${JSON.stringify(resolve(sourceRoot, "src/storage.ts"))};

    const [path, phase] = process.argv.slice(2);
    const originalExec = CachedDatabaseSync.prototype.exec;
    let armed = false;
    let markerReady = false;
    CachedDatabaseSync.prototype.exec = function (sql) {
      if (armed && sql === "COMMIT" && this.prepare("PRAGMA synchronous").get().synchronous !== 2)
        throw new Error("admission/projection connection lost FULL durability");
      if (armed && (phase === "before-admission" || (phase === "before-marker" && markerReady)) && sql === "COMMIT") process.kill(process.pid, "SIGKILL");
      const result = originalExec.call(this, sql);
      if (armed && phase === "after-admission" && sql === "COMMIT") process.kill(process.pid, "SIGKILL");
      return result;
    };
    const storage = openStorage(path);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "turn", messageId: "user", text: "hello" }, 1);
    storage.setNativeBotTurn("sage", sessionId, "turn", 1);
    const progress = [
      { kind: "event", sequence: 1, eventId: "draft", event: { kind: "draft", threadId: sessionId, turnId: "turn", blocks: [{ type: "paragraph", text: "working" }] } },
      { kind: "event", sequence: 2, eventId: "tool-running", event: { kind: "tool", threadId: sessionId, turnId: "turn", callId: "tool", name: "search", status: "running" } },
      { kind: "event", sequence: 3, eventId: "tool-ok", event: { kind: "tool", threadId: sessionId, turnId: "turn", callId: "tool", name: "search", status: "ok" } },
    ];
    if (phase === "before-admission" || phase === "after-admission") {
      armed = true;
      const terminal = { kind: "event", sequence: 4, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "turn", messageId: "answer", blocks: [{ type: "paragraph", text: "done" }] } };
      storage.acceptAttachEvents("sage", [...progress, terminal].map((frame, index) => ({ frame, receivedAt: index + 2 })));
      throw new Error("crash hook did not fire");
    }
    storage.acceptAttachEvents("sage", progress.map((frame, index) => ({ frame, receivedAt: index + 2 })));
    const plane = new NativeBotDataPlane({ control: {}, storage, ingress: {}, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 10 });
    let projected = 0;
    const ingress = new AttachV1Ingress({ tokens: new Map([["secret", "sage"]]), storage, events: {
      onEvent: (agentId, frame) => {
        const applied = plane.handle(agentId, frame);
        projected += 1;
        if (projected === progress.length) markerReady = true;
        return applied;
      }, onPresence: () => undefined,
    }, now: () => 10, log: () => undefined });
    armed = true;
    ingress.replayUnapplied("sage");
    throw new Error("crash hook did not fire");
  `);
  buildSync({ entryPoints: [source], bundle: true, format: "cjs", platform: "node", target: "node24", outfile: childBundle });
});

afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
afterEach(() => {
  for (const directory of databaseDirectories) rmSync(directory, { recursive: true, force: true });
  databaseDirectories.clear();
});

function databasePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  databaseDirectories.add(directory);
  return join(directory, "gateway.sqlite");
}

function killAt(path: string, phase: "before-admission" | "after-admission" | "before-marker"): void {
  const child = spawnSync(process.execPath, [childBundle, path, phase], { encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined();
  expect(child.signal, `${child.status}: ${child.stderr}`).toBe("SIGKILL");
}

function recovery(storage: Storage): { replay: () => void; close: () => void } {
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress: {} as AttachV1Ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: () => undefined,
    now: () => 20,
  });
  const ingress = new AttachV1Ingress({
    tokens: new Map([["secret", "sage"]]),
    storage,
    events: { onEvent: (agentId, frame) => plane.handle(agentId, frame), onPresence: () => undefined },
    now: () => 20,
    log: () => undefined,
  });
  return { replay: () => ingress.replayUnapplied("sage"), close: () => { ingress.close(); plane.close(); } };
}

crash("actual process-death recovery for attach batches", () => {
  it("loses the complete admission batch when killed before its commit", () => {
    const path = databasePath("attach-batch-before-commit-");
    killAt(path, "before-admission");
    const storage = openStorage(path);
    expect(storage.attachEventCursor("sage")).toBe(0);
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);
    storage.close();
  });

  it("recovers every event when killed after admission commit and before projection", () => {
    const path = databasePath("attach-batch-after-admission-");
    killAt(path, "after-admission");
    const storage = openStorage(path);
    expect(storage.attachEventCursor("sage")).toBe(4);
    expect(storage.unappliedAttachEvents("sage").map((frame) => frame.eventId)).toEqual(["draft", "tool-running", "tool-ok", "final"]);
    const assembled = recovery(storage);
    assembled.replay();
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);
    expect(storage.botChatToolSteps(storage.nativeBotChat("sage", 20).sessionId, 0)).toMatchObject([{ stepId: "tool", status: "ok" }]);
    expect(storage.nativeBotMessages("sage", storage.nativeBotChat("sage", 20).sessionId).filter((message) => message.id === "answer")).toHaveLength(1);
    assembled.close();
    storage.close();
  });

  it("replays projections killed before a batch marker without duplicate durable effects", () => {
    const path = databasePath("attach-batch-before-marker-");
    killAt(path, "before-marker");
    const storage = openStorage(path);
    expect(storage.unappliedAttachEvents("sage").map((frame) => frame.eventId)).toEqual(["draft", "tool-running", "tool-ok"]);
    const assembled = recovery(storage);
    // The stored journal remains the authority after process death; replay is idempotent even
    // though the old process had already written the tool state before its marker died.
    assembled.replay();
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);
    const sessionId = storage.nativeBotChat("sage", 20).sessionId;
    expect(storage.botChatToolSteps(sessionId, 0)).toMatchObject([{ stepId: "tool", status: "ok" }]);
    expect(storage.botChatToolSteps(sessionId, 0)).toHaveLength(1);
    const final = { kind: "event" as const, sequence: 4, eventId: "final", event: { kind: "commit" as const, threadId: sessionId, turnId: "turn", messageId: "answer", blocks: [{ type: "paragraph" as const, text: "done" }] } };
    expect(storage.acceptAttachEvent("sage", final, 21)).toEqual({ status: "accepted", acknowledgedSequence: 4 });
    assembled.replay();
    expect(storage.nativeBotMessages("sage", sessionId).filter((message) => message.id === "answer")).toHaveLength(1);
    assembled.close();
    storage.close();
  });
});
