/**
 * Limits you set yourself, and how fast you are burning toward them.
 *
 * seatledger does not ship any vendor's plan limits. They are not published as token counts, they
 * change without notice, and a number we hard-coded would be wrong in a way you could not see.
 * Set your own (for example, the window total `seatledger limits` shows for a window in which you
 * did hit the vendor's limit), and seatledger tells you how close you are and when, at the current
 * rate, you would reach it.
 *
 * - 5h: a window opens at your first request and lasts five hours; the next request after it
 *   closes opens the next one. That is how Claude Code and Codex describe their 5-hour limits;
 *   the vendor's exact boundary is not visible locally.
 * - weekly: the rolling last 7 days.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apiEquivalentUsd } from "./prices.js";
import { totalTokens, type Client, type QuotaSample, type UsageRecord } from "./types.js";

export const WINDOWS = ["5h", "weekly"] as const;
export type LimitWindow = (typeof WINDOWS)[number];
export type LimitScope = Client | "all";

export interface Limit {
  window: LimitWindow;
  client: LimitScope;
  /** Total tokens (input, output, cache reads and cache writes). */
  tokens?: number;
  /** API-equivalent USD. */
  usd?: number;
  setAt: string;
}

interface LimitsFile {
  v: 1;
  limits: Limit[];
}

const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 86_400_000;

const limitsPath = (home: string) => path.join(home, "limits.json");

export function readLimits(home: string): Limit[] {
  try {
    const f = JSON.parse(readFileSync(limitsPath(home), "utf8")) as LimitsFile;
    return Array.isArray(f.limits) ? f.limits.filter(isLimit) : [];
  } catch {
    return [];
  }
}

function isLimit(v: unknown): v is Limit {
  const l = v as Limit;
  return (
    !!l &&
    (WINDOWS as readonly string[]).includes(l.window) &&
    (l.client === "all" || l.client === "claude-code" || l.client === "codex") &&
    (typeof l.tokens === "number" || typeof l.usd === "number")
  );
}

function writeLimits(home: string, limits: Limit[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = limitsPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, limits } satisfies LimitsFile, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmp, file);
}

/** Set (or replace) the limit for one window and scope. Returns the limits now in force. */
export function setLimit(home: string, limit: Omit<Limit, "setAt">, now = Date.now()): Limit[] {
  const rest = readLimits(home).filter(
    (l) => !(l.window === limit.window && l.client === limit.client),
  );
  const next = [...rest, { ...limit, setAt: new Date(now).toISOString() }];
  writeLimits(home, next);
  return next;
}

export function clearLimits(home: string, window?: LimitWindow, client?: LimitScope): Limit[] {
  const next = readLimits(home).filter(
    (l) =>
      (window !== undefined && l.window !== window) ||
      (client !== undefined && l.client !== client),
  );
  writeLimits(home, next);
  return next;
}

export interface LimitStatus {
  limit: Limit;
  unit: "tokens" | "usd";
  amount: number;
  used: number;
  /** used / amount */
  fraction: number;
  windowStart: number | null;
  /** When the current 5h window closes; null for weekly, or when no window is open. */
  windowEnd: number | null;
  /** Per hour, over the open window (5h) or the last 24 hours (weekly). */
  burnPerHour: number;
  /** When the limit is (or was) reached at the current burn rate; null if not before reset. */
  reachedAt: number | null;
  /** True when it has already been reached in this window. */
  reached: boolean;
  /** Busiest 5-hour window of the last 30 days (5h limits only), to calibrate against. */
  busiest: { start: number; used: number } | null;
}

const measure = (r: UsageRecord, unit: "tokens" | "usd"): number =>
  unit === "tokens" ? totalTokens(r) : (apiEquivalentUsd(r) ?? 0);

/** Fixed 5-hour windows: each opens at the first request after the previous one closed. */
export function fiveHourWindows(
  sorted: readonly UsageRecord[],
): { start: number; records: UsageRecord[] }[] {
  const out: { start: number; records: UsageRecord[] }[] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && r.ts < cur.start + FIVE_HOURS) cur.records.push(r);
    else out.push({ start: r.ts, records: [r] });
  }
  return out;
}

export function limitStatus(
  limit: Limit,
  requests: readonly UsageRecord[],
  now: number,
): LimitStatus {
  const unit = limit.tokens !== undefined ? "tokens" : "usd";
  const amount = (limit.tokens ?? limit.usd)!;
  const mine = requests
    .filter((r) => limit.client === "all" || r.client === limit.client)
    .filter((r) => r.ts <= now)
    .sort((a, b) => a.ts - b.ts);

  if (limit.window === "5h") {
    const windows = fiveHourWindows(mine);
    let busiest: LimitStatus["busiest"] = null;
    for (const w of windows) {
      if (w.start < now - 30 * 86_400_000) continue;
      const used = w.records.reduce((s, r) => s + measure(r, unit), 0);
      if (!busiest || used > busiest.used) busiest = { start: w.start, used };
    }
    const last = windows[windows.length - 1];
    const open = last && now < last.start + FIVE_HOURS ? last : undefined;
    if (!open) {
      return {
        limit,
        unit,
        amount,
        used: 0,
        fraction: 0,
        windowStart: null,
        windowEnd: null,
        burnPerHour: 0,
        reachedAt: null,
        reached: false,
        busiest,
      };
    }
    const end = open.start + FIVE_HOURS;
    let used = 0;
    let reachedAt: number | null = null;
    for (const r of open.records) {
      used += measure(r, unit);
      if (reachedAt === null && used >= amount) reachedAt = r.ts;
    }
    const elapsedH = Math.max((now - open.start) / 3_600_000, 1 / 12);
    const burn = used / elapsedH;
    if (reachedAt === null && burn > 0) {
      const eta = now + ((amount - used) / burn) * 3_600_000;
      reachedAt = eta < end ? eta : null;
    }
    return {
      limit,
      unit,
      amount,
      used,
      fraction: used / amount,
      windowStart: open.start,
      windowEnd: end,
      burnPerHour: burn,
      reachedAt,
      reached: used >= amount,
      busiest,
    };
  }

  const start = now - WEEK;
  const week = mine.filter((r) => r.ts > start);
  const used = week.reduce((s, r) => s + measure(r, unit), 0);
  const lastDay = week.filter((r) => r.ts > now - 86_400_000);
  const burn = lastDay.reduce((s, r) => s + measure(r, unit), 0) / 24;
  let reachedAt: number | null = null;
  if (used >= amount) {
    let acc = 0;
    for (const r of week) {
      acc += measure(r, unit);
      if (acc >= amount) {
        reachedAt = r.ts;
        break;
      }
    }
  } else if (burn > 0) {
    reachedAt = now + ((amount - used) / burn) * 3_600_000;
  }
  return {
    limit,
    unit,
    amount,
    used,
    fraction: used / amount,
    windowStart: start,
    windowEnd: null,
    burnPerHour: burn,
    reachedAt,
    reached: used >= amount,
    busiest: null,
  };
}

export interface VendorReading {
  client: Client;
  limitId: string;
  slot: "primary" | "secondary";
  windowMinutes: number | null;
  usedPercent: number;
  resetsAt: number | null;
  planType: string | null;
  /** When the client wrote this reading. */
  readAt: number;
  /** False once `resetsAt` has passed: the reading describes a window that is over. */
  current: boolean;
}

/** The latest reading of each vendor window, exactly as the client recorded it locally. */
export function vendorReadings(quota: readonly QuotaSample[], now: number): VendorReading[] {
  const latest = new Map<string, QuotaSample>();
  for (const q of quota) {
    const k = `${q.client}/${q.limitId}/${q.slot}`;
    const prev = latest.get(k);
    if (!prev || q.ts >= prev.ts) latest.set(k, q);
  }
  return [...latest.values()]
    .map((q) => ({
      client: q.client,
      limitId: q.limitId,
      slot: q.slot,
      windowMinutes: q.windowMinutes,
      usedPercent: q.usedPercent,
      resetsAt: q.resetsAt,
      planType: q.planType,
      readAt: q.ts,
      current: q.resetsAt === null || q.resetsAt > now,
    }))
    .sort((a, b) => a.limitId.localeCompare(b.limitId) || a.slot.localeCompare(b.slot));
}
