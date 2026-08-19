/** Agent-visible content as a CLOSED union of typed blocks. The client renders only this
 *  schema, with no markdown parser and no raw HTML of agent content; that makes the renderer
 *  the security floor. Objects stay OPEN (unknown fields ignored) so v1.x can add optional
 *  fields, but unknown block TYPES are invalid: a client that cannot render a block must know
 *  it is looking at one. `attachment` carries a gateway-scoped fileId, never a URL, so no
 *  block can become a navigable anchor. */
import { type Static, Type } from "@sinclair/typebox";

export const ListItemSchema = Type.Object({
  text: Type.String(),
  checked: Type.Optional(Type.Boolean()),
});
export type ListItem = Static<typeof ListItemSchema>;

/** The `attachment` block, named on its own so a vendor extension can reference the EXACT shape
 *  `contract/v1.md` froze rather than restating it and drifting from it. Pulling it out of the union
 *  literal changes nothing on the wire: `RichBlockSchema` below still carries this object, byte for
 *  byte, as its `attachment` member.
 *
 *  `fileId` is gateway-scoped and is NEVER a URL, which is what keeps a block from becoming a
 *  navigable anchor. Whatever surface activates this block owes the reader a route that turns the
 *  id back into bytes; v1 reserved that route rather than defining it, and
 *  `contract/ext-bots-v1.md` capability 9 is the first thing to fill it in. */
export const AttachmentBlockSchema = Type.Object({
  type: Type.Literal("attachment"),
  fileId: Type.String(),
  name: Type.String(),
  mimeType: Type.String(),
  size: Type.Integer({ minimum: 0 }),
});
export type AttachmentBlock = Static<typeof AttachmentBlockSchema>;

export const RichBlockSchema = Type.Union([
  Type.Object({ type: Type.Literal("paragraph"), text: Type.String() }),
  Type.Object({
    type: Type.Literal("code"),
    code: Type.String(),
    language: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("heading"),
    level: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("list"),
    items: Type.Array(ListItemSchema),
    ordered: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("table"),
    header: Type.Array(Type.String()),
    rows: Type.Array(Type.Array(Type.String())),
  }),
  Type.Object({ type: Type.Literal("math"), latex: Type.String() }),
  AttachmentBlockSchema,
]);
export type RichBlock = Static<typeof RichBlockSchema>;
