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
  Type.Object({
    type: Type.Literal("attachment"),
    fileId: Type.String(),
    name: Type.String(),
    mimeType: Type.String(),
    size: Type.Integer({ minimum: 0 }),
  }),
]);
export type RichBlock = Static<typeof RichBlockSchema>;
