/**
 * Coding plans as their vendors publish them, for `seatledger_plan_compare` and
 * the tokens-per-dollar CLI. Data only: every row says where it was read and when (`seen`), and
 * `plan-compare.ts` does the arithmetic.
 *
 * What is and is not here:
 * - Prices are the vendors' own, billed monthly, per seat, in USD. Annual prices are kept where
 *   the vendor publishes them, for reference; the comparison uses monthly.
 * - No plan's allowance is published in tokens. Anthropic states Claude plans only as multiples of
 *   Pro per 5-hour session, plus a weekly limit; OpenAI states Plus as a five-hour window and a
 *   weekly limit with message-count estimates it calls "not fixed"; GitHub states Copilot's
 *   allowance in dollars of AI credits. Nothing here turns the first two into a number: the
 *   comparison says so, and measures what the user's own machine records instead.
 * - The dollar price of one Codex credit is derived, and marked so (`CODEX_CREDIT`).
 *
 * Read again before changing: these pages move. When a row changes, add a `PLAN_CHANGES` entry
 * with the date the vendor gives, and move `seen`.
 */
import type { Client } from "./types.js";

export interface Cited {
  /** What was read there, in a few words. */
  label: string;
  url: string;
  /** YYYY-MM-DD the page was read. */
  seen: string;
}

export const PLAN_IDS = [
  "anthropic-api",
  "claude-pro",
  "claude-max-5x",
  "claude-max-20x",
  "claude-team-standard",
  "claude-team-premium",
  "openai-api",
  "chatgpt-plus",
  "chatgpt-pro",
  "codex-credits",
  "copilot-pro",
  "copilot-pro-plus",
  "copilot-max",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Shorthands `--plans` and the MCP tool accept for a vendor's whole row set. */
export const PLAN_GROUPS: Readonly<Record<string, readonly PlanId[]>> = {
  claude: [
    "anthropic-api",
    "claude-pro",
    "claude-max-5x",
    "claude-max-20x",
    "claude-team-standard",
    "claude-team-premium",
  ],
  codex: ["openai-api", "chatgpt-plus", "chatgpt-pro", "codex-credits"],
  copilot: ["copilot-pro", "copilot-pro-plus", "copilot-max"],
};

/**
 * How a plan turns tokens into dollars.
 * - `api`: every token at the vendor's API list price (seatledger's dated price table).
 * - `allowance`: a flat fee with an allowance the vendor does not publish in tokens; past it,
 *   usage is billed at `overage` rates.
 * - `codex-credits`: every token at OpenAI's Codex credit rate card.
 * - `copilot-credits`: every token at GitHub's per-model rates, less the AI credits the plan
 *   includes; past them, the same rates.
 */
export type Meter = "api" | "allowance" | "codex-credits" | "copilot-credits";

export interface Plan {
  id: PlanId;
  vendor: "Anthropic" | "OpenAI" | "GitHub";
  name: string;
  /** Whose local transcripts hold work this plan can run: Claude Code, Codex or both. */
  carries: readonly Client[];
  meter: Meter;
  /** Per seat per month, billed monthly. `null` for pay-as-you-go. */
  usdMonthly: number | null;
  /** Per seat per month, billed annually, where the vendor publishes it. */
  usdMonthlyAnnual?: number;
  minSeats?: number;
  /** Other prices on the same row, as the vendor states them (e.g. Pro's three tiers). */
  priceNote?: string;
  /** Usage past the allowance is billed at these rates. */
  overage?: "api" | "codex-credits" | "copilot-credits";
  /** Anthropic: the published multiple of Claude Pro's per-session allowance. */
  timesPro?: number;
  /** Copilot: AI credits included a month, in USD (1 credit = $0.01), flex allotment included. */
  includedUsd?: number;
  /** Of `includedUsd`, the flex allotment GitHub says may change over time. */
  flexUsd?: number;
  /** The `plan_type` Codex writes into its rate-limit readings for this plan. */
  codexPlanType?: string;
  /** Model-id prefixes this plan bills at `overage` rates from the first token. */
  overageOnlyModels?: readonly string[];
  /** The allowance, in the vendor's own terms. */
  allowance: string;
  sources: readonly Cited[];
  /** The latest `seen` of its sources. */
  seen: string;
}

const SEEN = "2026-10-08";

const CLAUDE_PRICING: Cited = {
  label: "Claude plans and pricing",
  url: "https://claude.com/pricing",
  seen: SEEN,
};
const CLAUDE_MAX: Cited = {
  label: "What is the Max plan?",
  url: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan",
  seen: SEEN,
};
const CLAUDE_TEAM: Cited = {
  label: "What is the Team plan?",
  url: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan",
  seen: SEEN,
};
const CLAUDE_TEAM_CODE: Cited = {
  label: "Claude Code on Team and Enterprise seats",
  url: "https://support.claude.com/en/articles/11845131",
  seen: SEEN,
};
const CLAUDE_EXTRA: Cited = {
  label: "Manage usage credits for paid Claude plans",
  url: "https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans",
  seen: SEEN,
};
const CLAUDE_FABLE: Cited = {
  label: "Claude Fable models on your plan",
  url: "https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan",
  seen: SEEN,
};
const ANTHROPIC_API: Cited = {
  label: "Anthropic API model pricing",
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  seen: "2026-10-07",
};
const CODEX_PRICING: Cited = {
  label: "Codex pricing (developers.openai.com/codex/pricing redirects here)",
  url: "https://learn.chatgpt.com/docs/pricing",
  seen: SEEN,
};
const CHATGPT_PRO_TIERS: Cited = {
  label: "About ChatGPT Pro tiers",
  url: "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers",
  seen: SEEN,
};
const CODEX_RATE_CARD: Cited = {
  label: "ChatGPT rate card: credit-based pricing",
  url: "https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing",
  seen: SEEN,
};
const OPENAI_API: Cited = {
  label: "OpenAI API pricing",
  url: "https://developers.openai.com/api/docs/pricing",
  seen: "2026-10-07",
};
const COPILOT_PLANS: Cited = {
  label: "GitHub Copilot plans",
  url: "https://github.com/features/copilot/plans",
  seen: SEEN,
};
const COPILOT_BILLING: Cited = {
  label: "Copilot billing for individuals (1 AI credit = $0.01)",
  url: "https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals",
  seen: SEEN,
};
const COPILOT_RATES: Cited = {
  label: "Copilot models and pricing (per-token rates)",
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  seen: SEEN,
};

const CLAUDE_WINDOWS =
  "a 5-hour session allowance and a weekly limit, shared with Claude on the web and desktop; no message, hour or token count is published";

export const PLANS: readonly Plan[] = [
  {
    id: "anthropic-api",
    vendor: "Anthropic",
    name: "Anthropic API",
    carries: ["claude-code"],
    meter: "api",
    usdMonthly: null,
    allowance: "none: every token at list price",
    sources: [ANTHROPIC_API],
    seen: "2026-10-07",
  },
  {
    id: "claude-pro",
    vendor: "Anthropic",
    name: "Claude Pro",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 20,
    usdMonthlyAnnual: 17,
    overage: "api",
    timesPro: 1,
    overageOnlyModels: ["claude-fable"],
    allowance: `${CLAUDE_WINDOWS}; Fable models run on usage credits only`,
    sources: [CLAUDE_PRICING, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN,
  },
  {
    id: "claude-max-5x",
    vendor: "Anthropic",
    name: "Claude Max 5x",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 100,
    priceNote: "monthly billing only",
    overage: "api",
    timesPro: 5,
    allowance: `5 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_MAX, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN,
  },
  {
    id: "claude-max-20x",
    vendor: "Anthropic",
    name: "Claude Max 20x",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 200,
    priceNote: "monthly billing only",
    overage: "api",
    timesPro: 20,
    allowance: `20 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_MAX, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN,
  },
  {
    id: "claude-team-standard",
    vendor: "Anthropic",
    name: "Claude Team standard",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 25,
    usdMonthlyAnnual: 20,
    minSeats: 2,
    overage: "api",
    timesPro: 1.25,
    overageOnlyModels: ["claude-fable"],
    allowance: `1.25 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable models run on usage credits only`,
    sources: [CLAUDE_PRICING, CLAUDE_TEAM, CLAUDE_TEAM_CODE, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN,
  },
  {
    id: "claude-team-premium",
    vendor: "Anthropic",
    name: "Claude Team premium",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 125,
    usdMonthlyAnnual: 100,
    minSeats: 2,
    overage: "api",
    timesPro: 6.25,
    allowance: `6.25 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_PRICING, CLAUDE_TEAM, CLAUDE_TEAM_CODE, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN,
  },
  {
    id: "openai-api",
    vendor: "OpenAI",
    name: "OpenAI API",
    carries: ["codex"],
    meter: "api",
    usdMonthly: null,
    allowance: "none: every token at list price",
    sources: [OPENAI_API],
    seen: "2026-10-07",
  },
  {
    id: "chatgpt-plus",
    vendor: "OpenAI",
    name: "ChatGPT Plus",
    carries: ["codex"],
    meter: "allowance",
    usdMonthly: 20,
    overage: "codex-credits",
    codexPlanType: "plus",
    allowance:
      "a five-hour window and a weekly limit; OpenAI publishes local-message estimates per five hours that it calls not fixed limits; extra credits can be bought past the limit",
    sources: [CODEX_PRICING],
    seen: SEEN,
  },
  {
    id: "chatgpt-pro",
    vendor: "OpenAI",
    name: "ChatGPT Pro",
    carries: ["codex"],
    meter: "allowance",
    usdMonthly: 100,
    priceNote: "tiers at $100, $200 and $500 a month, billed monthly",
    overage: "codex-credits",
    codexPlanType: "pro",
    allowance:
      "no five-hour limit; weekly limits, not published in tokens or as a multiple of Plus; extra credits can be bought past the limit",
    sources: [CODEX_PRICING, CHATGPT_PRO_TIERS],
    seen: SEEN,
  },
  {
    id: "codex-credits",
    vendor: "OpenAI",
    name: "Codex credits",
    carries: ["codex"],
    meter: "codex-credits",
    usdMonthly: null,
    allowance: "none: every token at the credit rate card",
    sources: [CODEX_RATE_CARD, CODEX_PRICING],
    seen: SEEN,
  },
  {
    id: "copilot-pro",
    vendor: "GitHub",
    name: "Copilot Pro",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 10,
    includedUsd: 15,
    flexUsd: 5,
    overage: "copilot-credits",
    allowance: "$15 of AI credits a month ($10 base and a $5 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN,
  },
  {
    id: "copilot-pro-plus",
    vendor: "GitHub",
    name: "Copilot Pro+",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 39,
    includedUsd: 70,
    flexUsd: 31,
    overage: "copilot-credits",
    allowance: "$70 of AI credits a month ($39 base and a $31 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN,
  },
  {
    id: "copilot-max",
    vendor: "GitHub",
    name: "Copilot Max",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 100,
    includedUsd: 200,
    flexUsd: 100,
    overage: "copilot-credits",
    allowance: "$200 of AI credits a month ($100 base and a $100 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN,
  },
];

/** Rates per million tokens. */
export interface TokenRates {
  input: number;
  cachedInput: number;
  /** `null`: no separate cache-write charge; written tokens count as input. */
  cacheWrite: number | null;
  output: number;
  /** Above this many prompt tokens, `long` applies to the whole request. */
  long?: {
    threshold: number;
    input: number;
    cachedInput: number;
    cacheWrite: number | null;
    output: number;
  };
}

/**
 * The dollar price of one Codex credit, derived: OpenAI does not state one for Plus and Pro
 * ("available purchase amounts, prices … can vary"). Two of its own figures agree on $0.04: "$100
 * worth of workspace credits (2,500 credits)" in its Business premium-seat post, and the
 * Enterprise USD rate card, which is 25 credits to the dollar on every row.
 */
export const CODEX_CREDIT = {
  usd: 0.04,
  derived: true,
  how: "OpenAI does not state a price per credit for Plus or Pro; $0.04 is derived from its own figures: $100 of workspace credits is 2,500 credits, and its Enterprise USD rate card is 25 credits to the dollar on every row",
  sources: [
    {
      label: "Premium seats in ChatGPT Business ($100 of credits = 2,500 credits)",
      url: "https://openai.com/index/premium-seats-chatgpt-business/",
      seen: SEEN,
    },
    {
      label: "ChatGPT rate card: Enterprise token-based pricing (USD)",
      url: "https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing",
      seen: SEEN,
    },
    {
      label: "Codex credit purchases (prices can vary)",
      url: "https://help.openai.com/en/articles/12642688",
      seen: SEEN,
    },
  ] as readonly Cited[],
} as const;

const credits = (input: number, cachedInput: number, output: number): TokenRates => ({
  input,
  cachedInput,
  cacheWrite: null, // "Codex credit billing has no separate cache-write charge."
  output,
});

/**
 * OpenAI's Codex rate card, credits per million tokens at Standard speed (learn.chatgpt.com/docs/
 * pricing and the help-center rate card, read 8 Oct 2026). Keys are seatledger's model keys
 * (`priceKey`). GPT-5.6 Sol's rates are promotional, "at least through November 21, 2026".
 */
export const CODEX_CREDIT_RATES: Readonly<Record<string, TokenRates>> = {
  "gpt-6-astra": credits(250, 25, 1250),
  "gpt-6.1-sol": credits(50, 2.5, 250),
  "gpt-6-sol": credits(50, 5, 250),
  "gpt-6-luna": credits(2.5, 0.25, 12.5),
  "gpt-5.6-sol": credits(100, 10, 500),
  "gpt-5.6-terra": credits(50, 5, 300),
  "gpt-5.6-luna": credits(5, 0.5, 30),
  "gpt-5.5": credits(125, 12.5, 750),
  "gpt-5.3-codex": credits(43.75, 4.375, 350),
  "gpt-5.2": credits(43.75, 4.375, 350),
};

const usd = (
  input: number,
  cachedInput: number,
  cacheWrite: number | null,
  output: number,
  long?: [
    threshold: number,
    input: number,
    cachedInput: number,
    cacheWrite: number | null,
    output: number,
  ],
): TokenRates => ({
  input,
  cachedInput,
  cacheWrite,
  output,
  ...(long
    ? {
        long: {
          threshold: long[0],
          input: long[1],
          cachedInput: long[2],
          cacheWrite: long[3],
          output: long[4],
        },
      }
    : {}),
});

/**
 * GitHub Copilot's per-token rates, USD per million tokens (docs.github.com, "Models and
 * pricing", read 8 Oct 2026), converted to AI credits at $0.01 each. Keys are seatledger's model
 * keys. Claude cache writes have one price on Copilot, used for 5-minute and 1-hour writes alike.
 * `claude-opus-4-8-fast` is the fast-mode row; fast requests on any other model are priced at the
 * model's standard row, since GitHub lists no other.
 */
export const COPILOT_RATES_USD: Readonly<Record<string, TokenRates>> = {
  "claude-haiku-4-5": usd(1, 0.1, 1.25, 5),
  "claude-haiku-5-5": usd(0.1, 0.01, 0.125, 0.5, [100_000, 0.5, 0.05, 0.625, 2.5]),
  "claude-sonnet-4": usd(3, 0.3, 3.75, 15),
  "claude-sonnet-4-6": usd(3, 0.3, 3.75, 15),
  "claude-sonnet-5": usd(2, 0.2, 2.5, 10),
  "claude-sonnet-5-5": usd(2, 0.1, 2.5, 10),
  "claude-opus-4-8": usd(5, 0.5, 6.25, 25),
  "claude-opus-4-8-fast": usd(10, 1, 12.5, 50),
  "claude-opus-5": usd(5, 0.5, 6.25, 25),
  "claude-opus-5-5": usd(4, 0.2, 5, 20),
  "claude-fable-5": usd(10, 1, 12.5, 50),
  "claude-fable-5-1": usd(10, 0.25, 12.5, 50),
  "gpt-5-mini": usd(0.25, 0.025, null, 2),
  "gpt-5.3-codex": usd(1.75, 0.175, null, 14),
  "gpt-5.4": usd(2.5, 0.25, null, 15, [272_000, 5, 0.5, null, 22.5]),
  "gpt-5.4-mini": usd(0.75, 0.075, null, 4.5),
  "gpt-5.5": usd(5, 0.5, null, 30, [272_000, 10, 1, null, 45]),
  "gpt-5.6-luna": usd(0.2, 0.02, 0.25, 1.2, [200_000, 0.4, 0.04, 0.5, 1.8]),
  "gpt-5.6-sol": usd(4, 0.4, 5, 20, [272_000, 8, 0.8, 10, 30]),
  "gpt-5.6-terra": usd(2, 0.2, 2.5, 12, [272_000, 4, 0.4, 5, 18]),
  "gpt-6-astra": usd(10, 1, 12.5, 50, [272_000, 20, 2, 25, 75]),
  "gpt-6-luna": usd(0.1, 0.01, 0.125, 0.5, [272_000, 0.2, 0.02, 0.25, 0.75]),
  "gpt-6-sol": usd(2, 0.2, 2.5, 10, [272_000, 4, 0.4, 5, 15]),
  "gpt-6.1-sol": usd(2, 0.1, 2.5, 10, [272_000, 4, 0.2, 5, 15]),
};

export interface PlanChange {
  /** The date the vendor gives for it, YYYY-MM-DD (future dates are announced changes). */
  date: string;
  vendor: Plan["vendor"];
  /** The plans it changed. */
  plans: readonly PlanId[];
  /**
   * Plans that did not exist in this form before the date. Undoing the change removes them, which
   * is how the comparison finds the last change that moved its answer.
   */
  introduced?: readonly PlanId[];
  /**
   * false: kept for the changelog; nothing the comparison prices depends on it. A change to a limit
   * no vendor publishes as a number is `true` without `introduced`: it touches the answer, but
   * cannot be undone in arithmetic.
   */
  priced: boolean;
  /** What changed, in the vendor's terms. Never why. */
  what: string;
  /** Who says so: the vendor, or (`reported: true`) the press quoting the vendor. */
  source: Cited;
  reported?: true;
}

/** Dated vendor changes to the plans above, oldest first. */
export const PLAN_CHANGES: readonly PlanChange[] = [
  {
    date: "2026-01-16",
    vendor: "Anthropic",
    plans: ["claude-team-standard"],
    introduced: ["claude-team-standard"],
    priced: true,
    what: "Claude Code access added to Team plan standard seats.",
    source: {
      label: "Claude release notes, 16 January 2026",
      url: "https://support.claude.com/en/articles/12138966-release-notes",
      seen: SEEN,
    },
  },
  {
    date: "2026-04-02",
    vendor: "OpenAI",
    plans: ["chatgpt-plus", "chatgpt-pro", "codex-credits"],
    introduced: ["codex-credits"],
    priced: true,
    what: "Codex credits priced by token, aligned with API token usage, instead of per message, for Plus, Pro and Business (existing Enterprise plans followed on 23 April).",
    source: {
      label:
        "OpenAI help center, Codex rate card (article 20001106, as indexed; the live URL now redirects to the credit rate card, which no longer carries the date)",
      url: "https://help.openai.com/en/articles/20001106-codex-rate-card",
      seen: SEEN,
    },
  },
  {
    date: "2026-05-13",
    vendor: "Anthropic",
    plans: [
      "claude-pro",
      "claude-max-5x",
      "claude-max-20x",
      "claude-team-standard",
      "claude-team-premium",
    ],
    priced: true,
    what: "Weekly usage limits in Claude Code 50% higher, as a promotion through 13 September 2026.",
    source: {
      label: "Claude Code May–August 2026 weekly limits promotion",
      url: "https://support.claude.com/en/articles/15910845-claude-code-may-august-2026-weekly-limits-promotion",
      seen: SEEN,
    },
  },
  {
    date: "2026-06-01",
    vendor: "GitHub",
    plans: ["copilot-pro", "copilot-pro-plus", "copilot-max"],
    introduced: ["copilot-pro", "copilot-pro-plus", "copilot-max"],
    priced: true,
    what: "Every Copilot plan billed in GitHub AI credits, each token priced by model, replacing premium requests (which remain only on legacy annual plans).",
    source: {
      label: "GitHub changelog, 1 June 2026: updates to Copilot billing and plans",
      url: "https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/",
      seen: SEEN,
    },
  },
  {
    date: "2026-08-25",
    vendor: "OpenAI",
    plans: ["chatgpt-plus"],
    priced: true,
    what: "Five-hour limit back on Codex for Plus after a period without one, announced on X by OpenAI's engineering lead for Codex; Pro stays without one. OpenAI's pricing page lists Plus with a five-hour window and Pro without.",
    source: {
      label: "iThinkDifferent, 25 August 2026, on the announcement",
      url: "https://www.ithinkdiff.com/openai-codex-five-hour-limit/",
      seen: SEEN,
    },
    reported: true,
  },
  {
    date: "2026-09-14",
    vendor: "Anthropic",
    plans: [
      "claude-pro",
      "claude-max-5x",
      "claude-max-20x",
      "claude-team-standard",
      "claude-team-premium",
    ],
    priced: true,
    what: "The promotion ended: standard weekly limits in Claude Code are 25% higher than before it, which is one sixth (about 17%) less than during it.",
    source: {
      label: "Claude Code May–August 2026 weekly limits promotion",
      url: "https://support.claude.com/en/articles/15910845-claude-code-may-august-2026-weekly-limits-promotion",
      seen: SEEN,
    },
  },
  {
    date: "2026-10-07",
    vendor: "Anthropic",
    plans: ["claude-max-5x", "claude-max-20x", "claude-team-standard", "claude-team-premium"],
    priced: false,
    what: "Max and Team plans include monthly API credits for the Claude Platform ($100 on Max 5x, $200 on Max 20x, $20 and $100 per Team seat); they do not cover interactive Claude Code.",
    source: {
      label: "Monthly API credits for Max and Team plans",
      url: "https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans",
      seen: SEEN,
    },
  },
  {
    date: "2026-10-14",
    vendor: "OpenAI",
    plans: ["chatgpt-plus", "chatgpt-pro", "codex-credits"],
    priced: false,
    what: "GPT-5.5 retires from Codex on all plans.",
    source: CODEX_PRICING,
  },
];

export const planById = (id: PlanId): Plan => PLANS.find((p) => p.id === id)!;
