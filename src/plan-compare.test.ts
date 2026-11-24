import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { load, type Loaded } from "./load.js";
import {
  codexCredits,
  copilotUsd,
  planCompare,
  resolvePlans,
  type PlanCompareView,
} from "./plan-compare.js";
import {
  CODEX_CREDIT,
  CODEX_CREDIT_RATES,
  COPILOT_RATES_USD,
  PLAN_CHANGES,
  PLAN_GROUPS,
  PLAN_IDS,
  PLANS,
} from "./plans.js";
import { apiEquivalentUsd, priceFor, priceKey } from "./prices.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";
import type { QuotaSample, UsageRecord } from "./types.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T16:00:00Z");

function req(over: Partial<UsageRecord> & Pick<UsageRecord, "client" | "model">): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    ts: NOW - DAY,
    version: "1.0.0",
    project: "p",
    session: "s",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: null,
    fast: false,
    geoUs: false,
    ...over,
  };
}

const loaded = (requests: UsageRecord[], quota: QuotaSample[] = []): Loaded => ({
  requests: [...requests].sort((a, b) => a.ts - b.ts),
  quota,
  sources: [],
  since: undefined,
});

describe("the plan table", () => {
  it("every plan is dated and sourced from the vendor's own https pages", () => {
    expect(PLANS.map((p) => p.id)).toEqual([...PLAN_IDS]);
    for (const p of PLANS) {
      expect(p.seen).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) {
        expect(s.url).toMatch(/^https:\/\//);
        expect(s.seen <= p.seen).toBe(true);
      }
      expect(p.seen).toBe(
        [...p.sources]
          .map((s) => s.seen)
          .sort()
          .at(-1),
      );
      if (p.meter === "api" || p.meter === "codex-credits") expect(p.usdMonthly).toBeNull();
      else expect(p.usdMonthly).toBeGreaterThan(0);
    }
  });

  it("holds the published prices and multiples (read 8 Oct 2026)", () => {
    const price = Object.fromEntries(PLANS.map((p) => [p.id, p.usdMonthly]));
    expect(price).toMatchObject({
      "claude-pro": 20,
      "claude-max-5x": 100,
      "claude-max-20x": 200,
      "claude-team-standard": 25,
      "claude-team-premium": 125,
      "chatgpt-plus": 20,
      "chatgpt-pro": 100,
      "copilot-pro": 10,
      "copilot-pro-plus": 39,
      "copilot-max": 100,
    });
    const times = Object.fromEntries(PLANS.map((p) => [p.id, p.timesPro]));
    expect(times).toMatchObject({
      "claude-pro": 1,
      "claude-max-5x": 5,
      "claude-max-20x": 20,
      "claude-team-standard": 1.25,
      "claude-team-premium": 6.25,
    });
    const included = Object.fromEntries(PLANS.map((p) => [p.id, [p.includedUsd, p.flexUsd]]));
    expect(included).toMatchObject({
      "copilot-pro": [15, 5],
      "copilot-pro-plus": [70, 31],
      "copilot-max": [200, 100],
    });
  });

  it("groups name only real plans, and every plan is in exactly one group", () => {
    const all = Object.values(PLAN_GROUPS).flat();
    expect([...all].sort()).toEqual([...PLAN_IDS].sort());
  });

  it("changes are dated, sourced, oldest first, and say what changed, not why", () => {
    const dates = PLAN_CHANGES.map((c) => c.date);
    expect(dates).toEqual([...dates].sort());
    for (const c of PLAN_CHANGES) {
      expect(c.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(c.source.url).toMatch(/^https:\/\//);
      for (const p of [...c.plans, ...(c.introduced ?? [])]) expect(PLAN_IDS).toContain(p);
      for (const p of c.introduced ?? []) expect(c.plans).toContain(p);
      expect(c.what).not.toMatch(
        /\b(to cut costs|to save|deliberately|secretly|quietly|stealth|nerf|in order to|because)\b/i,
      );
    }
  });

  it("the derived $0.04 a credit turns every rate-card row OpenAI also lists on its API into that API price", () => {
    let checked = 0;
    for (const [model, rates] of Object.entries(CODEX_CREDIT_RATES)) {
      const api = priceFor(model);
      if (!api) continue;
      checked += 1;
      expect(rates.input * CODEX_CREDIT.usd, model).toBeCloseTo(api.input, 6);
      expect(rates.cachedInput * CODEX_CREDIT.usd, model).toBeCloseTo(api.cacheRead, 6);
      expect(rates.output * CODEX_CREDIT.usd, model).toBeCloseTo(api.output, 6);
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(CODEX_CREDIT.derived).toBe(true);
  });

  it("rate-table keys are seatledger model keys", () => {
    for (const k of [...Object.keys(CODEX_CREDIT_RATES), ...Object.keys(COPILOT_RATES_USD)])
      expect(priceKey(k)).toBe(k);
  });
});

describe("rates", () => {
  it("Codex credits: cache writes count as input, cache reads at the cached rate", () => {
    const r = req({
      client: "codex",
      model: "gpt-6.1-sol",
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 2_000_000,
      output: 100_000,
    });
    // (1M + 1M) × 50 + 2M × 2.5 + 0.1M × 250
    expect(codexCredits(r)).toBeCloseTo(100 + 5 + 25, 9);
    expect(codexCredits(req({ client: "codex", model: "codex-auto-review", input: 5 }))).toBeNull();
  });

  it("Copilot: one cache-write price, long-context rows above the threshold, the fast row where listed", () => {
    const opus = req({
      client: "claude-code",
      model: "claude-opus-5-5-20260101",
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });
    expect(copilotUsd(opus)).toBeCloseTo(4 + 5 + 0.2 + 20, 9);
    const short = req({ client: "codex", model: "gpt-6-sol", input: 272_000, output: 1_000_000 });
    const long = req({ client: "codex", model: "gpt-6-sol", input: 272_001, output: 1_000_000 });
    expect(copilotUsd(short)).toBeCloseTo(0.272 * 2 + 10, 9);
    expect(copilotUsd(long)).toBeCloseTo(0.272001 * 4 + 15, 9);
    const fast = req({ client: "claude-code", model: "claude-opus-4-8", input: 1e6, fast: true });
    expect(copilotUsd(fast)).toBeCloseTo(10, 9);
    expect(copilotUsd(req({ client: "claude-code", model: "claude-3-5-haiku", input: 1 }))).toBe(
      null,
    );
  });
});

describe("resolvePlans", () => {
  it("takes ids and group names, in table order, and refuses anything else", () => {
    expect(resolvePlans(undefined)).toEqual([...PLAN_IDS]);
    expect(resolvePlans(["copilot-max", "claude"])).toEqual([
      ...PLAN_GROUPS.claude!,
      "copilot-max",
    ]);
    expect(() => resolvePlans(["claude-ultra"])).toThrow(/unknown plan "claude-ultra"/);
  });
});

describe("planCompare on hand-made history", () => {
  const opus = (usd: number, ts = NOW - DAY) =>
    // claude-opus-5-5 output at $20 per million
    req({ client: "claude-code", model: "claude-opus-5-5", output: (usd / 20) * 1e6, ts });

  it("the API is list price; a Claude plan gets its fee and a condition, never a single figure", () => {
    const v = planCompare(loaded([opus(150, NOW - 3 * DAY), opus(50)]), {
      now: NOW,
      plans: ["claude"],
    });
    const api = v.quotes.find((q) => q.plan === "anthropic-api")!;
    expect(api.kind).toBe("priced");
    expect(api.costUsd).toBeCloseTo(200, 6);
    const max = v.quotes.find((q) => q.plan === "claude-max-5x")!;
    expect(max).toMatchObject({ costUsd: null, fromUsd: 100, kind: "allowance-unpublished" });
    expect(max.basis).toContain("5 times Pro's per-session allowance");
    expect(max.basis).toContain("extra usage at API rates");
    expect(max.condition).toContain("busiest 5 hours ($150.00 at API list prices)");
    expect(max.condition).toContain("busiest week ($200.00)");
    const team = v.quotes.find((q) => q.plan === "claude-team-standard")!;
    expect(team.basis).toContain("at least 2 seats");
    // the API is the only priced Claude option; every plan under $200 could be cheaper
    expect(v.answer!.cheapest.label).toBe("Anthropic API");
    expect(v.answer!.byClient[0]!.couldBeCheaper.map((c) => c.plan)).toEqual([
      "claude-pro",
      "claude-team-standard",
      "claude-max-5x",
      "claude-team-premium",
    ]);
  });

  it("Pro and Team standard bill Fable at API rates from the first token", () => {
    const fable = req({ client: "claude-code", model: "claude-fable-5-1", output: 1e6 }); // $50
    const v = planCompare(loaded([fable, opus(10)]), { now: NOW, plans: ["claude"] });
    const from = Object.fromEntries(v.quotes.map((q) => [q.plan, q.fromUsd]));
    expect(from["claude-pro"]).toBeCloseTo(70, 6);
    expect(from["claude-team-standard"]).toBeCloseTo(75, 6);
    expect(from["claude-max-5x"]).toBe(100);
  });

  it("scales metered figures to a 30-day month, never flat fees", () => {
    const v = planCompare(loaded([opus(30)]), {
      now: NOW,
      since: NOW - 10 * DAY,
      plans: ["anthropic-api", "claude-pro"],
    });
    expect(v.period.scale).toBeCloseTo(3, 9);
    expect(v.quotes.find((q) => q.plan === "anthropic-api")!.costUsd).toBeCloseTo(90, 6);
    expect(v.quotes.find((q) => q.plan === "claude-pro")!.fromUsd).toBe(20);
    expect(v.notes.join(" ")).toMatch(/scaled from 10\.0 days to a 30-day month/);
  });

  it("Copilot: fee plus credits past the included ones, labelled an estimate, one plan for both clients", () => {
    const gpt = req({ client: "codex", model: "gpt-6.1-sol", output: 3e6 }); // $30 at Copilot
    const v = planCompare(loaded([opus(250), gpt]), { now: NOW, plans: ["copilot"] });
    const q = (plan: string, n: number) =>
      v.quotes.find((x) => x.plan === plan && x.carries.length === n)!;
    expect(q("copilot-max", 1).costUsd).toBeCloseTo(100 + 50, 6);
    expect(q("copilot-max", 2).costUsd).toBeCloseTo(100 + 80, 6);
    expect(q("copilot-pro", 2).costUsd).toBeCloseTo(10 + 280 - 15, 6);
    for (const x of v.quotes) {
      expect(x.kind).toBe("estimate");
      expect(x.basis).toContain("Copilot keeps no local logs");
    }
    // one subscription carries both; two Copilot plans at once is never offered
    expect(v.answer!.cheapest.label).toBe("both on Copilot Max");
  });

  it("Codex Plus measured from Codex's own readings: carried, or at the limit", () => {
    const reading = (usedPercent: number, slot: "primary" | "secondary"): QuotaSample => ({
      client: "codex",
      ts: NOW - DAY,
      limitId: "codex",
      slot,
      windowMinutes: slot === "primary" ? 300 : 10080,
      usedPercent,
      resetsAt: NOW,
      planType: "plus",
    });
    const gpt = req({ client: "codex", model: "gpt-6.1-sol", output: 3e6 }); // $30 on credits
    const ok = planCompare(loaded([gpt], [reading(64, "primary"), reading(31, "secondary")]), {
      now: NOW,
      plans: ["codex"],
    });
    const plus = ok.quotes.find((q) => q.plan === "chatgpt-plus")!;
    expect(plus).toMatchObject({ kind: "measured", costUsd: 20 });
    expect(plus.basis).toContain("busiest 5-hour window 64%, busiest week 31%");
    expect(ok.quotes.find((q) => q.plan === "chatgpt-pro")!.kind).toBe("allowance-unpublished");
    expect(ok.answer!.cheapest.label).toBe("ChatGPT Plus");

    const hit = planCompare(loaded([gpt], [reading(100, "primary")]), {
      now: NOW,
      plans: ["codex"],
    });
    const atLimit = hit.quotes.find((q) => q.plan === "chatgpt-plus")!;
    expect(atLimit).toMatchObject({ kind: "measured-at-limit", costUsd: null });
    expect(hit.answer!.byClient[0]!.couldBeCheaper.map((c) => c.plan)).not.toContain(
      "chatgpt-plus",
    );
  });

  it("no requests in range: no workloads and no answer", () => {
    const v = planCompare(loaded([opus(10, NOW - 60 * DAY)]), { now: NOW });
    expect(v.workloads).toEqual([]);
    expect(v.answer).toBeNull();
  });
});

describe("the last change that moved the answer", () => {
  it("is the newest change that, undone, changes it; limit changes only touch it", () => {
    const opus = req({ client: "claude-code", model: "claude-opus-5-5", output: 10e6 }); // $200
    const v = planCompare(loaded([opus]), { now: NOW });
    // Copilot Max: $100 + ($200 − $200 included) = $100, cheaper than the API's $200
    expect(v.answer!.cheapest.label).toBe("Copilot Max");
    expect(v.answer!.lastMoved).toMatchObject({ date: "2026-06-01", vendor: "GitHub" });
    expect(v.answer!.lastMoved!.without!.label).toBe("Anthropic API");
    // Pro, Team standard and Max 5x could be cheaper; the weekly-limit change touches them
    expect(v.answer!.lastTouched).toMatchObject({ date: "2026-09-14", vendor: "Anthropic" });
  });

  it("is null when no undoable change moved it, and announced changes are listed apart", () => {
    const opus = req({ client: "claude-code", model: "claude-opus-5-5", output: 1e6 });
    const v = planCompare(loaded([opus]), { now: NOW, plans: ["anthropic-api", "claude-pro"] });
    expect(v.answer!.cheapest.label).toBe("Anthropic API");
    expect(v.answer!.lastMoved).toBeNull();
    const codex = planCompare(loaded([req({ client: "codex", model: "gpt-6-sol", output: 1 })]), {
      now: NOW,
    });
    expect(codex.upcoming.map((c) => c.date)).toEqual(["2026-10-14"]);
  });
});

describe("planCompare on seatledger's synthetic history", () => {
  let root: string;
  let synth: SyntheticResult;
  let view: PlanCompareView;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "seatledger-plans-"));
    synth = writeSyntheticHistory({ dir: path.join(root, "src") });
    const l = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home: path.join(root, "home"),
    });
    view = planCompare(l, { now: synth.now });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("prices both clients over the last 30 days, and the API figure is seatledger's own", async () => {
    expect(view.workloads.map((w) => w.client)).toEqual(["claude-code", "codex"]);
    expect(view.period.days).toBe(30);
    for (const w of view.workloads) {
      expect(w.requests).toBeGreaterThan(100);
      expect(w.monthApiUsd).toBeCloseTo(w.apiUsd, 9);
      expect(w.busiestFiveHours!.usd).toBeLessThanOrEqual(w.busiestWeek!.usd);
    }
    const l = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home: path.join(root, "home2"),
      since: synth.now - 30 * DAY,
    });
    const claude = l.requests.filter((r) => r.client === "claude-code");
    const sum = claude.reduce((n, r) => n + (apiEquivalentUsd(r) ?? 0), 0);
    expect(view.quotes.find((q) => q.plan === "anthropic-api")!.costUsd).toBeCloseTo(sum, 6);
  });

  it("reads the synthetic Codex history as Plus, never at its limit", () => {
    const codex = view.workloads.find((w) => w.client === "codex")!;
    expect(codex.codexReadings).toMatchObject({ planType: "plus", windowsAtLimit: 0 });
    expect(view.quotes.find((q) => q.plan === "chatgpt-plus")!.kind).toBe("measured");
  });

  it("answers per client, and cites its sources", () => {
    const a = view.answer!;
    expect(a.byClient.map((c) => c.client)).toEqual(["claude-code", "codex"]);
    for (const c of a.byClient) {
      expect(c.runnerUp).not.toBeNull();
      expect(c.marginUsd).toBeGreaterThan(0);
    }
    expect(view.sources.plans.map((p) => p.plan)).toEqual([...PLAN_IDS]);
    expect(view.codexCredit.derived).toBe(true);
    expect(view.apiPrices.length).toBe(2);
  });
});
