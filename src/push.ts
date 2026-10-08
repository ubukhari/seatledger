/**
 * `seatledger push`: this machine's aggregates to the team ledger, and nothing else.
 *
 * What is sent (`seatledger.push/v1`), exactly what `seatledger push --dry-run` prints:
 *
 * - `days`: every local day the push covers, from the first day this machine has history for.
 *   The ledger's rows for those days become exactly `rows`, so pushing a day again replaces it.
 * - `rows`: one per day × client × client version × model — the request count, input, output,
 *   cache-read and cache-write tokens, and API-equivalent dollars (null for a model without a
 *   list price). With `--project-names`, rows are also split by working-directory folder name.
 * - `findings`: what `seatledger rates` found in at least the last 90 days, as numbers and ids —
 *   the day each starts, the client version and the one before it, the before and after medians.
 *   The sentence you see locally is rebuilt by the service from these numbers; no text is sent.
 *
 * Never sent: prompt, response, tool or file content; file paths; session or request ids; project
 * folder names unless you pass `--project-names`.
 */
import { dayKey, startOfDay } from "./ledger.js";
import type { Loaded } from "./load.js";
import { apiEquivalentUsd } from "./prices.js";
import type { RateFinding, RateReport } from "./rates.js";
import type { Client, UsageRecord } from "./types.js";

export const PUSH_SCHEMA_ID = "seatledger.push/v1";
/** The service's limits per push; a longer history goes in several pushes. */
export const MAX_DAYS_PER_PUSH = 400;
export const MAX_ROWS_PER_PUSH = 5_000;

export interface PushRow {
  day: string;
  client: Client;
  client_version: string;
  model: string;
  project?: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  api_equivalent_usd: number | null;
}

export interface PushFinding {
  client: Client;
  model: string;
  date: string;
  version: string;
  previous_version: string;
  version_changed: boolean;
  changes: { metric: string; before: number; after: number; change: number }[];
  cache_reads_per_request: [number, number];
  cache_writes_per_request: [number, number];
}

export interface PushPayload {
  schema: typeof PUSH_SCHEMA_ID;
  days: string[];
  rows: PushRow[];
  findings: PushFinding[];
}

/** Identifiers the client wrote, kept to the service's character set (no spaces, short). */
const fit = (value: string, allowed: RegExp, max: number): string =>
  value.replace(allowed, "-").slice(0, max);
export const modelId = (m: string): string =>
  m === "all models"
    ? "*"
    : fit(m, /[^A-Za-z0-9._:@/+-]+/g, 80).replace(/^[^A-Za-z0-9]+/, "") || "unknown";
export const versionId = (v: string): string =>
  fit(v, /[^0-9A-Za-z.+_-]+/g, 40).replace(/^[^0-9A-Za-z]+/, "");
export const projectId = (p: string): string => fit(p, /[^A-Za-z0-9._-]+/g, 64);

const round = (n: number, places = 6): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return dayKey(new Date(y, m - 1, d + 1, 12).getTime());
}

/** Every local day from `from` to `to` inclusive. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) out.push(d);
  return out;
}

export function toPushFinding(f: RateFinding): PushFinding {
  return {
    client: f.client,
    model: modelId(f.model),
    date: f.date,
    version: versionId(f.version),
    previous_version: versionId(f.previousVersion),
    version_changed: f.versionChanged,
    changes: f.changes.map((c) => ({
      metric: c.metric,
      before: round(c.before),
      after: round(c.after),
      change: round(c.change),
    })),
    cache_reads_per_request: [round(f.cacheReadsPerRequest[0]), round(f.cacheReadsPerRequest[1])],
    cache_writes_per_request: [
      round(f.cacheWritesPerRequest[0]),
      round(f.cacheWritesPerRequest[1]),
    ],
  };
}

export interface BuildOptions {
  /** epoch ms: the first local day to cover (never before this machine's own first day) */
  since: number;
  now: number;
  projectNames?: boolean;
  rates?: RateReport;
}

/** The payload for one push, before it is split to fit the service's limits. */
export function buildPushPayload(loaded: Loaded, opts: BuildOptions): PushPayload {
  const sinceTs = startOfDay(opts.since);
  const inRange = loaded.requests.filter((r) => r.ts >= sinceTs && r.ts <= opts.now);
  const today = dayKey(opts.now);
  const first = inRange.reduce((m, r) => Math.min(m, r.ts), Infinity);
  const days = Number.isFinite(first) ? dayRange(dayKey(first), today) : [];

  const groups = new Map<string, { row: PushRow; unpriced: boolean }>();
  for (const r of inRange) {
    const day = dayKey(r.ts);
    const project = opts.projectNames && r.project ? projectId(r.project) : undefined;
    const key = [day, r.client, r.version, r.model, project ?? ""].join("\u0000");
    let g = groups.get(key);
    if (!g) {
      g = {
        row: {
          day,
          client: r.client,
          client_version: versionId(r.version),
          model: modelId(r.model),
          ...(project ? { project } : {}),
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          api_equivalent_usd: 0,
        },
        unpriced: false,
      };
      groups.set(key, g);
    }
    add(g, r);
  }
  const rows = [...groups.values()]
    .map(({ row, unpriced }) => ({
      ...row,
      api_equivalent_usd: unpriced ? null : round(row.api_equivalent_usd ?? 0, 4),
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.client.localeCompare(b.client) ||
        a.model.localeCompare(b.model),
    );
  // Every finding in the rates window, not only those starting since `since`: a step is found a
  // few days after it starts, so a daily push would otherwise miss it. The service keeps one per
  // step, so sending one again only refreshes it.
  const findings = (opts.rates?.findings ?? []).map(toPushFinding);
  return { schema: PUSH_SCHEMA_ID, days, rows, findings };
}

function add(g: { row: PushRow; unpriced: boolean }, r: UsageRecord): void {
  g.row.requests += 1;
  g.row.input_tokens += r.input;
  g.row.output_tokens += r.output;
  g.row.cache_read_tokens += r.cacheRead;
  g.row.cache_write_tokens += r.cacheWrite;
  const usd = apiEquivalentUsd(r);
  if (usd === null) g.unpriced = true;
  else g.row.api_equivalent_usd = (g.row.api_equivalent_usd ?? 0) + usd;
}

/**
 * Split into pushes the service accepts: contiguous runs of days with at most 400 days and 5,000
 * rows each, oldest first. Findings ride on the last one.
 */
export function splitPayload(p: PushPayload): PushPayload[] {
  if (p.days.length === 0) return [];
  const rowsByDay = new Map<string, PushRow[]>();
  for (const r of p.rows) rowsByDay.set(r.day, [...(rowsByDay.get(r.day) ?? []), r]);
  const out: PushPayload[] = [];
  let cur: PushPayload = { schema: PUSH_SCHEMA_ID, days: [], rows: [], findings: [] };
  for (const day of p.days) {
    const dayRows = rowsByDay.get(day) ?? [];
    if (
      cur.days.length > 0 &&
      (cur.days.length >= MAX_DAYS_PER_PUSH || cur.rows.length + dayRows.length > MAX_ROWS_PER_PUSH)
    ) {
      out.push(cur);
      cur = { schema: PUSH_SCHEMA_ID, days: [], rows: [], findings: [] };
    }
    cur.days.push(day);
    cur.rows.push(...dayRows);
  }
  cur.findings = p.findings;
  out.push(cur);
  return out;
}

/** The service's answer to one push (the parts the CLI prints). */
export interface PushAnswer {
  team: string;
  member: string;
  plan: string;
  history_days: number;
  history_start: string;
  days_replaced: number;
  rows_stored: number;
  rows_removed: number;
  days_skipped: string[];
  findings: { received: number; new: number; seen_before: number };
  alerts: {
    alerted: number;
    duplicates: number;
    dashboard_only: number;
    email?: string;
    slack?: string;
  };
}
