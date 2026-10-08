/**
 * seatledger's own copy of the counts, one small file per transcript under
 * `~/.seatledger/cache-v1/`. Two reasons it exists:
 *
 * 1. Speed. A transcript that has not changed (same size, same mtime) is not read again.
 * 2. History. Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default). The
 *    counts seatledger already took from a deleted transcript stay here, so the ledger and the
 *    rate baselines keep their history. Delete the directory to forget it.
 *
 * Only what `UsageRecord`, `PromptMark` and `QuotaSample` hold is written: counts, timestamps,
 * ids, model ids, versions and folder names. Never prompt or response text.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Client, FileExtract, QuotaSample, UsageRecord } from "./types.js";

export const CACHE_DIR = "cache-v1";

export interface CachedExtract extends FileExtract {
  src: string;
  size: number;
  mtimeMs: number;
}

type Row = [
  id: string,
  ts: number,
  model: number,
  version: number,
  project: number,
  session: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h: number,
  flags: number,
  turn: number,
];

interface Wire {
  v: 1;
  src: string;
  size: number;
  mtimeMs: number;
  client: Client;
  strings: string[];
  requests: Row[];
  prompts: [session: number, ts: number][];
  quota: [
    ts: number,
    limitId: string,
    slot: 0 | 1,
    windowMinutes: number | null,
    usedPercent: number,
    resetsAt: number | null,
    planType: string | null,
  ][];
  skipped: number;
}

const FAST = 1;
const GEO_US = 2;

export function encode(e: CachedExtract): Wire {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const s = (v: string): number => {
    let i = index.get(v);
    if (i === undefined) {
      i = strings.push(v) - 1;
      index.set(v, i);
    }
    return i;
  };
  return {
    v: 1,
    src: e.src,
    size: e.size,
    mtimeMs: e.mtimeMs,
    client: e.client,
    strings,
    requests: e.requests.map((r) => [
      r.id,
      r.ts,
      s(r.model),
      s(r.version),
      s(r.project),
      s(r.session),
      r.input,
      r.output,
      r.cacheRead,
      r.cacheWrite,
      r.cacheWrite1h ?? -1,
      (r.fast ? FAST : 0) | (r.geoUs ? GEO_US : 0),
      r.turn === undefined ? -1 : s(r.turn),
    ]),
    prompts: e.prompts.map((p) => [s(p.session), p.ts]),
    quota: e.quota.map((q) => [
      q.ts,
      q.limitId,
      q.slot === "primary" ? 0 : 1,
      q.windowMinutes,
      q.usedPercent,
      q.resetsAt,
      q.planType,
    ]),
    skipped: e.skippedLines,
  };
}

export function decode(w: Wire): CachedExtract {
  const at = (i: number): string => w.strings[i] ?? "";
  return {
    src: w.src,
    size: w.size,
    mtimeMs: w.mtimeMs,
    client: w.client,
    skippedLines: w.skipped,
    requests: w.requests.map((r): UsageRecord => ({
      client: w.client,
      id: r[0],
      ts: r[1],
      model: at(r[2]),
      version: at(r[3]),
      project: at(r[4]),
      session: at(r[5]),
      input: r[6],
      output: r[7],
      cacheRead: r[8],
      cacheWrite: r[9],
      cacheWrite1h: r[10] < 0 ? null : r[10],
      fast: (r[11] & FAST) !== 0,
      geoUs: (r[11] & GEO_US) !== 0,
      ...(r[12] >= 0 ? { turn: at(r[12]) } : {}),
    })),
    prompts: w.prompts.map(([si, ts]) => ({ session: at(si), ts })),
    quota: w.quota.map((q): QuotaSample => ({
      client: w.client,
      ts: q[0],
      limitId: q[1],
      slot: q[2] === 0 ? "primary" : "secondary",
      windowMinutes: q[3],
      usedPercent: q[4],
      resetsAt: q[5],
      planType: q[6],
    })),
  };
}

const fileFor = (dir: string, src: string): string =>
  path.join(dir, createHash("sha256").update(src).digest("hex").slice(0, 32) + ".json");

/** Every cached extract, keyed by the transcript path it came from. Unreadable entries are skipped. */
export function readCache(home: string): Map<string, CachedExtract> {
  const dir = path.join(home, CACHE_DIR);
  const out = new Map<string, CachedExtract>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Wire;
      if (wire.v !== 1 || typeof wire.src !== "string") continue;
      out.set(wire.src, decode(wire));
    } catch {
      // a partial write from an interrupted run; it is re-read from the transcript
    }
  }
  return out;
}

/** Best effort: a cache that cannot be written only costs speed and history, never a report. */
export function writeCacheEntry(home: string, entry: CachedExtract): boolean {
  const dir = path.join(home, CACHE_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileFor(dir, entry.src);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
