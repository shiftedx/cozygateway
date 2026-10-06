import type { RichBlock } from "cozygateway-contract";

/** The deterministic whole-message hard-interrupt phrase set. Anything not in this set (after
 *  normalization) passes through as a normal message; the agent handles conversational
 *  stop-adjacent language itself. Independently implemented here: this repo shares no code with
 *  CozyLabs by design, so the spec set and vectors are transcribed, not imported. */
export const STOP_PHRASES: readonly string[] = ["stop", "stop it", "cancel", "abort"];

const STOP_SET = new Set(STOP_PHRASES);

/** trim whitespace, casefold, strip terminal [.!?]+ characters. */
export function normalizeStopCandidate(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, "").trim();
}

/** Whole-message match only: the entire normalized message must equal one of STOP_PHRASES. */
export function isStopPhrase(text: string): boolean {
  return STOP_SET.has(normalizeStopCandidate(text));
}

/** The whole-message text to test, or undefined when the message is not a single paragraph block
 *  (a multi-block or non-paragraph message is never a stop phrase). */
export function stopCandidateFromBlocks(blocks: RichBlock[]): string | undefined {
  if (blocks.length !== 1) return undefined;
  const only = blocks[0];
  return only !== undefined && only.type === "paragraph" ? only.text : undefined;
}
