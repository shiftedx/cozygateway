import { describe, expect, it } from "vitest";

import {
  CANONICAL_CHAT_TITLE,
  resolveCanonicalChat,
  type PinStore,
} from "../src/hermes-bridge/canonical-chat.ts";

/** The pin the server's `ui_meta` carries is three-valued, and each value means something
 *  different (dissection 3.2): a string is the pin, `null` is an authoritative CLEAR, and
 *  `undefined` is "the server knows nothing", the only case that may fall back to the local pin.
 *  These are unit tests because the difference is invisible until a desktop clears a pin. */

function pinStore(initial: Record<string, string> = {}): PinStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (name) => map.get(name),
    set: (name, sessionId) => void map.set(name, sessionId),
    clear: (name) => void map.delete(name),
  };
}

const SESSIONS = {
  sessions: [
    { id: "newest", title: "Debugging the deploy" },
    { id: "canonical", title: CANONICAL_CHAT_TITLE },
    { id: "server-pinned", title: "An older chat" },
    { id: "local-pinned", title: "Older still" },
  ],
};

function rpc(): { request: (method: string, params?: unknown) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async (method: string) => {
      calls.push(method);
      if (method === "session.list") return SESSIONS;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("resolveCanonicalChat serverPin", () => {
  it("prefers the server pin over a different local pin", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc(),
      pins,
      hideBotChats: true,
      serverPin: "server-pinned",
    });
    expect(result).toEqual({ sessionId: "server-pinned", adoption: "pin" });
    expect(pins.map.get("scout")).toBe("server-pinned");
  });

  it("treats a cleared server pin as authoritative and does not fall back to the local pin", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc(),
      pins,
      hideBotChats: true,
      serverPin: null,
    });
    // A clear sends the bot back down the adoption path, which lands on the canonical title.
    expect(result).toEqual({ sessionId: "canonical", adoption: "title" });
    expect(pins.map.get("scout")).toBe("canonical");
  });

  it("falls back to the local pin only when the server knows nothing", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc(),
      pins,
      hideBotChats: true,
      serverPin: undefined,
    });
    expect(result).toEqual({ sessionId: "local-pinned", adoption: "pin" });
  });

  it("re-pins the newest session when a cleared server pin meets no canonical title", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const bare = {
      request: async (method: string) =>
        method === "session.list"
          ? { sessions: [{ id: "newest", title: "x" }, { id: "older", title: "y" }] }
          : Promise.reject(new Error(`unexpected method ${method}`)),
    };
    const result = await resolveCanonicalChat("scout", {
      rpc: bare,
      pins,
      hideBotChats: true,
      serverPin: null,
    });
    expect(result).toEqual({ sessionId: "newest", adoption: "latest" });
  });
});
