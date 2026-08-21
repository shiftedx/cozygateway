import { describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame, type Frame } from "../src/frames.ts";
import { AgentRegistry, type AgentLink } from "../src/registry.ts";

describe("frames", () => {
  it("round-trips every frame type", () => {
    const frames: Frame[] = [
      { t: "open", sid: 1, method: "POST", path: "/ts2021", headers: { host: ["relay-01.cozylabs.ai"] }, upgrade: true },
      { t: "head", sid: 1, status: 101, headers: { upgrade: ["websocket"] } },
      { t: "data", sid: 1, b64: Buffer.from("hello").toString("base64") },
      { t: "end", sid: 1 },
      { t: "abort", sid: 1, reason: "agent gone" },
    ];
    for (const f of frames) expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });

  it("rejects malformed frames instead of throwing", () => {
    expect(decodeFrame("not json")).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ t: "nope" }))).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ t: "data", sid: "x", b64: "" }))).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ t: "open", sid: 1, method: "GET", path: "/", headers: [["x"]], upgrade: false }))).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ t: "abort", sid: 1, reason: 42 }))).toBeUndefined();
  });
});

describe("AgentRegistry", () => {
  function fakeLink(): AgentLink & { sent: Frame[]; closed: boolean } {
    const l = { sent: [] as Frame[], closed: false, send(f: Frame) { l.sent.push(f); }, close() { l.closed = true; } };
    return l;
  }

  it("attach replaces and closes the previous link", () => {
    const r = new AgentRegistry();
    const a = fakeLink();
    const b = fakeLink();
    r.attach("hh_1", a);
    r.attach("hh_1", b);
    expect(a.closed).toBe(true);
    expect(r.get("hh_1")).toBe(b);
  });

  it("detach only removes the current link", () => {
    const r = new AgentRegistry();
    const a = fakeLink();
    const b = fakeLink();
    r.attach("hh_1", a);
    r.attach("hh_1", b);
    r.detach("hh_1", a); // stale detach from the replaced link's close handler
    expect(r.get("hh_1")).toBe(b);
    r.detach("hh_1", b);
    expect(r.get("hh_1")).toBeUndefined();
  });

  it("stream ids increase", () => {
    const r = new AgentRegistry();
    expect(r.nextStreamId()).toBeLessThan(r.nextStreamId());
  });
});
