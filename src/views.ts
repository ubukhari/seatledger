/**
 * What each command shows, as data. The CLI renders these as text and `--json`; the MCP tools
 * return them as structured content. One source, so the two cannot disagree.
 */
import {
  fillDays,
  groupRows,
  rowsByClientModel,
  startOfDay,
  totals,
  type GroupBy,
  type LedgerRow,
  type Totals,
} from "./ledger.js";
import {
  limitStatus,
  readLimits,
  vendorReadings,
  type LimitStatus,
  type VendorReading,
} from "./limits.js";
import type { Loaded, SourceSummary } from "./load.js";
import { PRICE_SOURCES, type PriceSource } from "./prices.js";
import { dailySeries, rateReport, type RateOptions, type RateReport } from "./rates.js";
import type { Client, UsageRecord } from "./types.js";

export const API_EQUIVALENT_NOTE =
  "API-equivalent: what these tokens would cost at the vendor's API list prices. Not what you were billed; a seat is a flat fee with an allowance.";

export interface Common {
  generatedAt: string;
  apiEquivalentNote: string;
  prices: readonly PriceSource[];
  sources: SourceSummary[];
}

export interface SummaryView extends Common {
  today: { day: string; rows: LedgerRow[]; totals: Totals };
  last7Days: { from: string; to: string; days: LedgerRow[]; totals: Totals };
  limits: LimitStatus[];
  vendorReadings: VendorReading[];
}

const common = (loaded: Loaded, now: number): Common => ({
  generatedAt: new Date(now).toISOString(),
  apiEquivalentNote: API_EQUIVALENT_NOTE,
  prices: PRICE_SOURCES,
  sources: loaded.sources,
});

const filterClient = (rs: readonly UsageRecord[], client?: Client) =>
  client ? rs.filter((r) => r.client === client) : rs;

export function summaryView(
  loaded: Loaded,
  now: number,
  home: string,
  client?: Client,
): SummaryView {
  const requests = filterClient(loaded.requests, client).filter((r) => r.ts <= now);
  const todayStart = startOfDay(now);
  const weekStart = startOfDay(now, 6);
  const today = requests.filter((r) => r.ts >= todayStart);
  const week = requests.filter((r) => r.ts >= weekStart);
  const days = fillDays(groupRows(week, "day"), weekStart, now);
  return {
    ...common(loaded, now),
    today: {
      day: days[days.length - 1]!.key,
      rows: rowsByClientModel(today),
      totals: totals(today),
    },
    last7Days: { from: days[0]!.key, to: days[days.length - 1]!.key, days, totals: totals(week) },
    limits: readLimits(home)
      .filter((l) => !client || l.client === "all" || l.client === client)
      .map((l) => limitStatus(l, loaded.requests, now)),
    vendorReadings: vendorReadings(
      loaded.quota.filter((q) => !client || q.client === client),
      now,
    ),
  };
}

export interface ReportView extends Common {
  by: GroupBy;
  from: string | null;
  client: Client | null;
  rows: LedgerRow[];
  totals: Totals;
}

export function reportView(
  loaded: Loaded,
  now: number,
  by: GroupBy,
  since: number | undefined,
  client?: Client,
): ReportView {
  const requests = filterClient(loaded.requests, client).filter(
    (r) => r.ts <= now && (since === undefined || r.ts >= since),
  );
  let rows = groupRows(requests, by);
  if (by === "day" && since !== undefined) rows = fillDays(rows, since, now);
  return {
    ...common(loaded, now),
    by,
    from: since === undefined ? null : new Date(since).toISOString(),
    client: client ?? null,
    rows,
    totals: totals(requests),
  };
}

export interface RatesView extends Common, RateReport {
  from: string | null;
}

export function ratesView(
  loaded: Loaded,
  now: number,
  since: number | undefined,
  filter: { client?: Client | undefined; model?: string | undefined } = {},
  opts: RateOptions = {},
): RatesView {
  // Complete days only: a day still in progress is judged when it is over.
  const today = startOfDay(now);
  const requests = filterClient(loaded.requests, filter.client).filter(
    (r) => r.ts < today && (since === undefined || r.ts >= since),
  );
  const quota = loaded.quota.filter(
    (q) =>
      (!filter.client || q.client === filter.client) &&
      q.ts < today &&
      (since === undefined || q.ts >= since),
  );
  let series = dailySeries(requests, quota, opts);
  if (filter.model) series = series.filter((s) => s.model === filter.model);
  return {
    ...common(loaded, now),
    from: since === undefined ? null : new Date(since).toISOString(),
    ...rateReport(series, opts),
  };
}

/**
 * `--since`: a date (2026-09-01) or a number of days back from today (30d, 12w). Returns the local
 * midnight it starts at, or throws a message meant for the person who typed it.
 */
export function parseSince(value: string, now: number): number {
  const v = value.trim();
  const rel = /^(\d{1,4})\s*([dw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]) * (rel[2]!.toLowerCase() === "w" ? 7 : 1);
    return startOfDay(now, Math.max(0, n - 1));
  }
  const abs = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (abs) {
    const d = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]));
    if (!Number.isNaN(d.getTime()) && d.getDate() === Number(abs[3])) return d.getTime();
  }
  throw new Error(`--since takes a date like 2026-09-01 or a span like 30d or 12w, not "${value}"`);
}
