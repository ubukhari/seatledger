/** Text for people. Every dollar figure on screen is labelled API-equivalent. */
import { clock, dayLabel, duration, int, percent, table, tokens, usd } from "./format.js";
import type { LedgerRow, Totals } from "./ledger.js";
import type { LimitStatus, VendorReading } from "./limits.js";
import type { SourceSummary } from "./load.js";
import { METRIC_LABEL, METRICS, shortDate, type Metric } from "./rates.js";
import { CLIENT_LABEL } from "./types.js";
import type { RatesView, ReportView, SummaryView } from "./views.js";

const HEAD = [
  "",
  "requests",
  "input",
  "output",
  "cache write",
  "cache read",
  "tokens",
  "API-equiv $",
];

function cells(key: string, t: Totals): string[] {
  return [
    key,
    int(t.requests),
    tokens(t.input),
    tokens(t.output),
    tokens(t.cacheWrite),
    tokens(t.cacheRead),
    tokens(t.tokens),
    t.requests === 0 ? "—" : usd(t.apiEquivalentUsd) + (t.unpricedRequests > 0 ? "*" : ""),
  ];
}

function ledgerTable(rows: LedgerRow[], total: Totals, label: (k: string) => string = (k) => k) {
  const body = rows.map((r) => cells(label(r.key), r));
  if (rows.length > 1) body.push(cells("total", total));
  return table(HEAD, body);
}

function unpricedNote(t: Totals): string[] {
  if (t.unpricedRequests === 0) return [];
  return [
    `  * excludes ${int(t.unpricedRequests)} requests on models with no API list price (${t.unpricedModels.join(", ")}); their tokens are counted.`,
  ];
}

export function renderSummary(v: SummaryView, now: number): string {
  const out: string[] = [];
  out.push("seatledger — what your coding-agent seats and tokens bought, from this machine");
  out.push("");
  out.push(`Today, ${dayLabel(v.today.day)}`);
  out.push(
    v.today.rows.length === 0
      ? "  no requests yet today"
      : ledgerTable(v.today.rows, v.today.totals),
  );
  out.push(...unpricedNote(v.today.totals));
  out.push("");
  out.push(`Last 7 days, ${dayLabel(v.last7Days.from)} – ${dayLabel(v.last7Days.to)}`);
  out.push(ledgerTable(v.last7Days.days, v.last7Days.totals, dayLabel));
  out.push(...unpricedNote(v.last7Days.totals));
  out.push("");
  out.push(...renderLimits(v.limits, v.vendorReadings, now));
  out.push("");
  out.push(
    wrap(`API-equiv $ = ${v.apiEquivalentNote.replace(/^API-equivalent: /, "")}`, 100, "  "),
  );
  out.push(...renderSources(v.sources));
  out.push(
    "More: seatledger report --by project · seatledger rates · seatledger limits set --window 5h --tokens N",
  );
  return out.join("\n");
}

export function renderLimits(
  limits: LimitStatus[],
  readings: VendorReading[],
  now: number,
): string[] {
  const out: string[] = [];
  if (limits.length === 0) {
    out.push("Limits: none set. `seatledger limits set --window 5h --tokens N` records your own;");
    out.push("  seatledger does not guess a vendor's plan limits.");
  } else {
    out.push("Your limits");
    for (const s of limits) out.push(`  ${limitLine(s, now)}`);
  }
  const current = readings.filter((r) => r.current);
  if (current.length > 0) {
    out.push("Vendor readings, as the client last wrote them to disk");
    for (const r of current) out.push(`  ${readingLine(r, now)}`);
  }
  return out;
}

const amountOf = (s: LimitStatus, n: number) =>
  s.unit === "tokens" ? `${tokens(n)} tokens` : usd(n);

function limitLine(s: LimitStatus, now: number): string {
  const scope = s.limit.client === "all" ? "all clients" : CLIENT_LABEL[s.limit.client];
  const name = s.limit.window === "5h" ? "5-hour window" : "last 7 days";
  const head = `${name}, ${scope}: ${amountOf(s, s.used)} of ${amountOf(s, s.amount)} (${percent(s.fraction)})`;
  if (s.limit.window === "5h" && s.windowStart === null) {
    const b = s.busiest
      ? `; busiest window in 30 days: ${amountOf(s, s.busiest.used)} (${clock(s.busiest.start, now)})`
      : "";
    return `${head} — no window open${b}`;
  }
  const burn = `burning ${amountOf(s, s.burnPerHour)}/h`;
  if (s.reached && s.reachedAt !== null) return `${head} — reached at ${clock(s.reachedAt, now)}`;
  if (s.reachedAt !== null)
    return `${head} · ${burn} · at this rate reached ${clock(s.reachedAt, now)} (in ${duration(s.reachedAt - now)})`;
  if (s.windowEnd !== null)
    return `${head} · ${burn} · window resets ${clock(s.windowEnd, now)} before you reach it`;
  return `${head} · ${burn}`;
}

function readingLine(r: VendorReading, now: number): string {
  const name =
    r.windowMinutes === 300
      ? "5-hour window"
      : r.windowMinutes === 10080
        ? "weekly window"
        : r.windowMinutes
          ? `${duration(r.windowMinutes * 60_000)} window`
          : `${r.slot} window`;
  const resets = r.resetsAt ? `, resets ${clock(r.resetsAt, now)}` : "";
  const plan = r.planType ? `, plan ${r.planType}` : "";
  return `${CLIENT_LABEL[r.client]} ${name}: ${Math.round(r.usedPercent)}% used${resets}${plan} (read ${clock(r.readAt, now)})`;
}

export function renderSources(sources: SourceSummary[]): string[] {
  const parts = sources
    .filter((s) => s.files > 0 || s.retained > 0)
    .map((s) => {
      const kept = s.retained > 0 ? ` + ${int(s.retained)} kept after the client deleted them` : "";
      return `${int(s.files)} ${CLIENT_LABEL[s.client]} transcripts${kept}`;
    });
  if (parts.length === 0) {
    const where = sources.map((s) => s.roots.join(", ")).join("; ");
    return [`No transcripts found (looked in ${where}). Nothing was sent anywhere.`];
  }
  return [
    wrap(
      `Read ${parts.join(" and ")}, on this machine only. Nothing was sent anywhere.`,
      100,
      "  ",
    ),
  ];
}

export function renderReport(v: ReportView): string {
  const out: string[] = [];
  const from = v.from ? ` since ${dayLabel(v.from.slice(0, 10))}` : "";
  const scope = v.client ? ` · ${CLIENT_LABEL[v.client]}` : "";
  out.push(`seatledger report — by ${v.by}${from}${scope}`);
  out.push("");
  out.push(
    v.rows.length === 0
      ? "  no requests in this range"
      : ledgerTable(v.rows, v.totals, v.by === "day" ? dayLabel : (k) => k),
  );
  out.push(...unpricedNote(v.totals));
  out.push("");
  out.push(
    wrap(`API-equiv $ = ${v.apiEquivalentNote.replace(/^API-equivalent: /, "")}`, 100, "  "),
  );
  out.push(...renderSources(v.sources));
  return out.join("\n");
}

function metricValue(m: Metric, v: number): string {
  if (m === "cache_read_share" || m === "cache_1h_write_share") return percent(v);
  if (m === "cache_write_per_read") return v.toFixed(3);
  return tokens(v);
}

export function renderRates(v: RatesView): string {
  const out: string[] = [];
  out.push("seatledger rates — has the same work started costing a different number of tokens?");
  out.push("");
  if (v.findings.length === 0) {
    out.push("  No step changes found.");
  } else {
    out.push(`  ${v.findings.length} step change${v.findings.length === 1 ? "" : "s"} found:`);
    for (const f of v.findings) {
      out.push("");
      out.push("  " + wrap(`• ${f.sentence}`, 96, "    "));
      for (const c of f.changes) {
        out.push(
          `      ${c.label}: ${metricValue(c.metric, c.before)} → ${metricValue(c.metric, c.after)}` +
            `  (${shortDate(c.beforeDays[0])}–${shortDate(c.beforeDays[1])} vs ${shortDate(c.afterDays[0])}–${shortDate(c.afterDays[1])})`,
        );
      }
    }
  }
  out.push("");
  out.push("Current baselines (median of the last 7 active days)");
  const metrics = METRICS.filter((m) => v.baselines.some((b) => b.current[m] !== undefined));
  const shortLabel: Record<Metric, string> = {
    tokens_per_request: "tok/req",
    cache_read_share: "cache-read",
    cache_write_per_read: "write/read",
    tokens_per_turn: "tok/turn",
    cache_1h_write_share: "1h writes",
    tokens_per_quota_percent: "tok/1% 5h",
  };
  out.push(
    table(
      ["", "days", "version", ...metrics.map((m) => shortLabel[m])],
      v.baselines.map((b) => [
        `${CLIENT_LABEL[b.client]} · ${b.model}`,
        String(b.activeDays),
        b.version || "—",
        ...metrics.map((m) => (b.current[m] === undefined ? "—" : metricValue(m, b.current[m]!))),
      ]),
    ),
  );
  out.push("");
  out.push(
    wrap(
      `${metrics.map((m) => `${shortLabel[m]} = ${METRIC_LABEL[m]}`).join("; ")}. Tokens count input, output, cache reads and cache writes.`,
      100,
      "",
    ),
  );
  out.push(wrap(`Method: ${v.method}`, 100, ""));
  out.push(...renderSources(v.sources));
  return out.join("\n");
}

/** Word-wrap to `width`, continuation lines indented by `indent`. */
export function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = indent + w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
