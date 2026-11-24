/**
 * What this machine's coding-agent month would cost on each plan in `plans.ts`: the arithmetic
 * behind `seatledger_plan_compare` and the tokens-per-dollar CLI, as data. Local; no request.
 *
 * Every figure is one of three kinds, and says which:
 * - **priced**: published rates times this machine's tokens (the APIs, Codex credits);
 * - **estimate**: published rates times the same tokens, for a tool that keeps no local logs and
 *   would not use exactly these tokens (Copilot);
 * - **measured**: what the vendor's own readings on this machine show (Codex's window percentages
 *   for the plan it was on).
 *
 * A plan whose allowance is not published as a number (Claude Pro, Max and Team; Codex Plus and Pro
 * when this machine has no reading for them) gets no single price. It gets its fee, what is billed
 * past the allowance, and the condition under which the fee alone carries the month: that its
 * allowance holds this machine's busiest 5 hours and busiest week, in API-equivalent dollars.
 */
import type { Loaded } from "./load.js";
import { apiEquivalentUsd, priceKey, PRICE_SOURCES, type PriceSource } from "./prices.js";
import {
  CODEX_CREDIT,
  CODEX_CREDIT_RATES,
  COPILOT_RATES_USD,
  PLAN_CHANGES,
  PLAN_GROUPS,
  PLAN_IDS,
  PLANS,
  planById,
  type Cited,
  type Plan,
  type PlanChange,
  type PlanId,
  type TokenRates,
} from "./plans.js";
import { CLIENT_LABEL, CLIENTS, totalTokens, type Client, type UsageRecord } from "./types.js";

const DAY = 86_400_000;
const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * DAY;
/** The month every cost is stated for. */
export const MONTH_DAYS = 30;

export interface UsageWindow {
  /** ISO time the window opens. */
  start: string;
  /** API-equivalent USD of the requests in it. */
  usd: number;
  requests: number;
}

/** Codex's own rate-limit readings over the period, as Codex wrote them. */
export interface CodexReadings {
  /** The plan Codex named in its latest reading (`plus`, `pro`, …), or null. */
  planType: string | null;
  /** Highest 5-hour window percentage, or null when Codex wrote none (Pro has no 5-hour window). */
  peakFiveHourPercent: number | null;
  peakWeeklyPercent: number | null;
  /** Windows (5-hour or weekly) whose reading reached 100%. */
  windowsAtLimit: number;
  readings: number;
}

export interface Workload {
  client: Client;
  label: string;
  requests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** API-equivalent USD over the period, at seatledger's dated list prices. */
  apiUsd: number;
  /** The same, for a 30-day month (× `period.scale`). */
  monthApiUsd: number;
  /** Requests on models with no list price: counted in tokens, left out of every dollar figure. */
  unpriced: { requests: number; tokens: number; models: string[] };
  busiestFiveHours: UsageWindow | null;
  busiestWeek: UsageWindow | null;
  firstRequest: string | null;
  codexReadings: CodexReadings | null;
}

export type QuoteKind =
  "priced" | "estimate" | "measured" | "measured-at-limit" | "allowance-unpublished";

export interface PlanQuote {
  plan: PlanId;
  name: string;
  vendor: Plan["vendor"];
  /** The work it is priced on: one client, or both on one Copilot plan. */
  carries: Client[];
  /** Fee per seat per month, billed monthly; null for pay-as-you-go. */
  feeUsd: number | null;
  /** A 30-day month like this one on this plan; null when no single figure can be honest. */
  costUsd: number | null;
  /** The least it could cost: the fee, plus anything billed at overage rates from the first token. */
  fromUsd: number;
  kind: QuoteKind;
  /** How the figure was reached, in one sentence. */
  basis: string;
  /** When `costUsd` is null: what would make the fee alone carry the month. */
  condition: string | null;
  /** Requests this plan's rates do not cover, left out of its figure. */
  unpricedRequests: number;
  /** The numbers behind the figure, per 30-day month, where the plan has them. */
  figures: {
    /** Codex credits at the rate card. */
    codexCredits?: number;
    /** Copilot: AI credits used, in USD at $0.01 each, and the plan's included allowance. */
    copilotUsedUsd?: number;
    includedUsd?: number;
    /** Billed at API rates from the first token on this plan (Fable on Pro and Team standard). */
    apiRatesFromStartUsd?: number;
  };
}

export interface Option {
  /** e.g. "Claude Code on Claude Max 5x + Codex on ChatGPT Plus" */
  label: string;
  parts: { plan: PlanId; name: string; carries: Client[]; costUsd: number; kind: QuoteKind }[];
  costUsd: number;
}

export interface CouldBeCheaper {
  plan: PlanId;
  name: string;
  client: Client;
  /** The least `client`'s month could cost on this plan. */
  fromUsd: number;
  condition: string;
}

/** One client's work alone: its cheapest priced plan, the next, and the gap. */
export interface ClientAnswer {
  client: Client;
  cheapest: Option;
  runnerUp: Option | null;
  /** runnerUp − cheapest */
  marginUsd: number | null;
  /** Plans with no single figure whose least cost is below `cheapest`. */
  couldBeCheaper: CouldBeCheaper[];
}

export interface ChangeRef {
  date: string;
  vendor: PlanChange["vendor"];
  plans: readonly PlanId[];
  what: string;
  source: Cited;
  reported: boolean;
}

export interface Answer {
  /** Everything this machine ran, on the cheapest priced plans (one per client, or one for both). */
  cheapest: Option;
  runnerUp: Option | null;
  /** runnerUp − cheapest */
  marginUsd: number | null;
  byClient: ClientAnswer[];
  /**
   * The newest dated change that, undone, changes the cheapest option or its cost, or any
   * client's cheapest plan or runner-up.
   */
  lastMoved: (ChangeRef & { without: Option | null }) | null;
  /** The newest dated change to any plan in the answer, whether or not it can be undone. */
  lastTouched: ChangeRef | null;
}

export interface PlanCompareView {
  view: "plan_compare";
  generatedAt: string;
  period: {
    from: string;
    to: string;
    days: number;
    /** 30 ÷ days: what metered figures are multiplied by to state a 30-day month. */
    scale: number;
  };
  plansCompared: PlanId[];
  workloads: Workload[];
  quotes: PlanQuote[];
  answer: Answer | null;
  /** Announced changes after today to the plans compared. */
  upcoming: ChangeRef[];
  notes: string[];
  codexCredit: { usd: number; derived: boolean; how: string; sources: readonly Cited[] };
  sources: { plans: { plan: PlanId; name: string; seen: string; sources: readonly Cited[] }[] };
  apiPrices: readonly PriceSource[];
}

export interface PlanCompareOptions {
  now: number;
  /** Epoch ms; default 30 days before `now`. */
  since?: number;
  /** Plan ids or group names (`claude`, `codex`, `copilot`); default every plan. */
  plans?: readonly string[];
}

/** Turn ids and group names into plan ids, in table order; throws on an unknown name. */
export function resolvePlans(names: readonly string[] | undefined): PlanId[] {
  if (!names || names.length === 0) return [...PLAN_IDS];
  const want = new Set<PlanId>();
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const group = PLAN_GROUPS[n];
    if (group) group.forEach((id) => want.add(id));
    else if ((PLAN_IDS as readonly string[]).includes(n)) want.add(n as PlanId);
    else
      throw new Error(
        `unknown plan "${raw}"; use ${Object.keys(PLAN_GROUPS).join(", ")} or one of: ${PLAN_IDS.join(", ")}`,
      );
  }
  if (want.size === 0) throw new Error("no plans named");
  return PLAN_IDS.filter((id) => want.has(id));
}

/** One request at a rate table (per million tokens). */
function priceAt(r: UsageRecord, rates: TokenRates): number {
  const prompt = r.input + r.cacheRead + r.cacheWrite;
  const t = rates.long && prompt > rates.long.threshold ? rates.long : rates;
  const write = t.cacheWrite ?? t.input;
  return (
    (r.input * t.input + r.cacheRead * t.cachedInput + r.cacheWrite * write + r.output * t.output) /
    1_000_000
  );
}

/** Codex credits for one request at OpenAI's rate card, or null for a model not on it. */
export function codexCredits(r: UsageRecord): number | null {
  const rates = CODEX_CREDIT_RATES[priceKey(r.model)];
  return rates ? priceAt(r, rates) : null;
}

/** USD at GitHub Copilot's per-token rates for one request, or null for a model it does not list. */
export function copilotUsd(r: UsageRecord): number | null {
  const key = priceKey(r.model);
  const rates = (r.fast ? COPILOT_RATES_USD[`${key}-fast`] : undefined) ?? COPILOT_RATES_USD[key];
  return rates ? priceAt(r, rates) : null;
}

/** Windows that open at a request and last five hours, as the vendors describe their sessions. */
function busiestFiveHours(rs: readonly UsageRecord[]): UsageWindow | null {
  let best: UsageWindow | null = null;
  let start = -Infinity;
  let usd = 0;
  let n = 0;
  const close = () => {
    if (n > 0 && (!best || usd > best.usd))
      best = { start: new Date(start).toISOString(), usd, requests: n };
  };
  for (const r of rs) {
    if (r.ts >= start + FIVE_HOURS) {
      close();
      start = r.ts;
      usd = 0;
      n = 0;
    }
    usd += apiEquivalentUsd(r) ?? 0;
    n += 1;
  }
  close();
  return best;
}

/** The rolling seven days with the most API-equivalent dollars, starting at a request. */
function busiestWeek(rs: readonly UsageRecord[]): UsageWindow | null {
  let best: UsageWindow | null = null;
  let j = 0;
  let usd = 0;
  for (let i = 0; i < rs.length; i++) {
    while (j < rs.length && rs[j]!.ts < rs[i]!.ts + WEEK) usd += apiEquivalentUsd(rs[j++]!) ?? 0;
    if (!best || usd > best.usd)
      best = { start: new Date(rs[i]!.ts).toISOString(), usd, requests: j - i };
    usd -= apiEquivalentUsd(rs[i]!) ?? 0;
  }
  return best;
}

function codexReadings(loaded: Loaded, from: number, now: number): CodexReadings | null {
  const qs = loaded.quota.filter((q) => q.client === "codex" && q.ts >= from && q.ts <= now);
  if (qs.length === 0) return null;
  let five: number | null = null;
  let week: number | null = null;
  const atLimit = new Set<string>();
  for (const q of qs) {
    const isFive = q.slot === "primary" && (q.windowMinutes === null || q.windowMinutes <= 300);
    if (isFive) five = Math.max(five ?? 0, q.usedPercent);
    else week = Math.max(week ?? 0, q.usedPercent);
    if (q.usedPercent >= 100) atLimit.add(`${q.limitId}/${q.slot}@${q.resetsAt ?? q.ts}`);
  }
  const latest = qs.reduce((a, b) => (b.ts >= a.ts ? b : a));
  return {
    planType: latest.planType,
    peakFiveHourPercent: five,
    peakWeeklyPercent: week,
    windowsAtLimit: atLimit.size,
    readings: qs.length,
  };
}

function workload(
  client: Client,
  rs: readonly UsageRecord[],
  scale: number,
  readings: CodexReadings | null,
): Workload {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const unpriced = { requests: 0, tokens: 0, models: new Set<string>() };
  let usd = 0;
  for (const r of rs) {
    tokens.input += r.input;
    tokens.output += r.output;
    tokens.cacheRead += r.cacheRead;
    tokens.cacheWrite += r.cacheWrite;
    tokens.total += totalTokens(r);
    const u = apiEquivalentUsd(r);
    if (u === null) {
      unpriced.requests += 1;
      unpriced.tokens += totalTokens(r);
      unpriced.models.add(r.model);
    } else usd += u;
  }
  return {
    client,
    label: CLIENT_LABEL[client],
    requests: rs.length,
    tokens,
    apiUsd: usd,
    monthApiUsd: usd * scale,
    unpriced: { ...unpriced, models: [...unpriced.models].sort() },
    busiestFiveHours: busiestFiveHours(rs),
    busiestWeek: busiestWeek(rs),
    firstRequest: rs.length ? new Date(rs[0]!.ts).toISOString() : null,
    codexReadings: client === "codex" ? readings : null,
  };
}

const money = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function windowCondition(w: Workload, what: string): string {
  const five = w.busiestFiveHours ? money(w.busiestFiveHours.usd) : "$0.00";
  const week = w.busiestWeek ? money(w.busiestWeek.usd) : "$0.00";
  return `${what} holds this machine's busiest 5 hours (${five} at API list prices) and busiest week (${week})`;
}

function quote(
  plan: Plan,
  carries: Client[],
  byClient: Map<Client, readonly UsageRecord[]>,
  works: Map<Client, Workload>,
  scale: number,
): PlanQuote {
  const rs = carries.flatMap((c) => byClient.get(c) ?? []);
  const base = {
    plan: plan.id,
    name: plan.name,
    vendor: plan.vendor,
    carries,
    feeUsd: plan.usdMonthly,
  };
  const w = works.get(carries[0]!)!;

  if (plan.meter === "api") {
    return {
      ...base,
      costUsd: w.monthApiUsd,
      fromUsd: w.monthApiUsd,
      kind: "priced",
      basis: `every token at ${plan.vendor}'s API list prices`,
      condition: null,
      unpricedRequests: w.unpriced.requests,
      figures: {},
    };
  }

  if (plan.meter === "codex-credits") {
    let credits = 0;
    let missing = 0;
    for (const r of rs) {
      const c = codexCredits(r);
      if (c === null) missing += 1;
      else credits += c;
    }
    const cost = credits * scale * CODEX_CREDIT.usd;
    return {
      ...base,
      costUsd: cost,
      fromUsd: cost,
      kind: "priced",
      basis: `${Math.round(credits * scale).toLocaleString("en-US")} credits at OpenAI's Codex rate card (no separate cache-write charge), at $${CODEX_CREDIT.usd} a credit, derived from OpenAI's own figures`,
      condition: null,
      unpricedRequests: missing,
      figures: { codexCredits: credits * scale },
    };
  }

  if (plan.meter === "copilot-credits") {
    let usd = 0;
    let missing = 0;
    for (const r of rs) {
      const c = copilotUsd(r);
      if (c === null) missing += 1;
      else usd += c;
    }
    const used = usd * scale;
    const included = plan.includedUsd ?? 0;
    const cost = (plan.usdMonthly ?? 0) + Math.max(0, used - included);
    return {
      ...base,
      costUsd: cost,
      fromUsd: cost,
      kind: "estimate",
      basis: `the same tokens at GitHub's per-token rates: ${Math.round(used * 100).toLocaleString("en-US")} AI credits against ${Math.round(included * 100).toLocaleString("en-US")} included, the rest at $0.01 each; Copilot keeps no local logs, and its agent would not use exactly these tokens`,
      condition: null,
      unpricedRequests: missing,
      figures: { copilotUsedUsd: used, includedUsd: included },
    };
  }

  // A flat fee with an allowance nobody publishes as a number.
  const fee = plan.usdMonthly ?? 0;
  let extra = 0;
  if (plan.overageOnlyModels?.length) {
    for (const r of rs)
      if (plan.overageOnlyModels.some((m) => priceKey(r.model).startsWith(m)))
        extra += (apiEquivalentUsd(r) ?? 0) * scale;
  }
  const from = fee + extra;
  const extraNote =
    extra > 0
      ? ` ${money(extra)} of this month is on Fable models, which this plan bills at API rates from the first token.`
      : "";

  if (plan.vendor === "Anthropic") {
    const multiple =
      plan.timesPro === 1
        ? "Anthropic publishes no number for it"
        : `Anthropic publishes it only as ${plan.timesPro} times Pro's per-session allowance`;
    return {
      ...base,
      costUsd: null,
      fromUsd: from,
      kind: "allowance-unpublished",
      basis: `${money(fee)} a seat${plan.minSeats ? ` (at least ${plan.minSeats} seats)` : ""}; past its allowance, extra usage at API rates; ${multiple}.${extraNote}`,
      condition: windowCondition(w, `the fee alone carries the month if its allowance`),
      unpricedRequests: w.unpriced.requests,
      figures: extra > 0 ? { apiRatesFromStartUsd: extra } : {},
    };
  }

  // Codex Plus or Pro: Codex writes the plan's own window percentages to disk.
  const rd = w.codexReadings;
  const mine = rd && rd.planType === plan.codexPlanType ? rd : null;
  const tiers = plan.priceNote ? ` (${plan.priceNote})` : "";
  if (mine && mine.windowsAtLimit === 0) {
    const five =
      mine.peakFiveHourPercent === null
        ? ""
        : `busiest 5-hour window ${Math.round(mine.peakFiveHourPercent)}%, `;
    const week =
      mine.peakWeeklyPercent === null
        ? "no weekly reading"
        : `busiest week ${Math.round(mine.peakWeeklyPercent)}%`;
    const single = plan.id === "chatgpt-plus";
    return {
      ...base,
      costUsd: single ? fee : null,
      fromUsd: fee,
      kind: "measured",
      basis: `Codex's own readings on this machine, on ${plan.name}: ${five}${week} of the limit, never 100%${single ? "" : `; ${plan.name} has tiers${tiers}, and the readings do not say which`}.`,
      condition: single ? null : `the fee alone carried the month on your ${plan.name} tier`,
      unpricedRequests: 0,
      figures: {},
    };
  }
  if (mine) {
    return {
      ...base,
      costUsd: null,
      fromUsd: fee,
      kind: "measured-at-limit",
      basis: `Codex's own readings on this machine, on ${plan.name}: ${mine.windowsAtLimit} window${mine.windowsAtLimit === 1 ? "" : "s"} reached 100% of the limit; past it, credits at the rate card${tiers}.`,
      condition: `the fee alone did not carry the month: work past the limit needs credits, which the readings do not size`,
      unpricedRequests: 0,
      figures: {},
    };
  }
  return {
    ...base,
    costUsd: null,
    fromUsd: fee,
    kind: "allowance-unpublished",
    basis: `${money(fee)} a month${tiers}; ${plan.allowance}.`,
    condition: windowCondition(w, `the fee alone carries the month if its limit`),
    unpricedRequests: 0,
    figures: {},
  };
}

const known = (q: PlanQuote): q is PlanQuote & { costUsd: number } => q.costUsd !== null;

function bestOptions(quotes: readonly PlanQuote[], clients: readonly Client[]): Option[] {
  const single = (c: Client) =>
    quotes.filter((q) => known(q) && q.carries.length === 1 && q.carries[0] === c) as (PlanQuote & {
      costUsd: number;
    })[];
  const part = (q: PlanQuote & { costUsd: number }) => ({
    plan: q.plan,
    name: q.name,
    carries: q.carries,
    costUsd: q.costUsd,
    kind: q.kind,
  });
  const out: Option[] = [];
  if (clients.length === 1) {
    for (const q of single(clients[0]!))
      out.push({ label: q.name, parts: [part(q)], costUsd: q.costUsd });
  } else {
    const [a, b] = clients as [Client, Client];
    for (const qa of single(a))
      for (const qb of single(b)) {
        // one Copilot subscription carries both; that is the combined quote below
        if (qa.vendor === "GitHub" && qb.vendor === "GitHub") continue;
        out.push({
          label: `${CLIENT_LABEL[a]} on ${qa.name} + ${CLIENT_LABEL[b]} on ${qb.name}`,
          parts: [part(qa), part(qb)],
          costUsd: qa.costUsd + qb.costUsd,
        });
      }
    for (const q of quotes.filter((x) => known(x) && x.carries.length === 2) as (PlanQuote & {
      costUsd: number;
    })[])
      out.push({ label: `both on ${q.name}`, parts: [part(q)], costUsd: q.costUsd });
  }
  return out.sort((x, y) => x.costUsd - y.costUsd || x.label.localeCompare(y.label));
}

const cents = (n: number) => Math.round(n * 100);

function changeRef(c: PlanChange): ChangeRef {
  return {
    date: c.date,
    vendor: c.vendor,
    plans: c.plans,
    what: c.what,
    source: c.source,
    reported: c.reported === true,
  };
}

function clientAnswer(quotes: readonly PlanQuote[], client: Client): ClientAnswer | null {
  const options = bestOptions(quotes, [client]);
  const cheapest = options[0];
  if (!cheapest) return null;
  // The alternative a buyer would weigh: the cheapest priced plan from another vendor, else the next.
  const vendorOf = (o: Option) => planById(o.parts[0]!.plan).vendor;
  const runnerUp =
    options.slice(1).find((o) => vendorOf(o) !== vendorOf(cheapest)) ?? options[1] ?? null;
  const couldBeCheaper: CouldBeCheaper[] = quotes
    .filter(
      (q) =>
        q.costUsd === null &&
        q.condition !== null &&
        q.kind !== "measured-at-limit" &&
        q.carries.length === 1 &&
        q.carries[0] === client &&
        cents(q.fromUsd) < cents(cheapest.costUsd),
    )
    .map((q) => ({
      plan: q.plan,
      name: q.name,
      client,
      fromUsd: q.fromUsd,
      condition: q.condition!,
    }))
    .sort((a, b) => a.fromUsd - b.fromUsd || a.name.localeCompare(b.name));
  return {
    client,
    cheapest,
    runnerUp,
    marginUsd: runnerUp ? runnerUp.costUsd - cheapest.costUsd : null,
    couldBeCheaper,
  };
}

/** The labels and cents that, if any of them changed, mean the answer moved. */
function fingerprint(quotes: readonly PlanQuote[], clients: readonly Client[]): string {
  const all = bestOptions(quotes, clients)[0];
  const per = clients.map((c) => {
    const o = bestOptions(quotes, [c]);
    return `${o[0]?.label ?? "-"}/${o[1]?.label ?? "-"}`;
  });
  return [all?.label ?? "-", cents(all?.costUsd ?? -1), ...per].join("|");
}

function answerFrom(
  quotes: readonly PlanQuote[],
  clients: readonly Client[],
  today: string,
): Answer | null {
  const options = bestOptions(quotes, clients);
  const cheapest = options[0];
  if (!cheapest) return null;
  const runnerUp = options[1] ?? null;
  const byClient = clients
    .map((c) => clientAnswer(quotes, c))
    .filter((a): a is ClientAnswer => a !== null);

  const inAnswer = new Set<PlanId>([
    ...cheapest.parts.map((p) => p.plan),
    ...byClient.flatMap((a) => [
      ...a.cheapest.parts.map((p) => p.plan),
      ...(a.runnerUp?.parts.map((p) => p.plan) ?? []),
      ...a.couldBeCheaper.map((c) => c.plan),
    ]),
  ]);
  const past = PLAN_CHANGES.filter((c) => c.date <= today && c.priced).reverse();

  const current = fingerprint(quotes, clients);
  let lastMoved: Answer["lastMoved"] = null;
  for (const c of past) {
    if (!c.introduced?.length) continue;
    const before = quotes.filter((q) => !c.introduced!.includes(q.plan));
    if (fingerprint(before, clients) !== current) {
      lastMoved = { ...changeRef(c), without: bestOptions(before, clients)[0] ?? null };
      break;
    }
  }
  const touched = past.find((c) => c.plans.some((p) => inAnswer.has(p)));
  return {
    cheapest,
    runnerUp,
    marginUsd: runnerUp ? runnerUp.costUsd - cheapest.costUsd : null,
    byClient,
    lastMoved,
    lastTouched: touched ? changeRef(touched) : null,
  };
}

const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Price this machine's month on every plan asked for. */
export function planCompare(loaded: Loaded, opts: PlanCompareOptions): PlanCompareView {
  const now = opts.now;
  const from = opts.since ?? now - MONTH_DAYS * DAY;
  const days = Math.max((now - from) / DAY, 1 / 24);
  const scale = MONTH_DAYS / days;
  const ids = resolvePlans(opts.plans);
  const plans = PLANS.filter((p) => ids.includes(p.id));

  const inRange = loaded.requests.filter((r) => r.ts >= from && r.ts <= now);
  const byClient = new Map<Client, readonly UsageRecord[]>(
    CLIENTS.map((c) => [c, inRange.filter((r) => r.client === c)]),
  );
  const readings = codexReadings(loaded, from, now);
  const clients = CLIENTS.filter((c) => (byClient.get(c)?.length ?? 0) > 0);
  const works = new Map<Client, Workload>(
    clients.map((c) => [c, workload(c, byClient.get(c)!, scale, readings)]),
  );

  const quotes: PlanQuote[] = [];
  for (const plan of plans) {
    const mine = plan.carries.filter((c) => works.has(c));
    for (const c of mine) quotes.push(quote(plan, [c], byClient, works, scale));
    if (mine.length === 2) quotes.push(quote(plan, mine, byClient, works, scale));
  }

  const today = isoDay(now);
  const answer = answerFrom(quotes, clients, today);
  const upcoming = PLAN_CHANGES.filter(
    (c) => c.date > today && c.plans.some((p) => quotes.some((q) => q.plan === p)),
  ).map(changeRef);

  const notes: string[] = [];
  if (Math.abs(scale - 1) > 0.02)
    notes.push(
      `Metered figures are scaled from ${days.toFixed(1)} days to a ${MONTH_DAYS}-day month; flat fees are not.`,
    );
  for (const w of works.values()) {
    const first = w.firstRequest ? Date.parse(w.firstRequest) : from;
    if (first - from > 2 * DAY)
      notes.push(
        `${w.label} history on this machine starts ${isoDay(first)}, after the period starts; days before it count as no use.`,
      );
    if (w.unpriced.requests > 0)
      notes.push(
        `${w.unpriced.requests.toLocaleString("en-US")} ${w.label} requests on models with no list price (${w.unpriced.models.join(", ")}) are left out of every dollar figure.`,
      );
  }
  if (readings)
    notes.push(
      "Codex's readings are account-wide: Codex use on other machines and in the cloud counts in them.",
    );

  return {
    view: "plan_compare",
    generatedAt: new Date(now).toISOString(),
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days, scale },
    plansCompared: ids,
    workloads: [...works.values()],
    quotes,
    answer,
    upcoming,
    notes,
    codexCredit: {
      usd: CODEX_CREDIT.usd,
      derived: CODEX_CREDIT.derived,
      how: CODEX_CREDIT.how,
      sources: CODEX_CREDIT.sources,
    },
    sources: {
      plans: plans.map((p) => ({ plan: p.id, name: p.name, seen: p.seen, sources: p.sources })),
    },
    apiPrices: PRICE_SOURCES,
  };
}
