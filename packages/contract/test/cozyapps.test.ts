import { describe, expect, it } from "vitest";
import { assertValidCozyAppTree, CozyAppSchema, check } from "../src/index.ts";

const tree = { root: { id: "root", kind: "stack", children: [{ id: "refreshButton", kind: "button", label: "Refresh", actionId: "refresh", role: "primary" }] } } as const;

describe("cozyapps v1", () => {
  it("accepts the closed catalog and federated creator ids", () => {
    expect(check(CozyAppSchema, { id: "cowboys", name: "Cowboys", creatorBot: "home:Cleo", revision: 1, createdAt: 1, updatedAt: 1, tree })).toBe(true);
    expect(assertValidCozyAppTree(tree)).toEqual(tree);
  });
  it("rejects duplicate node ids and unknown nodes", () => {
    expect(() => assertValidCozyAppTree({ root: { id: "x", kind: "stack", children: [{ id: "x", kind: "text", text: "no" }] } })).toThrow(/unique/);
    expect(() => assertValidCozyAppTree({ root: { id: "x", kind: "webview" } })).toThrow();
  });
});
