/** Attach-v1 owns bot approvals. These shared route types remain here to avoid widening the
 * public bots surface with Dashboard implementation details. */
export type BotApprovalDecision = "approve" | "deny";
export type BotApprovalResolveOutcome =
  | "requested"
  | "resolution_pending"
  | "unknown"
  | "not_pending"
  | "expired"
  | "unsupported";
export type BotClarifyResolveOutcome =
  | "requested"
  | "resolution_pending"
  | "unknown"
  | "not_pending"
  | "expired"
  | "invalid_option"
  | "unsupported";
export type BotApprovalPush =
  | {
      kind: "approval_pending";
      bot: string;
      sessionId: string;
      turnId: string;
      toolCallId: string;
      name: string;
    }
  | {
      kind: "approval_resolved";
      bot: string;
      sessionId: string;
      turnId: string;
      toolCallId: string;
      outcome: "approved" | "denied" | "expired";
    };
