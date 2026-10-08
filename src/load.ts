/**
 * Read every local transcript (or its cached counts), deduplicate, and attribute requests to the
 * turns people started. Nothing here opens a network connection.
 */
import path from "node:path";
import { listSourceFiles, seatledgerHome, sourceDirs, type SourceDirs } from "./paths.js";
import { mergeRecords, readClaudeCodeFile } from "./readers/claude-code.js";
import { readCodexFile } from "./readers/codex.js";
import { readCache, writeCacheEntry, type CachedExtract } from "./store.js";
import type { Client, FileExtract, PromptMark, QuotaSample, UsageRecord } from "./types.js";

export interface LoadOptions {
  dirs?: SourceDirs;
  /** Epoch ms; requests before it are dropped, and transcripts last written before it are not read. */
  since?: number;
  /** Use and update `~/.seatledger/cache-v1`. Default true. */
  cache?: boolean;
  /** seatledger's home (cache, limits). Default `$SEATLEDGER_HOME` or `~/.seatledger`. */
  home?: string;
  /** Clients to read. Default both. */
  clients?: readonly Client[];
  /** Called once with the number of transcripts that have to be read (not served from cache). */
  onRead?: (files: number) => void;
}

export interface SourceSummary {
  client: Client;
  roots: string[];
  /** Transcripts found on disk. */
  files: number;
  /** Of those, read this run (new or changed since the cache). */
  read: number;
  /** Cached counts kept from transcripts that no longer exist (deleted by the client's cleanup). */
  retained: number;
  /** Lines that were not JSON or not usable; counted, never shown. */
  skippedLines: number;
}

export interface Loaded {
  requests: UsageRecord[];
  quota: QuotaSample[];
  sources: SourceSummary[];
  since: number | undefined;
}

const READERS: Record<Client, (file: string) => Promise<FileExtract>> = {
  "claude-code": readClaudeCodeFile,
  codex: readCodexFile,
};

const under = (file: string, roots: string[]): boolean =>
  roots.some((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

export async function load(opts: LoadOptions = {}): Promise<Loaded> {
  const dirs = opts.dirs ?? sourceDirs();
  const clients = opts.clients ?? (["claude-code", "codex"] as const);
  const useCache = opts.cache ?? true;
  const home = opts.home ?? seatledgerHome();
  const since = opts.since;

  const cache = useCache ? readCache(home) : new Map<string, CachedExtract>();
  const files = listSourceFiles(dirs).filter((f) => clients.includes(f.client));
  const onDisk = new Set(files.map((f) => f.path));

  const extracts: FileExtract[] = [];
  const summary = new Map<Client, SourceSummary>(
    clients.map((c) => [
      c,
      { client: c, roots: dirs[c], files: 0, read: 0, retained: 0, skippedLines: 0 },
    ]),
  );

  const toRead: typeof files = [];
  for (const f of files) {
    summary.get(f.client)!.files += 1;
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.client === f.client) {
      extracts.push(hit);
    } else if (since !== undefined && f.mtimeMs < since) {
      // Last written before the window: it cannot hold a request we would show.
      if (hit && hit.client === f.client) extracts.push(hit);
    } else {
      toRead.push(f);
    }
  }

  opts.onRead?.(toRead.length);
  // A few files at a time: enough to overlap I/O and parsing, not enough to exhaust descriptors.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < toRead.length) {
      const f = toRead[next++]!;
      let extract: FileExtract;
      try {
        extract = await READERS[f.client](f.path);
      } catch {
        continue; // unreadable (permissions, deleted mid-run): skip, never fail the report
      }
      summary.get(f.client)!.read += 1;
      extracts.push(extract);
      if (useCache)
        writeCacheEntry(home, { ...extract, src: f.path, size: f.size, mtimeMs: f.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));

  // History the client has since deleted.
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !clients.includes(entry.client)) continue;
    if (!under(src, dirs[entry.client])) continue;
    extracts.push(entry);
    summary.get(entry.client)!.retained += 1;
  }

  const byId = new Map<string, UsageRecord>();
  const prompts = new Map<string, PromptMark>();
  const quota = new Map<string, QuotaSample>();
  for (const e of extracts) {
    summary.get(e.client)!.skippedLines += e.skippedLines;
    for (const r of e.requests) {
      const prev = byId.get(r.id);
      byId.set(r.id, prev ? mergeRecords(prev, r) : r);
    }
    for (const p of e.prompts) prompts.set(`${p.session}@${p.ts}`, p);
    for (const q of e.quota) quota.set(`${q.limitId}/${q.slot}@${q.ts}`, q);
  }

  const requests = assignTurns([...byId.values()], [...prompts.values()]).filter(
    (r) => since === undefined || r.ts >= since,
  );
  requests.sort((a, b) => a.ts - b.ts);
  return {
    requests,
    quota: [...quota.values()].sort((a, b) => a.ts - b.ts),
    sources: [...summary.values()],
    since,
  };
}

/**
 * Claude Code requests belong to the latest turn a person started in the same session before
 * them; subagent requests share their parent's session, so they land on the turn that spawned
 * them. Codex records carry their root turn already.
 */
export function assignTurns(requests: UsageRecord[], prompts: PromptMark[]): UsageRecord[] {
  const bySession = new Map<string, number[]>();
  for (const p of prompts) {
    const list = bySession.get(p.session) ?? [];
    list.push(p.ts);
    bySession.set(p.session, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a - b);
  return requests.map((r) => {
    if (r.client !== "claude-code" || r.turn !== undefined) return r;
    const list = bySession.get(r.session);
    if (!list) return r;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= r.ts) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? r : { ...r, turn: `${r.session}@${list[found]}` };
  });
}
