import { type Static, Type } from "@sinclair/typebox";

/** Privacy-projected administration of Hermes-owned sessions. This identity space is deliberately
 * separate from gateway-owned Bot Mode `sessionId` values. */
export const HERMES_SESSION_MANAGEMENT_CAPABILITY_ID = "com.cozylabs.hermes-session-management";
/** Version 3 adds sanitized Hermes session provenance (`origin`) to every summary. */
export const HERMES_SESSION_MANAGEMENT_CAPABILITY_VERSION = 3;

export const HERMES_SESSION_LIST_MAX = 100;
export const HERMES_SESSION_SEARCH_MAX = 100;
export const HERMES_SESSION_MESSAGES_MAX = 200;
export const HERMES_SESSION_QUERY_MAX_LENGTH = 256;
export const HERMES_SESSION_OFFSET_MAX = 100_000;
export const HERMES_SESSION_TITLE_MAX_LENGTH = 100;
export const HERMES_SESSION_TEXT_MAX_LENGTH = 128 * 1024;
export const HERMES_SESSION_EXPORT_MAX_BYTES = 25 * 1024 * 1024;
export const HERMES_SESSION_EXPORT_MAX_MESSAGES = 10_000;

const HermesSessionIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const HermesSessionSummarySchema = Type.Object({
  /** Opaque Hermes identity. It is never accepted by a Bot Mode route. */
  hermesSessionId: HermesSessionIdSchema,
  /** Stable root of an auto-compression lineage. Falls back to `hermesSessionId`. */
  hermesLineageId: HermesSessionIdSchema,
  /** Sanitized Hermes `sessions.source`; known values include desktop, tui, cli, and cozygateway. */
  origin: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: HERMES_SESSION_TITLE_MAX_LENGTH })),
  startedAt: Type.Integer({ minimum: 0 }),
  lastActiveAt: Type.Integer({ minimum: 0 }),
  messageCount: Type.Integer({ minimum: 0 }),
  archived: Type.Boolean(),
  pinned: Type.Boolean(),
}, { additionalProperties: false });
export type HermesSessionSummary = Static<typeof HermesSessionSummarySchema>;

export const HermesSessionDetailResponseSchema = Type.Object({
  session: HermesSessionSummarySchema,
}, { additionalProperties: false });
export type HermesSessionDetailResponse = Static<typeof HermesSessionDetailResponseSchema>;

export const HermesSessionListResponseSchema = Type.Object({
  sessions: Type.Array(HermesSessionSummarySchema, { maxItems: HERMES_SESSION_LIST_MAX }),
  pagination: Type.Object({
    limit: Type.Integer({ minimum: 1, maximum: HERMES_SESSION_LIST_MAX }),
    offset: Type.Integer({ minimum: 0, maximum: HERMES_SESSION_OFFSET_MAX }),
    returned: Type.Integer({ minimum: 0, maximum: HERMES_SESSION_LIST_MAX }),
    total: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type HermesSessionListResponse = Static<typeof HermesSessionListResponseSchema>;

export const HermesSessionSearchResultSchema = Type.Composite([
  HermesSessionSummarySchema,
  Type.Object({
    snippet: Type.String({ maxLength: HERMES_SESSION_TEXT_MAX_LENGTH }),
    matchedRole: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant")])),
  }),
], { additionalProperties: false });
export type HermesSessionSearchResult = Static<typeof HermesSessionSearchResultSchema>;

export const HermesSessionSearchResponseSchema = Type.Object({
  results: Type.Array(HermesSessionSearchResultSchema, { maxItems: HERMES_SESSION_SEARCH_MAX }),
}, { additionalProperties: false });
export type HermesSessionSearchResponse = Static<typeof HermesSessionSearchResponseSchema>;

export const HermesSessionMessageSchema = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String({ minLength: 1, maxLength: HERMES_SESSION_TEXT_MAX_LENGTH }),
  hermesMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  createdAt: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type HermesSessionMessage = Static<typeof HermesSessionMessageSchema>;

export const HermesSessionMessagesResponseSchema = Type.Object({
  hermesSessionId: HermesSessionIdSchema,
  messages: Type.Array(HermesSessionMessageSchema, { maxItems: HERMES_SESSION_MESSAGES_MAX }),
  pagination: Type.Object({
    limit: Type.Integer({ minimum: 1, maximum: HERMES_SESSION_MESSAGES_MAX }),
    offset: Type.Integer({ minimum: 0, maximum: HERMES_SESSION_OFFSET_MAX }),
    order: Type.Union([Type.Literal("oldest"), Type.Literal("latest")]),
    returned: Type.Integer({ minimum: 0, maximum: HERMES_SESSION_MESSAGES_MAX }),
    /** Physical Hermes row offset for the next page. Hidden system/tool rows still advance it. */
    nextOffset: Type.Union([
      Type.Integer({ minimum: 0, maximum: HERMES_SESSION_OFFSET_MAX }),
      Type.Null(),
    ]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type HermesSessionMessagesResponse = Static<typeof HermesSessionMessagesResponseSchema>;

/** At least one field is required by the route. Empty `title` clears a user title. */
export const HermesSessionPatchSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: HERMES_SESSION_TITLE_MAX_LENGTH })),
  archived: Type.Optional(Type.Boolean()),
  pinned: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type HermesSessionPatch = Static<typeof HermesSessionPatchSchema>;

export const HermesSessionMutationResponseSchema = Type.Object({
  status: Type.Literal("updated"),
  session: HermesSessionSummarySchema,
}, { additionalProperties: false });
export type HermesSessionMutationResponse = Static<typeof HermesSessionMutationResponseSchema>;

export const HermesSessionExportSchema = Type.Object({
  session: HermesSessionSummarySchema,
  messages: Type.Array(HermesSessionMessageSchema, {
    maxItems: HERMES_SESSION_EXPORT_MAX_MESSAGES,
  }),
}, { additionalProperties: false });
export type HermesSessionExport = Static<typeof HermesSessionExportSchema>;
