import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCodexFile } from "./codex.js";

const dir = mkdtempSync(path.join(tmpdir(), "seatledger-codex-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function file(lines: object[]): string {
  const p = path.join(dir, `rollout-${++n}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
const meta = {
  timestamp: at(0),
  type: "session_meta",
  payload: {
    id: "thread-1",
    cwd: "/home/dev/api-server",
    cli_version: "0.159.0",
    base_instructions: { text: "secret instructions" },
  },
};
const ctx = (turn: string, model: string, s: number) => ({
  timestamp: at(s),
  type: "turn_context",
  payload: { turn_id: turn, model },
});
const u = (input: number, cached: number, write: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: Math.floor(output / 2),
  total_tokens: input + output,
});
const record = (id: string, turn: string, usage: object, s: number) => ({
  timestamp: at(s),
  type: "token_usage_record",
  payload: {
    thread_id: "thread-1",
    turn_id: turn,
    root_turn_id: `root-${turn}`,
    response_id: id,
    usage,
  },
});
const count = (total: number, last: object, s: number, primary = 10) => ({
  timestamp: at(s),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { total_tokens: total }, last_token_usage: last },
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: primary, window_minutes: 300, resets_at: 1_791_000_000 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1_791_500_000 },
      plan_type: "pro",
    },
  },
});

describe("readCodexFile", () => {
  it("uses token_usage_record: one request per response, model from its turn, cached and written input split out", async () => {
    const out = await readCodexFile(
      file([
        meta,
        ctx("t1", "gpt-5.6-sol", 1),
        record("resp_a", "t1", u(10_000, 8_000, 1_500, 300), 2),
        count(10_300, u(10_000, 8_000, 1_500, 300), 2),
        ctx("t2", "codex-auto-review", 3),
        record("resp_b", "t2", u(4_000, 0, 0, 50), 4),
      ]),
    );
    expect(out.requests).toHaveLength(2);
    expect(out.requests[0]).toMatchObject({
      client: "codex",
      id: "codex:resp_a",
      model: "gpt-5.6-sol",
      version: "0.159.0",
      project: "api-server",
      session: "thread-1",
      input: 500,
      cacheRead: 8_000,
      cacheWrite: 1_500,
      output: 300,
      cacheWrite1h: null,
      turn: "codex:root-t1",
    });
    expect(out.requests[1]!.model).toBe("codex-auto-review");
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });

  it("falls back to token_count for rollouts without records, skipping repeats and empty fills", async () => {
    const out = await readCodexFile(
      file([
        meta,
        ctx("t1", "gpt-5.5", 1),
        count(1_100, u(1_000, 600, 0, 100), 2),
        count(1_100, u(1_000, 600, 0, 100), 3), // the same reading, written again
        count(2_400, u(1_200, 1_000, 0, 100), 4),
        // fill_to_context_window: total jumps, no input or output to bill
        count(400_000, { total_tokens: 397_600 }, 5),
      ]),
    );
    expect(out.requests.map((r) => [r.model, r.input, r.cacheRead, r.output])).toEqual([
      ["gpt-5.5", 400, 600, 100],
      ["gpt-5.5", 200, 1_000, 100],
    ]);
    expect(out.requests[0]!.turn).toBe("codex:t1");
  });

  it("in a rollout that has records, keeps only token_count readings from before them that no record covers", async () => {
    const out = await readCodexFile(
      file([
        meta,
        ctx("t0", "gpt-5.5", 1),
        count(1_100, u(1_000, 600, 0, 100), 2), // written by an older CLI: no record
        ctx("t1", "gpt-5.6-sol", 30),
        count(3_300, u(2_000, 1_500, 0, 200), 31), // the same response as resp_c, logged first
        record("resp_c", "t1", u(2_000, 1_500, 0, 200), 31),
        count(6_000, u(2_500, 2_000, 0, 200), 40), // covered by resp_d
        record("resp_d", "t1", u(2_500, 2_000, 0, 200), 40),
      ]),
    );
    expect(out.requests.map((r) => r.id).sort()).toEqual(
      ["codex:resp_c", "codex:resp_d", expect.stringMatching(/^codex-tc:/)].sort(),
    );
  });

  it("keeps the rate-limit readings Codex wrote, once per change", async () => {
    const out = await readCodexFile(
      file([
        meta,
        count(100, u(90, 0, 0, 10), 1, 10),
        count(200, u(90, 0, 0, 10), 2, 10),
        count(300, u(90, 0, 0, 10), 3, 12),
        count(400, u(90, 0, 0, 10), 4, 12),
      ]),
    );
    const primary = out.quota.filter((q) => q.slot === "primary");
    expect(primary.map((q) => q.usedPercent)).toEqual([10, 12, 12]);
    expect(primary[0]).toMatchObject({
      client: "codex",
      limitId: "codex",
      windowMinutes: 300,
      resetsAt: 1_791_000_000_000,
      planType: "pro",
    });
    expect(out.quota.filter((q) => q.slot === "secondary").map((q) => q.usedPercent)).toEqual([
      3, 3,
    ]);
  });
});
