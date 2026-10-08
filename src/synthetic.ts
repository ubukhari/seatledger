/**
 * Synthetic transcripts in the real on-disk formats, for tests, the README screenshot and anyone
 * who wants to see seatledger's output without their own history. Every text field is a
 * placeholder; the counts follow how a coding agent's context grows within a session.
 *
 * With `step` on (the default), Claude Code 2.1.230 arrives on `step.date` and from then on cache
 * writes are made at the 5-minute lifetime and about four in ten requests miss the cache: the
 * pattern of a shortened cache lifetime. Codex 0.159.0 arrives on `codexStep.date` and from then
 * on the same tokens use twice as much of the 5-hour window. With `step: false` nothing changes,
 * and the detector must stay quiet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SyntheticOptions {
  /** Directory to write into: `<dir>/claude/projects/…` and `<dir>/codex/sessions/…`. */
  dir: string;
  /** First day, YYYY-MM-DD (UTC). */
  start?: string;
  days?: number;
  seed?: number;
  /** false: a history with no change in it. */
  step?: false | { date: string };
  codexStep?: false | { date: string };
}

export interface SyntheticResult {
  claudeDir: string;
  codexDir: string;
  /** 16:00 UTC on the last day: a fixed "now" for reproducible output. */
  now: number;
  claudeRequests: number;
  codexRequests: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = ["webapp", "api-server", "infra"];
const DAY = 86_400_000;

export function writeSyntheticHistory(opts: SyntheticOptions): SyntheticResult {
  const start = Date.parse(`${opts.start ?? "2026-08-25"}T00:00:00Z`);
  const days = opts.days ?? 44;
  const rand = rng(opts.seed ?? 7);
  const step =
    opts.step === false
      ? undefined
      : Date.parse(`${(opts.step ?? { date: "2026-09-30" }).date}T00:00:00Z`);
  const codexStep =
    opts.codexStep === false
      ? undefined
      : Date.parse(`${(opts.codexStep ?? { date: "2026-09-22" }).date}T00:00:00Z`);
  const claudeDir = path.join(opts.dir, "claude", "projects");
  const codexDir = path.join(opts.dir, "codex", "sessions");
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
  let claudeRequests = 0;
  let codexRequests = 0;
  let msg = 0;

  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY;
    const weekend = new Date(dayStart).getUTCDay() % 6 === 0;
    const after = step !== undefined && dayStart >= step;
    const version = after ? "2.1.230" : dayStart >= start + 12 * DAY ? "2.1.229" : "2.1.226";

    // ---- Claude Code: a few sessions a day, each a few turns of tool-using requests.
    const sessions = weekend ? 1 : between(2, 3);
    let clock = dayStart + 9 * 3_600_000;
    for (let s = 0; s < sessions; s++) {
      const project = PROJECTS[(d + s) % PROJECTS.length]!;
      const session = `00000000-0000-4000-8000-${String(d * 10 + s).padStart(12, "0")}`;
      const lines: string[] = [];
      const sub: string[] = [];
      let context = 21_000; // system prompt, tools, CLAUDE.md
      const turns = between(4, 7);
      for (let t = 0; t < turns; t++) {
        clock += between(2, 9) * 60_000;
        lines.push(
          JSON.stringify({
            type: "user",
            sessionId: session,
            cwd: `/home/dev/${project}`,
            version,
            isSidechain: false,
            timestamp: new Date(clock).toISOString(),
            origin: { kind: "human" },
            message: { role: "user", content: "synthetic prompt" },
          }),
        );
        const requests = between(4, 9);
        for (let q = 0; q < requests; q++) {
          clock += between(10, 70) * 1000;
          const fresh = between(1500, 4500);
          const miss = rand() < (after ? 0.42 : 0.04);
          const cacheRead = miss ? 0 : context;
          const cacheWrite = miss ? context + fresh : fresh;
          context += fresh;
          const output = between(150, 1800);
          const sidechain = q === requests - 1 && t % 3 === 2;
          const id = `msg_synthetic_${++msg}`;
          const usage = (out: number) => ({
            input_tokens: between(2, 12),
            cache_creation_input_tokens: cacheWrite,
            cache_read_input_tokens: cacheRead,
            cache_creation: after
              ? { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 }
              : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite },
            output_tokens: out,
            service_tier: "standard",
            speed: "standard",
          });
          const line = (out: number, stop: string | null) =>
            JSON.stringify({
              type: "assistant",
              sessionId: session,
              cwd: `/home/dev/${project}`,
              version,
              isSidechain: sidechain,
              requestId: `req_synthetic_${msg}`,
              timestamp: new Date(clock).toISOString(),
              message: {
                id,
                model: "claude-opus-5-5",
                role: "assistant",
                type: "message",
                content: [{ type: "text", text: "synthetic reply" }],
                stop_reason: stop,
                usage: usage(out),
              },
            });
          // Claude Code writes one line per content block; output grows to its final count.
          const target = sidechain ? sub : lines;
          target.push(line(Math.round(output / 3), null), line(output, "tool_use"));
          if (sidechain) lines.push(line(output, "tool_use")); // also mirrored into the parent
          lines.push(
            JSON.stringify({
              type: "user",
              sessionId: session,
              timestamp: new Date(clock + 500).toISOString(),
              message: { role: "user", content: [{ type: "tool_result", content: "synthetic" }] },
            }),
          );
          claudeRequests += 1;
        }
      }
      // A small model doing side work: too few requests a day to be judged on its own.
      for (let h = 0; h < 3; h++) {
        clock += 20_000;
        lines.push(
          JSON.stringify({
            type: "assistant",
            sessionId: session,
            cwd: `/home/dev/${project}`,
            version,
            requestId: `req_haiku_${msg}_${h}`,
            timestamp: new Date(clock).toISOString(),
            message: {
              id: `msg_haiku_${msg}_${h}`,
              model: "claude-haiku-4-5-20251001",
              content: [{ type: "text", text: "synthetic" }],
              usage: {
                input_tokens: 900,
                output_tokens: 40,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          }),
        );
        claudeRequests += 1;
      }
      const dir = path.join(claudeDir, `-home-dev-${project}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${session}.jsonl`), lines.join("\n") + "\n");
      if (sub.length > 0) {
        const subDir = path.join(dir, session, "subagents");
        mkdirSync(subDir, { recursive: true });
        writeFileSync(path.join(subDir, "agent-synthetic.jsonl"), sub.join("\n") + "\n");
      }
    }

    // ---- Codex: one rollout a weekday, with its own rate-limit readings.
    if (weekend) continue;
    const codexAfter = codexStep !== undefined && dayStart >= codexStep;
    const cli = codexAfter ? "0.159.0" : "0.158.0";
    const tokensPerPercent = codexAfter ? 40_000 : 80_000;
    const thread = `11111111-0000-4000-8000-${String(d).padStart(12, "0")}`;
    const begin = dayStart + 13 * 3_600_000;
    const resetsAt = Math.round((begin + 5 * 3_600_000) / 1000);
    const out: string[] = [
      JSON.stringify({
        timestamp: new Date(begin).toISOString(),
        type: "session_meta",
        payload: {
          id: thread,
          cwd: "/home/dev/api-server",
          cli_version: cli,
          originator: "codex_cli_rs",
        },
      }),
    ];
    let t = begin;
    let total = 0;
    let codexContext = 12_000;
    const turnsToday = between(5, 7);
    for (let turn = 0; turn < turnsToday; turn++) {
      const turnId = `turn-${d}-${turn}`;
      t += between(3, 8) * 60_000;
      out.push(
        JSON.stringify({
          timestamp: new Date(t).toISOString(),
          type: "turn_context",
          payload: { turn_id: turnId, model: "gpt-5.6-sol", cwd: "/home/dev/api-server" },
        }),
      );
      const responses = between(4, 6);
      for (let r = 0; r < responses; r++) {
        t += between(15, 60) * 1000;
        const fresh = between(800, 3000);
        const cached = Math.round(codexContext * 0.9);
        const input = codexContext + fresh;
        codexContext += fresh;
        const output = between(200, 1500);
        const usage = {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: fresh,
          output_tokens: output,
          reasoning_output_tokens: Math.round(output / 2),
          total_tokens: input + output,
        };
        total += input + output;
        const used = Math.min(100, total / tokensPerPercent);
        out.push(
          JSON.stringify({
            timestamp: new Date(t).toISOString(),
            type: "token_usage_record",
            payload: {
              thread_id: thread,
              turn_id: turnId,
              root_turn_id: turnId,
              response_id: `resp_${d}_${turn}_${r}`,
              usage,
            },
          }),
          JSON.stringify({
            timestamp: new Date(t + 10).toISOString(),
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { ...usage, total_tokens: total },
                last_token_usage: usage,
                model_context_window: 400_000,
              },
              rate_limits: {
                limit_id: "codex",
                primary: {
                  used_percent: Math.round(used * 10) / 10,
                  window_minutes: 300,
                  resets_at: resetsAt,
                },
                secondary: {
                  used_percent: Math.round(used / 4),
                  window_minutes: 10080,
                  resets_at: resetsAt + 4 * 86_400,
                },
                plan_type: "pro",
              },
            },
          }),
        );
        codexRequests += 1;
      }
    }
    const date = new Date(dayStart).toISOString().slice(0, 10).split("-");
    const dir = path.join(codexDir, date[0]!, date[1]!, date[2]!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(
        dir,
        `rollout-${new Date(begin).toISOString().slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`,
      ),
      out.join("\n") + "\n",
    );
  }

  return {
    claudeDir,
    codexDir,
    now: start + (days - 1) * DAY + 16 * 3_600_000,
    claudeRequests,
    codexRequests,
  };
}
