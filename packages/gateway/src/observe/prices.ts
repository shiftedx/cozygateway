/** The operator's price sheet, and the one place tokens become money (packet D5, design section 12).
 *
 *  A price is per million tokens, in three rates: input, cached input and output. The gateway holds
 *  no vendor price list and never will: a rate changes when a vendor decides it does, and a stale
 *  number rendered as a dollar figure is worse than no number at all, because a reader cannot see
 *  that it is stale. So the rule here is narrow and blunt.
 *
 *  A MODEL WITH NO ENTRY IS UNPRICED, NOT FREE. `priceOf` returns undefined, the lifetime row
 *  counts the fold under `unpriced`, and the dashboard says "tokens only" (section 12's own
 *  phrase). It never shows `$0.00`, because an operator who reads a zero has no way to tell "we
 *  have no price" from "this model costs nothing", and those are opposite facts.
 *
 *  A PRICED ZERO IS A REAL PRICE. A model running on the operator's own hardware genuinely costs
 *  nothing per token, and the built-in sheet says so for the local models the roadmap names. That
 *  is a stated figure an operator can replace with an electricity amortization, and the lifetime
 *  row counts it under `priced`, so the dashboard renders it as a cost of zero rather than as a
 *  missing sheet. */

export interface ObserveModelPrice {
  inputPerMillion?: number;
  cachedInputPerMillion?: number;
  outputPerMillion?: number;
}

export type ObservePriceSheet = Readonly<Record<string, ObserveModelPrice>>;

/** The built-in sheet: the LOCAL models the roadmap names, stated at zero per million.
 *
 *  Nothing hosted is in here on purpose. Anthropic, OpenAI and the rest publish rates that move,
 *  and a gateway that shipped a number for one of them would be quoting a figure it cannot keep
 *  current; those models report "tokens only" until an operator writes their own rate into
 *  `observability.prices`, which is the surface section 12 names for exactly this. */
export const OBSERVE_DEFAULT_PRICES: ObservePriceSheet = Object.freeze({
  "qwen3.8-27b": { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
  "qwen3.8-27b-nvfp4": { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
  "qwen/qwen3-27b": { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
});

/** The rate for one model id: the operator's sheet first, then the built-in one, then nothing.
 *
 *  The operator's entry REPLACES the built-in one rather than merging with it, so an operator who
 *  states an input rate and no output rate gets an output rate of zero that they wrote, not one
 *  the gateway supplied behind their back. */
export function priceOf(sheet: ObservePriceSheet | undefined, model: string): ObserveModelPrice | undefined {
  return sheet?.[model] ?? OBSERVE_DEFAULT_PRICES[model];
}

/** Cost in micro-dollars for one bundle of tokens under one rate.
 *
 *  Micros rather than dollars because the lifetime table sums forever and a float that is summed a
 *  million times drifts. Cached tokens are priced at the cached rate when there is one and are NOT
 *  double counted with input: the harness reports them as their own figure. */
export function costMicros(
  price: ObserveModelPrice | undefined,
  tokens: { prompt: number; completion: number; cached: number },
): number | undefined {
  if (price === undefined) return undefined;
  const perToken = (rate: number | undefined): number => (rate ?? 0) / 1_000_000;
  const dollars =
    tokens.prompt * perToken(price.inputPerMillion)
    + tokens.cached * perToken(price.cachedInputPerMillion ?? price.inputPerMillion)
    + tokens.completion * perToken(price.outputPerMillion);
  const micros = Math.round(dollars * 1_000_000);
  return Number.isFinite(micros) && micros >= 0 ? micros : undefined;
}
