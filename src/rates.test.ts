import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { load } from "./load.js";
import { detectSteps, movement, type DayPoint } from "./rates.js";
import { writeSyntheticHistory } from "./synthetic.js";
import { ratesView } from "./views.js";

const root = mkdtempSync(path.join(tmpdir(), "seatledger-rates-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function history(name: string, step: boolean, seed = 7) {
  const synth = writeSyntheticHistory({
    dir: path.join(root, name),
    seed,
    ...(step ? {} : { step: false, codexStep: false }),
  });
  const loaded = await load({
    dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
    cache: false,
    home: path.join(root, name, "home"),
  });
  return ratesView(loaded, synth.now, undefined);
}

describe("rate-change detector on synthetic histories", () => {
  it("finds the known step: Claude Code 2.1.230 moves cache writes to the 5-minute lifetime on 30 Sep", async () => {
    const v = await history("step", true);
    const claude = v.findings.filter((f) => f.client === "claude-code");
    expect(claude).toHaveLength(1);
    const f = claude[0]!;
    expect(f).toMatchObject({
      model: "claude-opus-5-5",
      date: "2026-09-30",
      version: "2.1.230",
      previousVersion: "2.1.229",
      versionChanged: true,
    });
    const metrics = f.changes.map((c) => c.metric).sort();
    expect(metrics).toEqual(["cache_1h_write_share", "cache_read_share", "cache_write_per_read"]);
    expect(f.cacheReadsPerRequest[1]).toBeLessThan(f.cacheReadsPerRequest[0] * 0.75);
    expect(f.cacheWritesPerRequest[1]).toBeGreaterThan(f.cacheWritesPerRequest[0] * 2);
    expect(f.sentence).toMatch(
      /^From 30 Sep \(Claude Code 2\.1\.230, the first day on it\), cache reads per request fell \d+%/,
    );
    expect(f.sentence).toContain("from the 1-hour to the 5-minute cache lifetime");
  });

  it("finds Codex's quota step: from 0.159.0 the same tokens use twice the 5-hour window", async () => {
    const v = await history("step", true);
    const codex = v.findings.filter((f) => f.client === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({
      model: "all models",
      date: "2026-09-22",
      version: "0.159.0",
      versionChanged: true,
    });
    expect(codex[0]!.changes[0]).toMatchObject({ metric: "tokens_per_quota_percent" });
    expect(codex[0]!.changes[0]!.change).toBeCloseTo(0.5, 1);
    expect(codex[0]!.sentence).toContain("consistent with a smaller allowance per token");
  });

  it("stays quiet on the same history with no change in it, across seeds", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const v = await history(`flat-${seed}`, false, seed);
      expect(v.findings, `seed ${seed}`).toEqual([]);
      expect(v.baselines.length).toBeGreaterThan(0);
    }
  });

  it("never names a cause: every finding says what it is consistent with or what the transcript shows", async () => {
    const v = await history("step", true);
    for (const f of v.findings)
      expect(f.consistentWith).toMatch(/consistent with|the transcript itself shows/);
  });
});

const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}`;
const series = (values: number[]): DayPoint[] =>
  values.map((v, i) => ({
    day: day(i),
    requests: 100,
    turns: 10,
    version: "1",
    values: { tokens_per_request: v },
    cacheReadsPerRequest: 0,
    cacheWritesPerRequest: 0,
  }));

describe("detectSteps", () => {
  it("dates a clean step to its first day", () => {
    const steps = detectSteps(
      series([100, 102, 98, 101, 99, 100, 150, 152, 149, 151, 148]),
      "tokens_per_request",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ date: day(6), before: 100, after: 150 });
  });

  it("ignores day-to-day wobble, however large, without a step", () => {
    const noisy = [100, 140, 80, 120, 95, 135, 85, 125, 90, 130, 88, 128];
    expect(detectSteps(series(noisy), "tokens_per_request")).toEqual([]);
  });

  it("ignores a change smaller than 30%", () => {
    expect(
      detectSteps(series([100, 100, 101, 99, 100, 120, 121, 119, 120, 120]), "tokens_per_request"),
    ).toEqual([]);
  });

  it("needs three days on each side", () => {
    expect(
      detectSteps(series([100, 100, 100, 100, 100, 100, 200, 200]), "tokens_per_request"),
    ).toEqual([]);
    expect(
      detectSteps(series([100, 100, 100, 100, 100, 100, 200, 200, 200]), "tokens_per_request"),
    ).toHaveLength(1);
  });

  it("finds two steps, measuring the second against what came after the first", () => {
    const v = [100, 101, 99, 100, 100, 200, 202, 198, 200, 201, 400, 405, 398, 402];
    expect(detectSteps(series(v), "tokens_per_request").map((s) => s.date)).toEqual([
      day(5),
      day(10),
    ]);
  });
});

describe("movement", () => {
  it("reads like a person would say it", () => {
    expect(movement(2)).toBe("doubled");
    expect(movement(0.5)).toBe("halved");
    expect(movement(0.59)).toBe("fell 41%");
    expect(movement(1.22)).toBe("rose 22%");
    expect(movement(6.8)).toBe("rose 6.8x");
  });
});
