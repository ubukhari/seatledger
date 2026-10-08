/**
 * Codex CLI rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` and
 * `~/.codex/archived_sessions/` ($CODEX_HOME replaces `~/.codex`).
 *
 * Verified on 7 Oct 2026 against rollouts written by Codex 0.144–0.159 on a real machine (metadata
 * only) and the source of rust-v0.160.1 (`codex-rs/protocol/src/protocol.rs`, `TokenUsage`,
 * `TokenUsageRecord`, `RateLimitSnapshot`; `codex-rs/history/src/rollout_payload.rs`):
 *
 * - `session_meta` carries the thread id, `cwd` and `cli_version`; `turn_context` the `turn_id` and
 *   `model` of each turn;
 * - newer versions write one `token_usage_record` per model response, with a `response_id`, the
 *   `turn_id` and the `root_turn_id` that owns it (subagents included), and its `usage`;
 * - every version writes `event_msg` / `token_count` with the thread's running total and the last
 *   response's usage, plus the account's `rate_limits` (5-hour and weekly windows, `used_percent`,
 *   `resets_at`, `plan_type`) as the server reported them;
 * - `input_tokens` includes `cached_input_tokens` and `cache_write_input_tokens` (the Responses API
 *   reports both as parts of the input); `output_tokens` includes reasoning.
 *
 * Where a rollout has `token_usage_record`s they are used; `token_count` events are used for the
 * part of a rollout written before them, and for older rollouts that have none.
 */
import { folderName, forEachJsonLine, num, obj, str, time } from "../jsonl.js";
import type { FileExtract, QuotaSample, UsageRecord } from "../types.js";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function usageOf(v: unknown): Usage | undefined {
  const u = obj(v);
  if (!u) return undefined;
  const input = num(u.input_tokens);
  const cacheRead = Math.min(num(u.cached_input_tokens), input);
  const cacheWrite = Math.min(num(u.cache_write_input_tokens), input - cacheRead);
  return {
    input: input - cacheRead - cacheWrite,
    output: num(u.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

const usageKey = (u: Usage) => `${u.input}/${u.output}/${u.cacheRead}/${u.cacheWrite}`;

export async function readCodexFile(file: string): Promise<FileExtract> {
  const stats = { skipped: 0 };
  let thread = "";
  let project = "";
  let version = "";
  let model = "";
  let turn: string | undefined;
  const turnModel = new Map<string, string>();
  const records: UsageRecord[] = [];
  const fromCounts: { record: UsageRecord; key: string }[] = [];
  const quota: QuotaSample[] = [];
  let lastTotal = -1;
  let firstRecordTs: number | undefined;

  const base = (ts: number, m: string): Omit<UsageRecord, "id" | keyof Usage> => ({
    client: "codex",
    ts,
    model: m || "unknown",
    version,
    project,
    session: thread,
    cacheWrite1h: null,
    fast: false,
    geoUs: false,
  });

  await forEachJsonLine(
    file,
    (raw) =>
      raw.includes('"token_count"') ||
      raw.includes('"token_usage_record"') ||
      raw.includes('"turn_context"') ||
      raw.includes('"session_meta"'),
    (line) => {
      const payload = obj(line.payload) ?? {};
      const ts = time(line.timestamp);
      switch (line.type) {
        case "session_meta": {
          thread = str(payload.id) ?? thread;
          project = folderName(str(payload.cwd)) || project;
          version = str(payload.cli_version) ?? version;
          return;
        }
        case "turn_context": {
          model = str(payload.model) ?? model;
          turn = str(payload.turn_id) ?? turn;
          if (turn && model) turnModel.set(turn, model);
          return;
        }
        case "token_usage_record": {
          const usage = usageOf(payload.usage);
          const responseId = str(payload.response_id);
          if (!usage || !responseId || ts === undefined) return;
          const turnId = str(payload.turn_id);
          const rootTurn = str(payload.root_turn_id) ?? turnId;
          firstRecordTs ??= ts;
          records.push({
            ...base(ts, (turnId && turnModel.get(turnId)) || model),
            id: `codex:${responseId}`,
            ...usage,
            ...(rootTurn ? { turn: `codex:${rootTurn}` } : {}),
          });
          return;
        }
        case "event_msg": {
          if (payload.type !== "token_count" || ts === undefined) return;
          const info = obj(payload.info);
          const total = num(obj(info?.total_token_usage)?.total_tokens);
          const last = usageOf(info?.last_token_usage);
          // A repeated event has an unchanged running total: same response, written again.
          if (info && last && total > lastTotal) {
            const sum = last.input + last.output + last.cacheRead + last.cacheWrite;
            if (sum > 0) {
              fromCounts.push({
                record: {
                  ...base(ts, model),
                  id: `codex-tc:${str(line.timestamp)}:${total}`,
                  ...last,
                  ...(turn ? { turn: `codex:${turn}` } : {}),
                },
                key: usageKey(last),
              });
            }
            lastTotal = total;
          }
          collectQuota(payload.rate_limits, ts, quota);
          return;
        }
      }
    },
    stats,
  );

  let requests = records;
  if (records.length === 0) {
    requests = fromCounts.map((c) => c.record);
  } else {
    // Keep token_count readings only from before the first record, and only if no record
    // describes the same response.
    const seen = new Set(records.map(usageKey));
    for (const c of fromCounts) {
      if (firstRecordTs !== undefined && c.record.ts < firstRecordTs - 5_000 && !seen.has(c.key))
        requests.push(c.record);
    }
  }
  return {
    client: "codex",
    requests,
    prompts: [],
    quota: compressQuota(quota),
    skippedLines: stats.skipped,
  };
}

/** Every event repeats the reading; keep the first, each change, and the last, per window. */
function compressQuota(samples: QuotaSample[]): QuotaSample[] {
  const out: QuotaSample[] = [];
  const last = new Map<string, QuotaSample>();
  const lastKept = new Map<string, QuotaSample>();
  for (const s of samples) {
    const k = `${s.limitId}/${s.slot}`;
    const prev = lastKept.get(k);
    if (!prev || prev.usedPercent !== s.usedPercent || prev.resetsAt !== s.resetsAt) {
      out.push(s);
      lastKept.set(k, s);
    }
    last.set(k, s);
  }
  for (const [k, s] of last) if (lastKept.get(k) !== s) out.push(s);
  return out.sort((a, b) => a.ts - b.ts);
}

function collectQuota(v: unknown, ts: number, into: QuotaSample[]): void {
  const limits = obj(v);
  if (!limits) return;
  const limitId = str(limits.limit_id) ?? "codex";
  const planType = str(limits.plan_type) ?? null;
  for (const slot of ["primary", "secondary"] as const) {
    const w = obj(limits[slot]);
    if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
    const resets = typeof w.resets_at === "number" ? w.resets_at * 1000 : null;
    into.push({
      client: "codex",
      ts,
      limitId,
      slot,
      windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
      usedPercent: w.used_percent,
      resetsAt: resets,
      planType,
    });
  }
}
