/** Operator-overridable list prices. Unknown models remain tokens only; a stated zero is free. */

export interface ObserveModelPrice {
  inputPerMillion?: number;
  cachedInputPerMillion?: number;
  outputPerMillion?: number;
}

export type ObservePriceSheet = Readonly<Record<string, ObserveModelPrice>>;

/** Standard global Claude API rates, USD per million, checked 2026-09-07.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * These are list-price estimates; operators override for regional, batch or negotiated pricing.
 * Local roadmap models default to a stated zero. Unknown ids never receive a guessed price. */
export const OBSERVE_DEFAULT_PRICES_DATE = "2026-09-07";
export const OBSERVE_DEFAULT_PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
export const OBSERVE_DEFAULT_PRICES: ObservePriceSheet = Object.freeze({
  "claude-opus-5": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-opus-4-5": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-opus-4-5-20251101": { inputPerMillion: 5, cachedInputPerMillion: .5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 2, cachedInputPerMillion: .2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, cachedInputPerMillion: .3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, cachedInputPerMillion: .3, outputPerMillion: 15 },
  "claude-sonnet-4-5-20250929": { inputPerMillion: 3, cachedInputPerMillion: .3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, cachedInputPerMillion: .1, outputPerMillion: 5 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, cachedInputPerMillion: .1, outputPerMillion: 5 },
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
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : undefined;
}
