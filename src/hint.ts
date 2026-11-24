/**
 * The one pointer to the hosted team ledger and its paid plan: a single dim line after the human
 * output of `seatledger`, `seatledger report` and (when it found a step change) `seatledger rates`.
 *
 * It is printed at most once a day per machine, only to a terminal, never with `--json`, never in
 * MCP output, never once this machine is on a team, and never at all with `--quiet` or
 * `SEATLEDGER_QUIET=1`. It is local text: printing it sends nothing. The day it was last shown is
 * the only state, in `~/.seatledger/hint.json`; if that cannot be written the line is not shown,
 * so a read-only home never turns it into a line on every run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dayKey } from "./ledger.js";
import { DEFAULT_URL, readTeamConfig } from "./team.js";

/**
 * Where the line sends a reader: the plans page, tagged so the visit and any checkout that follows
 * it are counted as this CLI's (CONV-1). The page records the ref through its page-view beacon and
 * carries it to the Stripe Checkout as `metadata.ref`; nothing else is sent.
 */
export const PRICING_URL = `${DEFAULT_URL}/seatledger/pricing?ref=seatledger-cli`;

/**
 * After the summary and `report`, which show this machine only. The plans and prices it names are
 * in packages/config (a test holds them).
 */
export const TEAM_HINT = `That was this machine only. Your whole team in one ledger, free for up to 3 developers: \`npx seatledger team create\`; 13 months of history and rate-change emails on Team, $49/month: ${PRICING_URL}`;

/** After `rates`, when it found a step change. */
export const RATES_HINT = `seatledger Team, $49/month, emails a rate change like this one to your whole team: ${PRICING_URL}`;

export type HintKind = "team" | "rates";

export interface HintContext {
  home: string;
  now: number;
  env: NodeJS.ProcessEnv;
  /** stdout is a terminal */
  tty: boolean;
  /** --quiet */
  quiet: boolean;
}

export const hintFile = (home: string): string => path.join(home, "hint.json");

/** SEATLEDGER_QUIET=1 (any value but empty, 0 or false) silences the pointer. */
export function quietFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.SEATLEDGER_QUIET?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Dim, unless NO_COLOR asks for plain text or the terminal cannot show it. */
export function dim(text: string, env: NodeJS.ProcessEnv): string {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return text;
  if (env.TERM === "dumb") return text;
  return `\u001b[2m${text}\u001b[22m`;
}

function lastShown(home: string): string | null {
  const file = hintFile(home);
  if (!existsSync(file)) return null;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { last_shown?: unknown }).last_shown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The line to print, or null. Showing it records today, so the next call today returns null.
 * Pure apart from reading `team.json` and reading and writing `hint.json`.
 */
export function teamHint(ctx: HintContext, kind: HintKind): string | null {
  if (!ctx.tty || ctx.quiet || quietFromEnv(ctx.env)) return null;
  if (readTeamConfig(ctx.home, ctx.env)) return null;
  const today = dayKey(ctx.now);
  if (lastShown(ctx.home) === today) return null;
  try {
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(hintFile(ctx.home), JSON.stringify({ last_shown: today }) + "\n");
  } catch {
    return null;
  }
  return dim(kind === "rates" ? RATES_HINT : TEAM_HINT, ctx.env);
}
