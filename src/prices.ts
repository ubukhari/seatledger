/**
 * API list prices, used to say what a request would have cost on the vendor's API. It is an
 * API-equivalent figure, never what you were billed: a seat (Pro, Max, Plus, Team…) is a flat fee
 * with an allowance, and nothing on your machine records how the vendor counts usage against it.
 *
 * Each table is dated and sourced. Prices change; when a model is missing, its tokens are counted
 * and its dollars shown as unpriced rather than guessed.
 */
import type { UsageRecord } from "./types.js";

export interface PriceSource {
  provider: "Anthropic" | "OpenAI";
  url: string;
  /** The date the table below was read from `url`. */
  read: string;
}

export const PRICE_SOURCES: readonly PriceSource[] = [
  {
    provider: "Anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    read: "2026-10-07",
  },
  { provider: "OpenAI", url: "https://developers.openai.com/api/docs/pricing", read: "2026-10-07" },
];

/** USD per million tokens. */
export interface ModelPrice {
  provider: PriceSource["provider"];
  input: number;
  output: number;
  cacheRead: number;
  /** Writes to the 5-minute cache (Anthropic), or the one cache-write price (OpenAI). */
  cacheWrite: number;
  /** Writes to the 1-hour cache (Anthropic only). */
  cacheWrite1h?: number;
  /** Requests whose prompt is above `threshold` tokens are billed at these prices (OpenAI). */
  long?: {
    threshold: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Claude fast mode: these replace `input` and `output`; cache multipliers apply on top. */
  fast?: { input: number; output: number };
}

const anthropic = (
  input: number,
  write5m: number,
  write1h: number,
  read: number,
  output: number,
  fast?: { input: number; output: number },
): ModelPrice => ({
  provider: "Anthropic",
  input,
  output,
  cacheRead: read,
  cacheWrite: write5m,
  cacheWrite1h: write1h,
  ...(fast ? { fast } : {}),
});

/**
 * Anthropic, "Model pricing" (base input, 5m cache writes, 1h cache writes, cache hits, output) and
 * "Fast mode pricing", read 7 Oct 2026. US-only inference (`inference_geo: "us"`) is 1.1x on every
 * category for Claude 4.6 and later.
 */
const ANTHROPIC: Record<string, ModelPrice> = {
  "claude-fable-5-1": anthropic(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": anthropic(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": anthropic(10, 12.5, 20, 1, 50),
  "claude-mythos-5": anthropic(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": anthropic(4, 5, 8, 0.2, 20, { input: 8, output: 40 }),
  "claude-opus-5": anthropic(5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-8": anthropic(5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-7": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1": anthropic(15, 18.75, 30, 1.5, 75),
  "claude-opus-4": anthropic(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5-5": anthropic(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-5": anthropic(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-haiku-4-5": anthropic(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku": anthropic(0.8, 1, 1.6, 0.08, 4),
};

const openai = (
  input: number,
  cacheRead: number,
  cacheWrite: number | null,
  output: number,
  long?: [input: number, cacheRead: number, cacheWrite: number | null, output: number],
): ModelPrice => ({
  provider: "OpenAI",
  input,
  output,
  cacheRead,
  // No separate write price: written tokens are billed as ordinary input.
  cacheWrite: cacheWrite ?? input,
  ...(long
    ? {
        long: {
          threshold: 272_000,
          input: long[0],
          cacheRead: long[1],
          cacheWrite: long[2] ?? long[0],
          output: long[3],
        },
      }
    : {}),
});

/**
 * OpenAI, standard tier (input, cached input, cache writes, output; "long context" above 272K
 * input tokens), read 7 Oct 2026. Codex's own internal models (e.g. `codex-auto-review`) have no
 * list price and stay unpriced.
 */
const OPENAI: Record<string, ModelPrice> = {
  "gpt-6-astra": openai(10, 1, 12.5, 50, [20, 2, 25, 75]),
  "gpt-6.1-sol": openai(2, 0.1, 2.5, 10, [4, 0.2, 5, 15]),
  "gpt-6-sol": openai(2, 0.2, 2.5, 10, [4, 0.4, 5, 15]),
  "gpt-6-luna": openai(0.1, 0.01, 0.125, 0.5, [0.2, 0.02, 0.25, 0.75]),
  "gpt-5.6-sol": openai(4, 0.4, 5, 20, [8, 0.8, 10, 30]),
  "gpt-5.6-terra": openai(2, 0.2, 2.5, 12, [4, 0.4, 5, 18]),
  "gpt-5.6-luna": openai(0.2, 0.02, 0.25, 1.2, [0.4, 0.04, 0.5, 1.8]),
  "gpt-5.5": openai(5, 0.5, null, 30, [10, 1, null, 45]),
  "gpt-5.4": openai(2.5, 0.25, null, 15, [5, 0.5, null, 22.5]),
  "gpt-5.4-mini": openai(0.75, 0.075, null, 4.5),
  "gpt-5.3-codex": openai(1.75, 0.175, null, 14),
  "gpt-5.2": openai(1.75, 0.175, null, 14),
  "gpt-5.1": openai(1.25, 0.125, null, 10),
  "gpt-5": openai(1.25, 0.125, null, 10),
  "gpt-5-mini": openai(0.25, 0.025, null, 2),
};

/**
 * The table key for a model id as a client writes it: dated snapshots, Bedrock and Vertex forms
 * and context-window suffixes all name the same list price.
 */
export function priceKey(model: string): string {
  let m = model.toLowerCase().trim();
  m = m.replace(/\[[^\]]*\]$/, ""); // claude-opus-4-8[1m]
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, ""); // us.anthropic.claude-…
  m = m.replace(/-v\d+(?::\d+)?$/, ""); // …-v1:0
  m = m.replace(/@\d{8}$/, ""); // vertex: claude-…@20251001
  m = m.replace(/-\d{8}$/, ""); // claude-haiku-4-5-20251001
  m = m.replace(/-latest$/, "");
  if (m === "claude-opus-4-0") m = "claude-opus-4";
  if (m === "claude-sonnet-4-0") m = "claude-sonnet-4";
  return m;
}

export function priceFor(model: string): ModelPrice | undefined {
  const key = priceKey(model);
  return ANTHROPIC[key] ?? OPENAI[key];
}

export const pricedModels = (): string[] => [...Object.keys(ANTHROPIC), ...Object.keys(OPENAI)];

/** API-equivalent USD for one request, or `null` when the model has no list price here. */
export function apiEquivalentUsd(r: UsageRecord): number | null {
  const p = priceFor(r.model);
  if (!p) return null;
  const promptTokens = r.input + r.cacheRead + r.cacheWrite;
  let input = p.input;
  let output = p.output;
  let cacheRead = p.cacheRead;
  let cacheWrite = p.cacheWrite;
  let cacheWrite1h = p.cacheWrite1h ?? p.cacheWrite;
  if (p.long && promptTokens > p.long.threshold) {
    ({ input, output, cacheRead, cacheWrite } = p.long);
    cacheWrite1h = cacheWrite;
  }
  if (r.fast && p.fast) {
    // Prompt-caching multipliers stack on top of the fast-mode base prices.
    const k = p.fast.input / p.input;
    input = p.fast.input;
    output = p.fast.output;
    cacheRead *= k;
    cacheWrite *= k;
    cacheWrite1h *= k;
  }
  const write1h = r.cacheWrite1h ?? 0;
  const write5m = r.cacheWrite - write1h;
  const usd =
    (r.input * input +
      r.output * output +
      r.cacheRead * cacheRead +
      write5m * cacheWrite +
      write1h * cacheWrite1h) /
    1_000_000;
  return r.geoUs && p.provider === "Anthropic" ? usd * 1.1 : usd;
}
