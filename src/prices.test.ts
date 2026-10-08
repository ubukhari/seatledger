import { describe, expect, it } from "vitest";
import { apiEquivalentUsd, priceFor, priceKey, pricedModels, PRICE_SOURCES } from "./prices.js";
import type { UsageRecord } from "./types.js";

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  client: "claude-code",
  id: "x",
  ts: 0,
  model: "claude-opus-5-5",
  version: "",
  project: "",
  session: "",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: null,
  fast: false,
  geoUs: false,
  ...over,
});

describe("price table", () => {
  it("is dated and sourced", () => {
    for (const s of PRICE_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.read).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every Anthropic row follows the published cache multipliers (catches a mistyped price)", () => {
    for (const key of pricedModels()) {
      const p = priceFor(key)!;
      if (p.provider !== "Anthropic") continue;
      expect(p.cacheWrite, key).toBeCloseTo(p.input * 1.25, 6);
      expect(p.cacheWrite1h, key).toBeCloseTo(p.input * 2, 6);
      // 0.1x, except 0.05x on Opus 5.5 and 0.025x on Fable/Mythos 5.1
      expect(
        [0.1, 0.05, 0.025].some((m) => Math.abs(p.cacheRead - p.input * m) < 1e-9),
        key,
      ).toBe(true);
    }
  });

  it("names the same list price for dated, cloud and context-suffixed model ids", () => {
    expect(priceKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(priceKey("us.anthropic.claude-opus-4-8-v1:0")).toBe("claude-opus-4-8");
    expect(priceKey("claude-sonnet-4-5@20250929")).toBe("claude-sonnet-4-5");
    expect(priceKey("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(priceKey("claude-opus-4-0")).toBe("claude-opus-4");
    expect(priceFor("gpt-5.6-sol")?.provider).toBe("OpenAI");
    expect(priceFor("codex-auto-review")).toBeUndefined();
    expect(priceFor("<synthetic>")).toBeUndefined();
  });
});

describe("apiEquivalentUsd", () => {
  it("prices each token category, splitting cache writes by lifetime", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 read, $5 5m write, $8 1h write per MTok
    const usd = apiEquivalentUsd(
      rec({
        input: 1_000_000,
        output: 100_000,
        cacheRead: 10_000_000,
        cacheWrite: 300_000,
        cacheWrite1h: 100_000,
      }),
    );
    expect(usd).toBeCloseTo(4 + 2 + 2 + 0.2 * 5 + 0.1 * 8, 9);
  });

  it("prices writes with no recorded lifetime at the 5-minute rate", () => {
    expect(apiEquivalentUsd(rec({ cacheWrite: 1_000_000 }))).toBeCloseTo(5, 9);
  });

  it("applies fast mode with the caching multipliers on top, and 1.1x for US-only inference", () => {
    // fast Opus 5.5: $8 in, $40 out; a 5m write is 1.25x the fast input price
    expect(
      apiEquivalentUsd(
        rec({ fast: true, input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000 }),
      ),
    ).toBeCloseTo(8 + 40 + 10, 9);
    expect(apiEquivalentUsd(rec({ geoUs: true, input: 1_000_000 }))).toBeCloseTo(4.4, 9);
  });

  it("uses OpenAI's long-context prices above 272K prompt tokens", () => {
    const short = rec({
      client: "codex",
      model: "gpt-5.6-sol",
      input: 100_000,
      cacheRead: 100_000,
      output: 10_000,
    });
    expect(apiEquivalentUsd(short)).toBeCloseTo(0.4 + 0.04 + 0.2, 9);
    const long = rec({
      client: "codex",
      model: "gpt-5.6-sol",
      input: 100_000,
      cacheRead: 200_000,
      output: 10_000,
    });
    expect(apiEquivalentUsd(long)).toBeCloseTo(0.8 + 0.16 + 0.3, 9);
  });

  it("bills OpenAI cache writes as input where the model has no write price", () => {
    expect(
      apiEquivalentUsd(rec({ client: "codex", model: "gpt-5.5", cacheWrite: 200_000 })),
    ).toBeCloseTo(1, 9);
  });

  it("returns null, not a guess, for a model without a list price", () => {
    expect(apiEquivalentUsd(rec({ model: "codex-auto-review", input: 5 }))).toBeNull();
  });
});
