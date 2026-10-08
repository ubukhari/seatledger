/**
 * The ledger: requests summed by day, project, model or client. Days are local calendar days on
 * this machine. Dollars are API-equivalent (see prices.ts) and requests on a model without a list
 * price are counted in tokens and reported as unpriced, never priced by guess.
 */
import { apiEquivalentUsd } from "./prices.js";
import { CLIENT_LABEL, totalTokens, type UsageRecord } from "./types.js";

export const GROUP_BY = ["day", "project", "model", "client"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface Totals {
  requests: number;
  /** Distinct turns a person started, where the transcript lets us tell. */
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** API-equivalent USD of the priced requests. */
  apiEquivalentUsd: number;
  unpricedRequests: number;
  unpricedModels: string[];
}

export interface LedgerRow extends Totals {
  key: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of the day `days` before the day containing `now`. */
export function startOfDay(now: number, daysBack = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

class Acc {
  requests = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  usd = 0;
  unpriced = 0;
  unpricedModels = new Set<string>();
  turns = new Set<string>();

  add(r: UsageRecord): void {
    this.requests += 1;
    this.input += r.input;
    this.output += r.output;
    this.cacheRead += r.cacheRead;
    this.cacheWrite += r.cacheWrite;
    if (r.turn) this.turns.add(r.turn);
    const usd = apiEquivalentUsd(r);
    if (usd === null) {
      this.unpriced += 1;
      this.unpricedModels.add(r.model);
    } else this.usd += usd;
  }

  totals(): Totals {
    return {
      requests: this.requests,
      turns: this.turns.size,
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      tokens: totalTokens(this),
      apiEquivalentUsd: round2(this.usd),
      unpricedRequests: this.unpriced,
      unpricedModels: [...this.unpricedModels].sort(),
    };
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function groupKey(r: UsageRecord, by: GroupBy): string {
  switch (by) {
    case "day":
      return dayKey(r.ts);
    case "project":
      return r.project || "(unknown folder)";
    case "model":
      return r.model;
    case "client":
      return CLIENT_LABEL[r.client];
  }
}

export function totals(requests: readonly UsageRecord[]): Totals {
  const acc = new Acc();
  for (const r of requests) acc.add(r);
  return acc.totals();
}

/** Rows sorted by day ascending, or by API-equivalent dollars (then tokens) for other groupings. */
export function groupRows(requests: readonly UsageRecord[], by: GroupBy): LedgerRow[] {
  return rowsBy(requests, (r) => groupKey(r, by), by === "day");
}

/** Client and model together ("Claude Code · claude-opus-5-5"), for the summary's today table. */
export function rowsByClientModel(requests: readonly UsageRecord[]): LedgerRow[] {
  return rowsBy(requests, (r) => `${CLIENT_LABEL[r.client]} · ${r.model}`, false);
}

function rowsBy(
  requests: readonly UsageRecord[],
  keyOf: (r: UsageRecord) => string,
  chronological: boolean,
): LedgerRow[] {
  const accs = new Map<string, Acc>();
  for (const r of requests) {
    const key = keyOf(r);
    let acc = accs.get(key);
    if (!acc) accs.set(key, (acc = new Acc()));
    acc.add(r);
  }
  const rows = [...accs].map(([key, acc]) => ({ key, ...acc.totals() }));
  return chronological
    ? rows.sort((a, b) => a.key.localeCompare(b.key))
    : rows.sort((a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd || b.tokens - a.tokens);
}

/** Every day from `from` to `to` inclusive, so quiet days show as zero rather than vanish. */
export function fillDays(rows: LedgerRow[], from: number, to: number): LedgerRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: LedgerRow[] = [];
  for (let t = startOfDay(from); t <= to;) {
    const key = dayKey(t);
    out.push(byKey.get(key) ?? { key, ...new Acc().totals() });
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    t = d.getTime();
  }
  return out;
}
