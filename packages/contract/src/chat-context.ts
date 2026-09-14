/** A session-scoped, optional current-context reading for native bot chat. A gateway advertises
 * this even when a particular runtime cannot measure context: that case returns `context: null`
 * instead of substituting cumulative usage totals. */
export const CHAT_CONTEXT_CAPABILITY_ID = "com.cozylabs.chat-context";
export const CHAT_CONTEXT_CAPABILITY_VERSION = 1;
