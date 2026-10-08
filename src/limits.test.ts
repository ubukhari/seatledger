import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clearLimits,
  fiveHourWindows,
  limitStatus,
  readLimits,
  setLimit,
  vendorReadings,
  type Limit,
} from "./limits.js";
import type { QuotaSample, UsageRecord } from "./types.js";

const home = mkdtempSync(path.join(tmpdir(), "seatledger-limits-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const req = (
  ts: number,
  tokens: number,
  client: UsageRecord["client"] = "claude-code",
): UsageRecord => ({
  client,
  id: `${client}-${ts}`,
  ts,
  model: "claude-opus-5-5",
  version: "",
  project: "",
  session: "",
  input: 0,
  output: 0,
  cacheRead: tokens,
  cacheWrite: 0,
  cacheWrite1h: null,
  fast: false,
  geoUs: false,
});

describe("stored limits", () => {
  it("sets, replaces per window and scope, and clears", () => {
    setLimit(home, { window: "5h", client: "all", tokens: 1e6 });
    setLimit(home, { window: "5h", client: "all", tokens: 2e6 });
    setLimit(home, { window: "weekly", client: "codex", usd: 300 });
    expect(readLimits(home).map((l) => [l.window, l.client, l.tokens ?? l.usd])).toEqual([
      ["5h", "all", 2e6],
      ["weekly", "codex", 300],
    ]);
    clearLimits(home, "5h");
    expect(readLimits(home).map((l) => l.window)).toEqual(["weekly"]);
    clearLimits(home);
    expect(readLimits(home)).toEqual([]);
  });
});

describe("5-hour windows", () => {
  it("open at the first request and close five hours later", () => {
    const ws = fiveHourWindows([
      req(T0, 1),
      req(T0 + 4 * H, 1),
      req(T0 + 5 * H, 1),
      req(T0 + 6 * H, 1),
    ]);
    expect(ws.map((w) => [w.start, w.records.length])).toEqual([
      [T0, 2],
      [T0 + 5 * H, 2],
    ]);
  });

  const limit: Limit = { window: "5h", client: "all", tokens: 1_000_000, setAt: "" };

  it("projects when the limit is reached at the current burn rate", () => {
    const now = T0 + 2 * H;
    const s = limitStatus(limit, [req(T0, 300_000), req(T0 + H, 300_000)], now);
    expect(s).toMatchObject({
      used: 600_000,
      fraction: 0.6,
      windowStart: T0,
      windowEnd: T0 + 5 * H,
      reached: false,
    });
    expect(s.burnPerHour).toBe(300_000);
    expect(s.reachedAt).toBe(now + (400_000 / 300_000) * H); // 400K left at 300K/h
  });

  it("says the window resets first when the rate would not reach the limit", () => {
    const s = limitStatus(limit, [req(T0, 100_000)], T0 + 4 * H);
    expect(s.reachedAt).toBeNull();
  });

  it("reports when a limit was reached, and the busiest recent window when none is open", () => {
    const reached = limitStatus(limit, [req(T0, 600_000), req(T0 + H, 600_000)], T0 + 2 * H);
    expect(reached).toMatchObject({ reached: true, reachedAt: T0 + H });
    const idle = limitStatus(limit, [req(T0, 600_000), req(T0 + H, 600_000)], T0 + 9 * H);
    expect(idle).toMatchObject({ used: 0, windowStart: null });
    expect(idle.busiest).toEqual({ start: T0, used: 1_200_000 });
  });

  it("counts only the client a limit is scoped to", () => {
    const codexOnly: Limit = { ...limit, client: "codex" };
    const s = limitStatus(
      codexOnly,
      [req(T0, 500_000), req(T0 + 60_000, 100_000, "codex")],
      T0 + H,
    );
    expect(s.used).toBe(100_000);
  });
});

describe("weekly limits", () => {
  it("sum the rolling last 7 days and burn at the last day's rate", () => {
    const limit: Limit = { window: "weekly", client: "all", tokens: 10_000_000, setAt: "" };
    const now = T0;
    const s = limitStatus(
      limit,
      [req(now - 8 * 24 * H, 9e6), req(now - 3 * 24 * H, 4e6), req(now - H, 2.4e6)],
      now,
    );
    expect(s.used).toBe(6.4e6);
    expect(s.burnPerHour).toBe(100_000);
    expect(s.reachedAt).toBe(now + 36 * H);
  });
});

describe("vendor readings", () => {
  it("keeps the latest reading per window and marks windows that have reset", () => {
    const q = (ts: number, used: number, resetsAt: number): QuotaSample => ({
      client: "codex",
      ts,
      limitId: "codex",
      slot: "primary",
      windowMinutes: 300,
      usedPercent: used,
      resetsAt,
      planType: "pro",
    });
    const now = T0 + 2 * H;
    const [r] = vendorReadings([q(T0, 10, T0 + 5 * H), q(T0 + H, 30, T0 + 5 * H)], now);
    expect(r).toMatchObject({ usedPercent: 30, current: true, readAt: T0 + H });
    const [old] = vendorReadings([q(T0, 10, T0 + H)], now);
    expect(old!.current).toBe(false);
  });
});
