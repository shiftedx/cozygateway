import { describe, expect, it } from "vitest";

import { resolveAttachBearer } from "../src/adapters/attach/token-auth.ts";

describe("attach bearer authentication", () => {
  it("resolves v0, v1, and HTTP credentials through a scan rather than Map.get", () => {
    class NoLookupMap extends Map<string, string> {
      override get(_key: string): string | undefined {
        throw new Error("secret-indexed lookup is forbidden");
      }
    }
    const tokens = new NoLookupMap([["secret-a", "sage"], ["secret-b", "pixel"]]);
    expect(resolveAttachBearer(tokens, "Bearer secret-b")).toBe("pixel");
    expect(resolveAttachBearer(tokens, "Bearer wrong")).toBeUndefined();
    expect(resolveAttachBearer(tokens, "Basic secret-b")).toBeUndefined();
  });
});
