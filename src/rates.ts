/**
 * The rate-change detector: has the same kind of work started costing a different number of
 * tokens, or using the cache differently, and did it start with a client update?
 *
 * Method, kept simple enough to check by hand:
 *
 * 1. For each client and model, sum each complete local day's requests into daily figures (today
 *    is left out until it is over). A day counts only with at least `minRequests` requests
 *    (default 20); quieter days are left out, not zeroed.
 * 2. From those, per day: tokens per request; cache-read share (cache reads / all prompt tokens);
 *    cache writes per cache read; tokens per user turn (days with at least 3 turns); for Claude
 *    Code, the share of cache writes made at the 1-hour lifetime (the transcript records the
 *    split); for Codex, tokens per 1% of the 5-hour window, from the rate-limit readings Codex
 *    writes into its own rollouts.
 * 3. At every day D, compare the median of up to 7 active days before D (never reaching back past
 *    an earlier change) with the median of D and up to 6 active days after it. Each side needs at
 *    least 3 days.
 * 4. Flag D when the medians differ by at least 30% (ratios, compared in log space) or 10
 *    percentage points (shares); at least three quarters of the days on each side sit on their own
 *    side of the midpoint between the two medians; and the difference is more than three times the
 *    day-to-day spread on either side (median absolute deviation x 1.4826). Of neighbouring
 *    flagged days the strongest is kept.
 * 5. Say which client version was in use from D and whether D is the first day on it.
 *
 * It sees requests on this machine, not the vendor's servers, so it never names a cause: it says
 * what moved, when, on which version, and what that is consistent with.
 */
import { dayKey } from "./ledger.js";
import {
  CLIENT_LABEL,
  totalTokens,
  type Client,
  type QuotaSample,
  type UsageRecord,
} from "./types.js";

export const METRICS = [
  "tokens_per_request",
  "cache_read_share",
  "cache_write_per_read",
  "tokens_per_turn",
  "cache_1h_write_share",
  "tokens_per_quota_percent",
] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABEL: Readonly<Record<Metric, string>> = {
  tokens_per_request: "tokens per request",
  cache_read_share: "cache-read share of prompt tokens",
  cache_write_per_read: "cache writes per cache read",
  tokens_per_turn: "tokens per user turn",
  cache_1h_write_share: "share of cache writes at the 1-hour lifetime",
  tokens_per_quota_percent: "tokens per 1% of the 5-hour window",
};

const SHARE_METRICS: ReadonlySet<Metric> = new Set(["cache_read_share", "cache_1h_write_share"]);

export interface RateOptions {
  minRequests?: number;
  /** Active days on each side of a candidate change. */
  window?: number;
  /** Relative change for ratio metrics, e.g. 0.3 for 30%. */
  ratioThreshold?: number;
  /** Absolute change for share metrics, e.g. 0.1 for 10 percentage points. */
  shareThreshold?: number;
}

const DEFAULTS: Required<RateOptions> = {
  minRequests: 20,
  window: 7,
  ratioThreshold: 0.3,
  shareThreshold: 0.1,
};
const MIN_SIDE = 3;
const SEPARATION = 0.75;
const NOISE_SIGMAS = 3;
const MIN_TURNS = 3;

export interface DayPoint {
  day: string;
  requests: number;
  turns: number;
  version: string;
  values: Partial<Record<Metric, number>>;
  cacheReadsPerRequest: number;
  cacheWritesPerRequest: number;
}

export interface Series {
  client: Client;
  /** Model id, or "all models" for the Codex quota series. */
  model: string;
  days: DayPoint[];
}

export interface RateChange {
  metric: Metric;
  label: string;
  date: string;
  before: number;
  after: number;
  /** after / before for ratios; after − before for shares. */
  change: number;
  beforeDays: [string, string];
  afterDays: [string, string];
  score: number;
}

export interface RateFinding {
  client: Client;
  model: string;
  date: string;
  version: string;
  previousVersion: string;
  /** True when `date` is the first active day on `version` for this model. */
  versionChanged: boolean;
  changes: RateChange[];
  cacheReadsPerRequest: [before: number, after: number];
  cacheWritesPerRequest: [before: number, after: number];
  sentence: string;
  consistentWith: string;
}

export interface Baseline {
  client: Client;
  model: string;
  activeDays: number;
  firstDay: string;
  lastDay: string;
  version: string;
  /** Median of the last `window` active days. */
  current: Partial<Record<Metric, number>>;
}

export interface RateReport {
  method: string;
  findings: RateFinding[];
  baselines: Baseline[];
}

class DayAcc {
  requests = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  splitWrites = 0;
  writes1h = 0;
  turns = new Set<string>();
  versions = new Map<string, number>();

  add(r: UsageRecord): void {
    this.requests += 1;
    this.input += r.input;
    this.output += r.output;
    this.cacheRead += r.cacheRead;
    this.cacheWrite += r.cacheWrite;
    if (r.cacheWrite1h !== null) {
      this.splitWrites += r.cacheWrite;
      this.writes1h += r.cacheWrite1h;
    }
    if (r.turn) this.turns.add(r.turn);
    this.versions.set(r.version, (this.versions.get(r.version) ?? 0) + 1);
  }

  point(day: string, minRequests: number): DayPoint | undefined {
    if (this.requests < minRequests) return undefined;
    const tokens = totalTokens(this);
    const prompt = this.input + this.cacheRead + this.cacheWrite;
    const values: Partial<Record<Metric, number>> = { tokens_per_request: tokens / this.requests };
    if (prompt > 0) values.cache_read_share = this.cacheRead / prompt;
    if (this.cacheRead > 0) values.cache_write_per_read = this.cacheWrite / this.cacheRead;
    if (this.turns.size >= MIN_TURNS) values.tokens_per_turn = tokens / this.turns.size;
    if (this.splitWrites > 0) values.cache_1h_write_share = this.writes1h / this.splitWrites;
    let version = "";
    let most = -1;
    for (const [v, n] of this.versions) if (n > most) [version, most] = [v, n];
    return {
      day,
      requests: this.requests,
      turns: this.turns.size,
      version,
      values,
      cacheReadsPerRequest: this.cacheRead / this.requests,
      cacheWritesPerRequest: this.cacheWrite / this.requests,
    };
  }
}

export function dailySeries(
  requests: readonly UsageRecord[],
  quota: readonly QuotaSample[] = [],
  opts: RateOptions = {},
): Series[] {
  const { minRequests } = { ...DEFAULTS, ...opts };
  const groups = new Map<string, { client: Client; model: string; days: Map<string, DayAcc> }>();
  for (const r of requests) {
    const key = `${r.client}\u0000${r.model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { client: r.client, model: r.model, days: new Map() }));
    const day = dayKey(r.ts);
    let acc = g.days.get(day);
    if (!acc) g.days.set(day, (acc = new DayAcc()));
    acc.add(r);
  }
  const out: Series[] = [];
  for (const g of groups.values()) {
    const days = [...g.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, acc]) => acc.point(day, minRequests))
      .filter((p): p is DayPoint => p !== undefined);
    if (days.length > 0) out.push({ client: g.client, model: g.model, days });
  }
  const q = quotaSeries(requests, quota, minRequests);
  if (q) out.push(q);
  return out.sort((a, b) => a.client.localeCompare(b.client) || a.model.localeCompare(b.model));
}

/**
 * Tokens per percentage point of the vendor's 5-hour window. Each window is identified by when it
 * resets; between its first and last reading, the tokens of this machine's requests are divided
 * by how far `used_percent` moved. Readings are account-wide, so usage on other devices lowers it.
 */
function quotaSeries(
  requests: readonly UsageRecord[],
  quota: readonly QuotaSample[],
  minRequests: number,
): Series | undefined {
  const primary = quota.filter(
    (s) => s.client === "codex" && s.slot === "primary" && s.resetsAt !== null,
  );
  if (primary.length < 2) return undefined;
  const windows = new Map<string, QuotaSample[]>();
  for (const s of primary) {
    const k = `${s.limitId}@${Math.round(s.resetsAt! / 60_000)}`;
    const list = windows.get(k) ?? [];
    list.push(s);
    windows.set(k, list);
  }
  const codex = requests.filter((r) => r.client === "codex");
  const perDay = new Map<
    string,
    { tokens: number; points: number; requests: number; versions: Map<string, number> }
  >();
  for (const list of windows.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const moved = last.usedPercent - first.usedPercent;
    if (moved <= 0) continue;
    let tokens = 0;
    let n = 0;
    const versions = new Map<string, number>();
    for (const r of codex) {
      if (r.ts <= first.ts || r.ts > last.ts) continue;
      tokens += totalTokens(r);
      n += 1;
      versions.set(r.version, (versions.get(r.version) ?? 0) + 1);
    }
    if (n === 0) continue;
    const day = dayKey(last.ts);
    const acc = perDay.get(day) ?? { tokens: 0, points: 0, requests: 0, versions: new Map() };
    acc.tokens += tokens;
    acc.points += moved;
    acc.requests += n;
    for (const [v, c] of versions) acc.versions.set(v, (acc.versions.get(v) ?? 0) + c);
    perDay.set(day, acc);
  }
  const days: DayPoint[] = [];
  for (const [day, acc] of [...perDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (acc.requests < minRequests || acc.points < 2) continue;
    let version = "";
    let most = -1;
    for (const [v, c] of acc.versions) if (c > most) [version, most] = [v, c];
    days.push({
      day,
      requests: acc.requests,
      turns: 0,
      version,
      values: { tokens_per_quota_percent: acc.tokens / acc.points },
      cacheReadsPerRequest: 0,
      cacheWritesPerRequest: 0,
    });
  }
  return days.length > 0 ? { client: "codex", model: "all models", days } : undefined;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation. */
function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Step changes in one metric of one series. */
export function detectSteps(
  days: readonly DayPoint[],
  metric: Metric,
  opts: RateOptions = {},
): RateChange[] {
  const o = { ...DEFAULTS, ...opts };
  const share = SHARE_METRICS.has(metric);
  const pts = days
    .map((d) => ({ day: d.day, v: d.values[metric] }))
    .filter(
      (p): p is { day: string; v: number } =>
        p.v !== undefined &&
        Number.isFinite(p.v) &&
        // ratios are compared in log space, where a zero has no place: such days sit out
        (share || p.v > 0),
    );
  const out: RateChange[] = [];
  let floor = 0;
  let i = MIN_SIDE;
  while (i <= pts.length - MIN_SIDE) {
    const candidates: RateChange[] = [];
    // Consider a run of neighbouring flagged days, then keep the strongest.
    for (let j = i; j <= pts.length - MIN_SIDE; j++) {
      const c = candidateAt(pts, j, Math.max(floor, j - o.window), o, share, metric);
      if (c) candidates.push(c);
      else if (candidates.length > 0) break;
    }
    if (candidates.length === 0) break;
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    out.push(best);
    const at = pts.findIndex((p) => p.day === best.date);
    floor = at;
    i = at + MIN_SIDE;
  }
  return out;
}

function candidateAt(
  pts: { day: string; v: number }[],
  j: number,
  from: number,
  o: Required<RateOptions>,
  share: boolean,
  metric: Metric,
): RateChange | undefined {
  const before = pts.slice(from, j);
  const after = pts.slice(j, Math.min(pts.length, j + o.window));
  if (before.length < MIN_SIDE || after.length < MIN_SIDE) return undefined;
  const b = median(before.map((p) => p.v));
  const a = median(after.map((p) => p.v));
  let magnitude: number;
  if (share) {
    magnitude = Math.abs(a - b);
    if (magnitude < o.shareThreshold) return undefined;
  } else {
    if (b <= 0 || a <= 0) return undefined;
    magnitude = Math.abs(Math.log(a / b));
    if (magnitude < Math.log(1 + o.ratioThreshold)) return undefined;
  }
  // Work in log space for ratios, so a halving and a doubling are the same distance.
  const t = (v: number) => (share ? v : Math.log(v));
  const tb = before.map((p) => t(p.v));
  const ta = after.map((p) => t(p.v));
  const mid = (t(a) + t(b)) / 2;
  const up = a > b;
  const sideAfter = ta.filter((v) => (up ? v > mid : v < mid)).length / ta.length;
  const sideBefore = tb.filter((v) => (up ? v < mid : v > mid)).length / tb.length;
  const beyond = Math.min(sideAfter, sideBefore);
  if (beyond < SEPARATION) return undefined;
  // And larger than the day-to-day wobble on either side: a robust 3-sigma (MAD × 1.4826).
  const noise = 1.4826 * Math.max(mad(tb), mad(ta));
  if (magnitude < NOISE_SIGMAS * noise) return undefined;
  return {
    metric,
    label: METRIC_LABEL[metric],
    date: pts[j]!.day,
    before: b,
    after: a,
    change: share ? a - b : a / b,
    beforeDays: [before[0]!.day, before[before.length - 1]!.day],
    afterDays: [after[0]!.day, after[after.length - 1]!.day],
    score: magnitude * beyond,
  };
}

/** Run the detector over every series and turn the steps into findings people can read. */
export function rateReport(series: readonly Series[], opts: RateOptions = {}): RateReport {
  const o = { ...DEFAULTS, ...opts };
  const findings: RateFinding[] = [];
  const baselines: Baseline[] = [];
  for (const s of series) {
    const changes = METRICS.flatMap((m) => detectSteps(s.days, m, o));
    findings.push(...cluster(s, changes));
    const recent = s.days.slice(-o.window);
    const current: Partial<Record<Metric, number>> = {};
    for (const m of METRICS) {
      const vs = recent.map((d) => d.values[m]).filter((v): v is number => v !== undefined);
      if (vs.length > 0) current[m] = median(vs);
    }
    baselines.push({
      client: s.client,
      model: s.model,
      activeDays: s.days.length,
      firstDay: s.days[0]!.day,
      lastDay: s.days[s.days.length - 1]!.day,
      version: s.days[s.days.length - 1]!.version,
      current,
    });
  }
  findings.sort((a, b) => b.date.localeCompare(a.date));
  return { method: methodText(o), findings, baselines };
}

/** The method in one paragraph, with the thresholds actually used. */
export function methodText(opts: RateOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  return (
    `Per client and model, daily figures from complete days with at least ${o.minRequests} requests. ` +
    `A day is flagged when the median of it and up to ${o.window - 1} active days after differs from ` +
    `the median of up to ${o.window} active days before by at least ${Math.round(o.ratioThreshold * 100)}% ` +
    `(${Math.round(o.shareThreshold * 100)} percentage points for shares), at least 3/4 of the days on ` +
    `each side sit on their own side of the midpoint, and the difference exceeds ${NOISE_SIGMAS}x the ` +
    "day-to-day spread. Findings say what moved and what it is consistent with; they cannot see the vendor's side."
  );
}

export const METHOD = methodText();

/** Steps in different metrics within two active days of each other are one event. */
function cluster(s: Series, changes: RateChange[]): RateFinding[] {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  const groups: RateChange[][] = [];
  const index = (day: string) => s.days.findIndex((d) => d.day === day);
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && index(c.date) - index(g[0]!.date) <= 2) g.push(c);
    else groups.push([c]);
  }
  return groups.map((g) => finding(s, g));
}

function finding(s: Series, changes: RateChange[]): RateFinding {
  const lead = changes.reduce((a, b) => (b.score > a.score ? b : a));
  const at = s.days.findIndex((d) => d.day === lead.date);
  const day = s.days[at]!;
  const prev = s.days[at - 1];
  const before = s.days.slice(Math.max(0, at - 7), at);
  const after = s.days.slice(at, at + 7);
  const med = (xs: DayPoint[], f: (d: DayPoint) => number) => (xs.length ? median(xs.map(f)) : 0);
  const reads: [number, number] = [
    med(before, (d) => d.cacheReadsPerRequest),
    med(after, (d) => d.cacheReadsPerRequest),
  ];
  const writes: [number, number] = [
    med(before, (d) => d.cacheWritesPerRequest),
    med(after, (d) => d.cacheWritesPerRequest),
  ];
  const earlierVersions = new Set(s.days.slice(0, at).map((d) => d.version));
  const versionChanged =
    !!prev && day.version !== prev.version && !earlierVersions.has(day.version);
  const f: RateFinding = {
    client: s.client,
    model: s.model,
    date: lead.date,
    version: day.version,
    previousVersion: prev?.version ?? "",
    versionChanged,
    changes: [...changes].sort((a, b) => b.score - a.score),
    cacheReadsPerRequest: reads,
    cacheWritesPerRequest: writes,
    sentence: "",
    consistentWith: "",
  };
  f.consistentWith = interpret(f);
  f.sentence = describe(f);
  return f;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (day: string): string => {
  const [, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
};

export function movement(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "changed";
  if (ratio >= 1.9 && ratio < 2.15) return "doubled";
  if (ratio >= 2.15) return `rose ${ratio.toFixed(1)}x`;
  if (ratio > 1) return `rose ${Math.round((ratio - 1) * 100)}%`;
  if (ratio <= 0.55 && ratio > 0.45) return "halved";
  return `fell ${Math.round((1 - ratio) * 100)}%`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function describe(f: RateFinding): string {
  const client = CLIENT_LABEL[f.client];
  const clauses: string[] = [];
  const has = (m: Metric) => f.changes.find((c) => c.metric === m);
  const cacheMoved =
    has("cache_read_share") || has("cache_write_per_read") || has("cache_1h_write_share");
  if (cacheMoved && f.cacheReadsPerRequest[0] > 0 && f.cacheWritesPerRequest[0] > 0) {
    clauses.push(
      `cache reads per request ${movement(f.cacheReadsPerRequest[1] / f.cacheReadsPerRequest[0])}`,
      `cache writes per request ${movement(f.cacheWritesPerRequest[1] / f.cacheWritesPerRequest[0])}`,
    );
  }
  for (const c of f.changes) {
    if (c.metric === "cache_write_per_read" && clauses.length > 0) continue;
    clauses.push(
      SHARE_METRICS.has(c.metric)
        ? `the ${c.label} went from ${pct(c.before)} to ${pct(c.after)}`
        : `${c.label} ${movement(c.change)}`,
    );
  }
  const list =
    clauses.length <= 1
      ? (clauses[0] ?? "")
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  const where = `${client} ${f.version || "(version not recorded)"}`;
  const on = f.versionChanged ? `${where}, the first day on it` : where;
  const subject = f.model === "all models" ? `across ${client} models` : `on ${f.model}`;
  return `From ${shortDate(f.date)} (${on}), ${list} ${subject} — ${f.consistentWith}`;
}

function interpret(f: RateFinding): string {
  const get = (m: Metric) => f.changes.find((c) => c.metric === m);
  const parts: string[] = [];
  const h1 = get("cache_1h_write_share");
  const readShare = get("cache_read_share");
  const writePerRead = get("cache_write_per_read");
  const perRequest = get("tokens_per_request");
  const perTurn = get("tokens_per_turn");
  const quota = get("tokens_per_quota_percent");
  if (h1) {
    parts.push(
      h1.change < 0
        ? "the transcript itself shows writes moving from the 1-hour to the 5-minute cache lifetime, so a pause of more than five minutes now pays for a new cache write"
        : "the transcript itself shows writes moving from the 5-minute to the 1-hour cache lifetime (1-hour writes cost 2x input instead of 1.25x, and survive longer pauses)",
    );
  } else if ((readShare && readShare.change < 0) || (writePerRead && writePerRead.change > 1)) {
    parts.push(
      "consistent with a shorter cache lifetime, or a prompt prefix that changes more often, so the cache is written again instead of read",
    );
  } else if ((readShare && readShare.change > 0) || (writePerRead && writePerRead.change < 1)) {
    parts.push("consistent with a longer cache lifetime or a more stable prompt prefix");
  }
  if (perRequest && !readShare && !writePerRead && !h1) {
    parts.push(
      perRequest.change > 1
        ? "consistent with a larger prompt on every request (system prompt, tool, skill or MCP definitions) or larger contexts in your own work"
        : "consistent with a smaller fixed prompt, earlier compaction, or smaller contexts in your own work",
    );
  }
  if (perTurn && !perRequest) {
    parts.push(
      perTurn.change > 1
        ? "consistent with more requests per turn: more tool calls or subagents for each prompt"
        : "consistent with fewer requests per turn",
    );
  }
  if (quota) {
    parts.push(
      quota.change < 1
        ? "consistent with a smaller allowance per token: the same tokens now use more of the 5-hour window (usage on other devices on the same account also lowers this)"
        : "consistent with a larger allowance per token, or with less usage on other devices on the same account",
    );
  }
  if (parts.length === 0) parts.push("a step change in how this model's requests use tokens");
  const versionNote = f.versionChanged
    ? `It starts with ${CLIENT_LABEL[f.client]} ${f.version}${f.previousVersion ? ` (previously ${f.previousVersion})` : ""}.`
    : f.model === "all models"
      ? ""
      : `There was no ${CLIENT_LABEL[f.client]} version change that day, so a change in your own work is as likely.`;
  return `${parts.join("; ")}.${versionNote ? " " + versionNote : ""}`;
}
