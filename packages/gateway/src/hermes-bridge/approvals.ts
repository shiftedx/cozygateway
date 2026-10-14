/** Attach-v1 owns bot approvals. These shared route types remain here to avoid widening the
 * public bots surface with Dashboard implementation details. */
export type BotApprovalDecision = "approve" | "deny";
/** Capability 66. A decision may ask for a standing grant. `once` is the pre-66 default and needs
 * no body at all. `category` asks for a policy record bounded by the approval's own action and
 * resource and by `expiresAt`. */
export type BotApprovalDecisionScope = { grant: "once" | "category"; expiresAt?: number };
export type BotApprovalResolveOutcome =
  | "requested"
  /** Capability 66. The approval's category is on the always-require list, so no grant may cover
   *  it. The per-invocation decision is still available: resend without asking for a grant. */
  | "category_forbidden"
  /** Capability 66. A category grant was asked for on an approval that carries no scope block,
   *  so there is nothing to bound it by. */
  | "scope_required"
  /** Capability 66. The asked-for grant expiry is in the past or past the ceiling. */
  | "invalid_grant"
  /** Capability 66. A category grant was asked for over an approval that declares no category, so
   *  nothing can say the action is not one of the always-require ones. Only a single-use grant is
   *  on offer for such an ask. */
  | "category_undeclared"
  /** Capability 66. The decision stands, but the standing grant it asked for was NOT created,
   *  because this decision already carries one. Never reported as success. */
  | "grant_not_recorded"
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
