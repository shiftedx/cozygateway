import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ContractViolation } from "./validate.ts";

/** com.cozylabs.cozyapps v1.  A tree is data, never executable client code. */
export const COZYAPPS_CAPABILITY_ID = "com.cozylabs.cozyapps";
export const COZYAPPS_CAPABILITY_VERSION = 1;
export const COZYAPP_MAX_DEPTH = 12;
export const COZYAPP_MAX_NODES = 200;
export const COZYAPP_MAX_TREE_BYTES = 128 * 1024;

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const BotId = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9:_-]+$" });
const Text = Type.String({ maxLength: 8_192 });

/** Every generated node is deliberately closed; unknown kinds/properties are refused. */
export const CozyAppNodeSchema = Type.Recursive((This) => Type.Union([
  Type.Object({ id: Id, kind: Type.Literal("stack"), children: Type.Array(This, { maxItems: 100 }) }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("section"), title: Type.Optional(Text), children: Type.Array(This, { maxItems: 100 }) }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("text"), text: Text, style: Type.Optional(Type.Union([Type.Literal("body"), Type.Literal("title"), Type.Literal("caption")])) }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("image"), source: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }), alt: Type.Optional(Type.String({ maxLength: 512 })) }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("list"), items: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 100 }) }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("keyValue"), key: Type.String({ minLength: 1, maxLength: 512 }), value: Text }, { additionalProperties: false }),
  Type.Object({ id: Id, kind: Type.Literal("button"), label: Type.String({ minLength: 1, maxLength: 256 }), actionId: Id, role: Type.Union([Type.Literal("primary"), Type.Literal("secondary"), Type.Literal("destructive")]) }, { additionalProperties: false }),
]));
export type CozyAppNode = Static<typeof CozyAppNodeSchema>;

export const CozyAppTreeSchema = Type.Object({ root: CozyAppNodeSchema }, { additionalProperties: false });
export type CozyAppTree = Static<typeof CozyAppTreeSchema>;

export const CozyAppSchema = Type.Object({
  id: Id, name: Type.String({ minLength: 1, maxLength: 120 }), creatorBot: BotId,
  revision: Type.Integer({ minimum: 1 }), createdAt: Type.Integer({ minimum: 0 }), updatedAt: Type.Integer({ minimum: 0 }), tree: CozyAppTreeSchema,
}, { additionalProperties: false });
export type CozyApp = Static<typeof CozyAppSchema>;
export const CozyAppSummarySchema = Type.Omit(CozyAppSchema, ["tree"]);
export type CozyAppSummary = Static<typeof CozyAppSummarySchema>;
export const CozyAppRenameRequestSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false });
export const CozyAppUpsertRequestSchema = Type.Object({ id: Type.Optional(Id), name: Type.String({ minLength: 1, maxLength: 120 }), tree: CozyAppTreeSchema }, { additionalProperties: false });
export const CozyAppActionRequestSchema = Type.Object({ idempotencyKey: Id, actionId: Id }, { additionalProperties: false });
/** User-initiated Foundation Models layout regeneration. The creator and name never cross this boundary. */
export const CozyAppReplaceTreeRequestSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }), tree: CozyAppTreeSchema }, { additionalProperties: false });
export const CozyAppActionSchema = Type.Object({ id: Id, appId: Id, creatorBot: BotId, actionId: Id, status: Type.Union([Type.Literal("requested"), Type.Literal("delivered"), Type.Literal("completed"), Type.Literal("failed")]), createdAt: Type.Integer({ minimum: 0 }), updatedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type CozyAppAction = Static<typeof CozyAppActionSchema>;
export const CozyAppsSnapshotFrameSchema = Type.Object({ type: Type.Literal("cozyapps_snapshot"), apps: Type.Array(CozyAppSchema, { maxItems: 1_000 }), actions: Type.Array(CozyAppActionSchema, { maxItems: 1_000 }) }, { additionalProperties: false });
export const CozyAppActionFrameSchema = Type.Object({ type: Type.Literal("cozyapp_action"), action: CozyAppActionSchema }, { additionalProperties: false });

/** Extra structural ceilings TypeBox cannot express recursively. */
export function assertValidCozyAppTree(value: unknown): CozyAppTree {
  const error = Value.Errors(CozyAppTreeSchema, value).First();
  if (error !== undefined) throw new ContractViolation(`${error.message} at ${error.path || "/"}`, error.path);
  const tree = value as CozyAppTree;
  let count = 0;
  const ids = new Set<string>();
  const walk = (node: CozyAppNode, depth: number): void => {
    if (depth > COZYAPP_MAX_DEPTH) throw new ContractViolation("tree exceeds maximum depth at /root", "/root");
    if (++count > COZYAPP_MAX_NODES) throw new ContractViolation("tree exceeds maximum nodes at /root", "/root");
    if (ids.has(node.id)) throw new ContractViolation("node id must be unique at /root", "/root");
    ids.add(node.id);
    if (node.kind === "stack" || node.kind === "section") for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree.root, 1);
  if (Buffer.byteLength(JSON.stringify(tree), "utf8") > COZYAPP_MAX_TREE_BYTES)
    throw new ContractViolation("tree exceeds maximum serialized size at /root", "/root");
  return tree;
}
