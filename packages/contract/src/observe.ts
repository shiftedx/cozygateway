/** The observer's websocket subscription (capability 75, dashboard packet D3).
 *
 *  The dashboard is a paired READ-ONLY device (capability 72) that wants live numbers without
 *  polling. It gets them over the app websocket it already authenticates on, through exactly two
 *  client frames, `observe_subscribe` and `observe_unsubscribe`, and three server frames.
 *
 *  THE SUBSCRIBE FRAME IS THE ONLY THING AN OBSERVER MAY SEND BESIDES `auth` AND `sync`, and it is
 *  a read: it names which broadcast kinds this socket wants and changes nothing else about the
 *  gateway. Capability 72's rule is unchanged for every other frame, so a read-scoped socket still
 *  cannot advertise itself as a phone node, answer a request, or steer a turn.
 *
 *  `bot_chat_delta` IS NEVER SENT TO A READ-SCOPED SOCKET. The design's privacy rule (section 3:
 *  no message text, ever) and its transport rule ("bot_chat_delta counts only") are the same rule
 *  seen twice, and the only way to hold it at the boundary rather than at each call site is for the
 *  observer's frame to be a DIFFERENT frame that cannot carry text at all. `observe_chat_delta`
 *  carries the accumulated LENGTH and the sequence number, which is what a live "words arriving"
 *  strip needs, and there is no field on it a transcript could be written into. */
import { type Static, Type } from "@sinclair/typebox";

/** Every frame kind an observer may subscribe to. A closed set, so a subscribe frame naming
 *  something else is refused rather than silently ignored: an observer that believes it is watching
 *  approvals and is not would draw a quiet, wrong dashboard. */
export const OBSERVE_SUBSCRIPTION_KINDS = [
  "observe_sample",
  "observe_event",
  "observe_chat_delta",
  "bot_task_updated",
  "bot_presence",
  "bot_roster",
  "bot_approval_pending",
  "bot_approval_resolved",
] as const;
export type ObserveSubscriptionKind = (typeof OBSERVE_SUBSCRIPTION_KINDS)[number];

export const ObserveSubscribeFrameSchema = Type.Object({
  type: Type.Literal("observe_subscribe"),
  kinds: Type.Array(
    Type.Union(OBSERVE_SUBSCRIPTION_KINDS.map((kind) => Type.Literal(kind))),
    { minItems: 1, maxItems: OBSERVE_SUBSCRIPTION_KINDS.length },
  ),
}, { additionalProperties: false });
export type ObserveSubscribeFrame = Static<typeof ObserveSubscribeFrameSchema>;

export const ObserveUnsubscribeFrameSchema = Type.Object({
  type: Type.Literal("observe_unsubscribe"),
}, { additionalProperties: false });
export type ObserveUnsubscribeFrame = Static<typeof ObserveUnsubscribeFrameSchema>;

/** One series point, exactly as the ring stored it and with nothing added.
 *
 *  `bot` is the ring's keyed identity hash or null, never a name: the store never returns a raw id
 *  and this frame is not the place to start. The dashboard joins it against the roster hashes the
 *  read routes hand it. */
export const ObserveSampleFrameSchema = Type.Object({
  type: Type.Literal("observe_sample"),
  series: Type.String({ minLength: 1, maxLength: 64 }),
  bot: Type.Union([Type.String({ minLength: 16, maxLength: 16 }), Type.Null()]),
  at: Type.Integer({ minimum: 0 }),
  value: Type.Number(),
}, { additionalProperties: false });
export type ObserveSampleFrame = Static<typeof ObserveSampleFrameSchema>;

/** One event marker. `detail` is the ring's own per-kind closed schema, already validated by the
 *  writer, so nothing here can carry a free string either. */
export const ObserveEventFrameSchema = Type.Object({
  type: Type.Literal("observe_event"),
  at: Type.Integer({ minimum: 0 }),
  kind: Type.String({ minLength: 1, maxLength: 64 }),
  bot: Type.Union([Type.String({ minLength: 16, maxLength: 16 }), Type.Null()]),
  ref: Type.Union([Type.String({ minLength: 16, maxLength: 16 }), Type.Null()]),
  detail: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.Boolean(), Type.String()]))),
}, { additionalProperties: false });
export type ObserveEventFrame = Static<typeof ObserveEventFrameSchema>;

/** `bot_chat_delta` as an observer sees it: how much text has accumulated, never the text. */
export const ObserveChatDeltaFrameSchema = Type.Object({
  type: Type.Literal("observe_chat_delta"),
  bot: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
  textLength: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  done: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type ObserveChatDeltaFrame = Static<typeof ObserveChatDeltaFrameSchema>;

/** How many frames this subscriber missed while it was behind.
 *
 *  A dashboard that cannot keep up must not be able to grow the gateway's memory: the per-socket
 *  queue is bounded, the OLDEST pending frame is dropped when it is full, and the drop is COUNTED
 *  and reported here rather than hidden. A gap a reader can see is a gap a chart can be drawn
 *  honestly through; a silent one turns a dropped sample into a flat line nobody measured. */
export const ObserveGapFrameSchema = Type.Object({
  type: Type.Literal("observe_gap"),
  dropped: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type ObserveGapFrame = Static<typeof ObserveGapFrameSchema>;

/** A content-free invalidation of a live panel. The ordinary task/roster/approval frames carry
 * goals, previews and resource descriptions, so observers receive only the source kind and time
 * and refresh the corresponding read route. */
export const ObserveUpdateFrameSchema = Type.Object({
  type: Type.Literal("observe_update"),
  kind: Type.Union(["bot_task_updated", "bot_presence", "bot_roster", "bot_approval_pending", "bot_approval_resolved"].map((kind) => Type.Literal(kind))),
  at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type ObserveUpdateFrame = Static<typeof ObserveUpdateFrameSchema>;
