import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ContractViolation } from "./validate.ts";

/** com.cozylabs.cozyapps.  A tree is data, never executable client code. Version 2 is the
 *  DOCUMENT-CONTRACT version: it adds the dashboard records below and changes nothing about v1. */
export const COZYAPPS_CAPABILITY_ID = "com.cozylabs.cozyapps";
export const COZYAPPS_CAPABILITY_VERSION = 2;
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
export const CozyAppActionRequestSchema = Type.Object({
  idempotencyKey: Id, actionId: Id,
  /** Capability 2 binding. Optional, so a client below it sends exactly the pre-2 body. */
  appRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  valueRevisions: Type.Optional(Type.Array(Type.Object({ valueId: Id, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 32 })),
}, { additionalProperties: false });
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

// ---------------------------------------------------------------------------
// com.cozylabs.cozyapps 2: dashboard records. Everything below is ADDITIVE.
// No schema above this line changed, so a peer or client that never negotiates
// the new attach capability and never calls the new routes is byte identical to
// its v1 self. `CozyAppSchema` and `CozyAppActionSchema` in particular stay
// closed on exactly the members they always had, because the shipped client
// decoder refuses an unknown key on both.
// ---------------------------------------------------------------------------

/** The document contract version carried in the envelope. The capability says the SHAPE FAMILY
 *  exists; this says which revision of the document the writer produced. */
export const COZYAPP_DOCUMENT_VERSION = 1;
export const COZYAPP_MAX_DOCUMENT_SECTIONS = 12;
export const COZYAPP_MAX_SECTION_COMPONENTS = 24;
export const COZYAPP_MAX_DOCUMENT_COMPONENTS = 100;
export const COZYAPP_MAX_DOCUMENT_BYTES = 32 * 1024;
export const COZYAPP_MAX_DATA_ENTRIES = 64;
export const COZYAPP_MAX_DATA_BYTES = 16 * 1024;
export const COZYAPP_MAX_VALUES = 64;
export const COZYAPP_MAX_VALUE_REVISIONS = 32;
/** This gateway serves one person. The envelope still carries an owner because the product
 *  decision names one, so the field exists and the gateway writes this constant rather than
 *  accepting an identity from a bot or a request. */
export const COZYAPP_DASHBOARD_OWNER = "user";

/** Product field types only. No nested JSON, no secret material, no permission, and no
 *  bot-authored validation language: a saved value is one field a person filled in. */
export const COZYAPP_VALUE_TYPES = ["string", "number", "boolean", "date", "selection"] as const;
export type CozyAppValueType = (typeof COZYAPP_VALUE_TYPES)[number];
const ValueType = Type.Union(COZYAPP_VALUE_TYPES.map((name) => Type.Literal(name)));
const ValueLiteral = Type.Union([Type.String({ maxLength: 512 }), Type.Number(), Type.Boolean()]);
export type CozyAppValueLiteral = Static<typeof ValueLiteral>;

/** A semantic reference into the app's own values and data. Deliberately excludes `:` and `/`, so
 *  no URL scheme, path, or host can occupy the position a component reads its meaning from. */
const ValueRef = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" });
const Label = Type.String({ minLength: 1, maxLength: 120 });

/** The saved editable input: one typed value with its OWN revision, separate from the app document
 *  and from the app's tree revision. */
export const CozyAppValueSchema = Type.Object({
  appId: Id, valueId: Id, type: ValueType, value: ValueLiteral,
  revision: Type.Integer({ minimum: 1 }), updatedAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type CozyAppValue = Static<typeof CozyAppValueSchema>;
/** The published id shape a saved value's own id must have, exported so a surface that takes the
 *  id from a path can hold it to exactly what the stored record declares. */
export const CozyAppValueIdSchema = Id;
export const CozyAppValuesSchema = Type.Object({ values: Type.Array(CozyAppValueSchema, { maxItems: COZYAPP_MAX_VALUES }) }, { additionalProperties: false });
/** `expectedRevision: 0` means the writer observed no value at all, so a first write and a stale
 *  overwrite are the same check. The idempotency key makes a retried tap one write. */
export const CozyAppValueWriteRequestSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }), idempotencyKey: Id, type: ValueType, value: ValueLiteral,
}, { additionalProperties: false });

/** Closed component catalog. A component names WHAT it shows, never how: there is no member for a
 *  colour, font, coordinate, HTML fragment, script, URL, permission, or executable tool, and the
 *  closed objects leave nowhere to add one on the wire. */
export const CozyAppComponentSchema = Type.Union([
  Type.Object({ kind: Type.Literal("metric"), id: Id, label: Label, valueRef: ValueRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("text"), id: Id, label: Type.Optional(Label), valueRef: ValueRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("list"), id: Id, label: Type.Optional(Label), valueRef: ValueRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("chart"), id: Id, label: Type.Optional(Label), valueRef: ValueRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("input"), id: Id, label: Label, valueRef: ValueRef, valueType: ValueType, options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 24 })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("action"), id: Id, label: Label, actionId: Id }, { additionalProperties: false }),
]);
export type CozyAppComponent = Static<typeof CozyAppComponentSchema>;
export const CozyAppSectionSchema = Type.Object({
  id: Id, title: Type.Optional(Label), components: Type.Array(CozyAppComponentSchema, { maxItems: COZYAPP_MAX_SECTION_COMPONENTS }),
}, { additionalProperties: false });
export const CozyAppDocumentSchema = Type.Object({
  title: Label, sections: Type.Array(CozyAppSectionSchema, { maxItems: COZYAPP_MAX_DOCUMENT_SECTIONS }),
}, { additionalProperties: false });
export type CozyAppDocument = Static<typeof CozyAppDocumentSchema>;

/** Where a number on the dashboard actually came from and how old it is. `state` is the reader's
 *  own honesty: a model's claim is never a fresh reading. */
export const COZYAPP_DATA_STATES = ["fresh", "stale", "error"] as const;
export const CozyAppDataPointSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 120 }),
  asOf: Type.Integer({ minimum: 0 }),
  value: Type.Union([Type.String({ maxLength: 2_048 }), Type.Number(), Type.Boolean(), Type.Null()]),
  state: Type.Union(COZYAPP_DATA_STATES.map((name) => Type.Literal(name))),
}, { additionalProperties: false });
export type CozyAppDataPoint = Static<typeof CozyAppDataPointSchema>;
/** Closed on the SAME bounded reference a component reads by. TypeBox emits a `patternProperties`
 *  object, so `additionalProperties: false` is what actually refuses a key outside the pattern: a
 *  URL, a path, or anything else cannot occupy the position a client renders as a label. The
 *  pattern carries no length, so the assert below bounds the key too. */
export const CozyAppDataSchema = Type.Record(ValueRef, CozyAppDataPointSchema, { additionalProperties: false });
export type CozyAppData = Static<typeof CozyAppDataSchema>;

/** The small versioned envelope. It exists because a phone cannot persist a remote bot's work; it
 *  is not a second UI engine, and the gateway never interprets `document`. */
export const CozyAppDashboardSchema = Type.Object({
  id: Id, revision: Type.Integer({ minimum: 1 }), owner: Type.String({ minLength: 1, maxLength: 128 }),
  creatorBot: BotId, documentVersion: Type.Integer({ minimum: 1 }),
  document: CozyAppDocumentSchema, data: CozyAppDataSchema, updatedAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type CozyAppDashboard = Static<typeof CozyAppDashboardSchema>;
/** The user-triggered on-device regeneration, the document twin of `PUT /cozyapps/:id/tree`. It
 *  carries no `data`: source-attributed data is written by the bot over attach and by nothing else. */
export const CozyAppDashboardWriteRequestSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }), documentVersion: Type.Integer({ minimum: 1 }), document: CozyAppDocumentSchema,
}, { additionalProperties: false });

export const COZYAPP_RECEIPT_STATES = ["queued", "running", "completed", "failed"] as const;
export type CozyAppReceiptStatus = (typeof COZYAPP_RECEIPT_STATES)[number];
export const CozyAppValueRevisionSchema = Type.Object({ valueId: Id, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
/** The durable receipt a person reads. `status` is the public four-name lifecycle; the durable
 *  internal states behind it are the unchanged v1 set, mapped by `cozyAppReceiptStatus`. */
export const CozyAppActionReceiptSchema = Type.Object({
  id: Id, appId: Id, creatorBot: BotId, actionId: Id,
  status: Type.Union(COZYAPP_RECEIPT_STATES.map((name) => Type.Literal(name))),
  appRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  valueRevisions: Type.Optional(Type.Array(CozyAppValueRevisionSchema, { maxItems: COZYAPP_MAX_VALUE_REVISIONS })),
  data: Type.Optional(CozyAppDataSchema),
  createdAt: Type.Integer({ minimum: 0 }), updatedAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type CozyAppActionReceipt = Static<typeof CozyAppActionReceiptSchema>;
export const CozyAppActionReceiptsSchema = Type.Object({ receipts: Type.Array(CozyAppActionReceiptSchema, { maxItems: 1_000 }) }, { additionalProperties: false });

/** HTTP acceptance is `queued` and nothing more. `running` says the command reached the peer that
 *  will run it. Only the peer's own terminal event makes it `completed` or `failed`. */
export function cozyAppReceiptStatus(status: CozyAppAction["status"]): CozyAppReceiptStatus {
  return status === "requested" ? "queued" : status === "delivered" ? "running" : status;
}

/** True when a value is exactly what its declared product field type admits. TypeBox cannot tie
 *  the two members together, so the pairing is checked here and at every write. */
export function cozyAppValueOfType(type: CozyAppValueType, value: unknown): boolean {
  switch (type) {
    case "string": case "selection": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "date": return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }
}

/** Refuses what a bounded text field must never carry into a rendered dashboard: a C0/C1 control,
 *  a Unicode Format (Cf) character, or a lone surrogate. Same rule capability 62 and 66 apply to
 *  peer-authored strings. */
function assertPlainText(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      throw new ContractViolation(`control character is not allowed at ${path}`, path);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
        throw new ContractViolation(`control character is not allowed at ${path}`, path);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ContractViolation(`control character is not allowed at ${path}`, path);
    } else if (/\p{Cf}/u.test(value[index]!)) {
      throw new ContractViolation(`control character is not allowed at ${path}`, path);
    }
  }
}

/** Structure and bounds only. The gateway stores what this accepts and never interprets it. */
export function assertValidCozyAppDocument(value: unknown): CozyAppDocument {
  const error = Value.Errors(CozyAppDocumentSchema, value).First();
  if (error !== undefined) throw new ContractViolation(`${error.message} at ${error.path || "/"}`, error.path);
  const document = value as CozyAppDocument;
  assertPlainText(document.title, "/title");
  const ids = new Set<string>();
  let components = 0;
  for (const section of document.sections) {
    if (ids.has(section.id)) throw new ContractViolation("id must be unique at /sections", "/sections");
    ids.add(section.id);
    if (section.title !== undefined) assertPlainText(section.title, `/sections/${section.id}/title`);
    for (const component of section.components) {
      if (ids.has(component.id)) throw new ContractViolation("id must be unique at /sections", "/sections");
      ids.add(component.id);
      if (++components > COZYAPP_MAX_DOCUMENT_COMPONENTS)
        throw new ContractViolation("document exceeds maximum components at /sections", "/sections");
      if (component.label !== undefined) assertPlainText(component.label, `/sections/${section.id}/${component.id}/label`);
      if (component.kind === "input")
        for (const option of component.options ?? []) assertPlainText(option, `/sections/${section.id}/${component.id}/options`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > COZYAPP_MAX_DOCUMENT_BYTES)
    throw new ContractViolation("document exceeds maximum serialized size at /", "/");
  return document;
}

const VALUE_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The bot-written snapshot. Entry count, key length and serialized size are the three ceilings the
 *  schema cannot express, and a bot writes this, so all three are enforced before it is stored. */
export function assertValidCozyAppData(value: unknown): CozyAppData {
  const error = Value.Errors(CozyAppDataSchema, value).First();
  if (error !== undefined) throw new ContractViolation(`${error.message} at ${error.path || "/"}`, error.path);
  const data = value as CozyAppData;
  const entries = Object.entries(data);
  if (entries.length > COZYAPP_MAX_DATA_ENTRIES)
    throw new ContractViolation("data exceeds maximum entries at /", "/");
  for (const [ref, point] of entries) {
    if (ref.length > 128 || !VALUE_REF_PATTERN.test(ref))
      throw new ContractViolation(`data key is not a value reference at /${ref.slice(0, 32)}`, "/");
    assertPlainText(point.source, `/${ref}/source`);
    if (typeof point.value === "string") assertPlainText(point.value, `/${ref}/value`);
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > COZYAPP_MAX_DATA_BYTES)
    throw new ContractViolation("data exceeds maximum serialized size at /", "/");
  return data;
}
