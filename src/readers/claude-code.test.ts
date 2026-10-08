import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readClaudeCodeFile } from "./claude-code.js";

const dir = mkdtempSync(path.join(tmpdir(), "seatledger-cc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function file(lines: (object | string)[]): string {
  const p = path.join(dir, `t${++n}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return p;
}

const base = {
  sessionId: "s1",
  cwd: "/home/dev/webapp",
  version: "2.1.286",
  timestamp: "2026-10-01T10:00:00.000Z",
};

const assistant = (id: string, usage: object, extra: object = {}) => ({
  ...base,
  type: "assistant",
  requestId: `req_${id}`,
  message: {
    id,
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "secret reply" }],
    usage,
  },
  ...extra,
});

const usage = {
  input_tokens: 3,
  output_tokens: 10,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 2_000,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1_500 },
  service_tier: "standard",
  speed: "standard",
  inference_geo: "not_available",
  some_future_field: { nested: true },
};

describe("readClaudeCodeFile", () => {
  it("merges the lines of one response, keeping the final (largest) output count", async () => {
    const out = await readClaudeCodeFile(
      file([
        assistant("msg_1", usage),
        assistant(
          "msg_1",
          { ...usage, output_tokens: 840 },
          { timestamp: "2026-10-01T10:00:05.000Z" },
        ),
        assistant("msg_2", { ...usage, output_tokens: 7 }),
      ]),
    );
    expect(out.requests).toHaveLength(2);
    const first = out.requests.find((r) => r.id === "msg_1:req_msg_1")!;
    expect(first).toMatchObject({
      client: "claude-code",
      model: "claude-opus-5-5",
      version: "2.1.286",
      project: "webapp",
      session: "s1",
      input: 3,
      output: 840,
      cacheRead: 50_000,
      cacheWrite: 2_000,
      cacheWrite1h: 1_500,
      fast: false,
      geoUs: false,
      ts: Date.parse("2026-10-01T10:00:00.000Z"),
    });
  });

  it("skips <synthetic> messages, malformed lines and lines without usage; ignores unknown fields", async () => {
    const out = await readClaudeCodeFile(
      file([
        assistant("msg_s", usage, { message: { id: "x", model: "<synthetic>", usage } }),
        '{"type":"assistant","usage":', // cut off mid-write
        { ...base, type: "assistant", message: { id: "m", model: "claude-opus-5-5" } },
        assistant("msg_ok", usage, { brandNewTopLevelField: [1, 2, 3] }),
      ]),
    );
    expect(out.requests.map((r) => r.id)).toEqual(["msg_ok:req_msg_ok"]);
    expect(out.skippedLines).toBe(1);
  });

  it("reads fast mode, US-only inference, and writes with no lifetime split", async () => {
    const { cache_creation: _, ...noSplit } = usage;
    const out = await readClaudeCodeFile(
      file([assistant("msg_f", { ...noSplit, speed: "fast", inference_geo: "us" })]),
    );
    expect(out.requests[0]).toMatchObject({
      fast: true,
      geoUs: true,
      cacheWrite1h: null,
      cacheWrite: 2_000,
    });
  });

  it("reports the repository, not the worktree, for Claude Code worktrees", async () => {
    const out = await readClaudeCodeFile(
      file([assistant("msg_w", usage, { cwd: "/home/dev/webapp/.claude/worktrees/agent-123" })]),
    );
    expect(out.requests[0]!.project).toBe("webapp");
  });

  it("marks the turns a person started, and only those", async () => {
    const user = (extra: object, content: unknown = "fix the bug") => ({
      ...base,
      type: "user",
      message: { role: "user", content },
      ...extra,
    });
    const out = await readClaudeCodeFile(
      file([
        user({ timestamp: "2026-10-01T09:00:00Z", origin: { kind: "human" } }),
        user({ timestamp: "2026-10-01T09:01:00Z", origin: { kind: "task-notification" } }),
        user({ timestamp: "2026-10-01T09:02:00Z", turnOrigin: "human" }),
        user({ timestamp: "2026-10-01T09:03:00Z", turnOrigin: "peer" }),
        user({ timestamp: "2026-10-01T09:04:00Z" }), // older version: plain text
        user(
          { timestamp: "2026-10-01T09:05:00Z" },
          "<local-command-stdout>ok</local-command-stdout>",
        ),
        user({ timestamp: "2026-10-01T09:06:00Z" }, "[Request interrupted by user]"),
        user({ timestamp: "2026-10-01T09:07:00Z", isMeta: true }),
        user({ timestamp: "2026-10-01T09:08:00Z", isSidechain: true }),
        user({ timestamp: "2026-10-01T09:09:00Z", isCompactSummary: true }),
        user({ timestamp: "2026-10-01T09:10:00Z" }, [{ type: "tool_result", content: "x" }]),
        user({ timestamp: "2026-10-01T09:11:00Z" }, [
          { type: "text", text: "<command-name>/review</command-name>" },
        ]),
      ]),
    );
    expect(out.prompts.map((p) => new Date(p.ts).toISOString().slice(11, 16))).toEqual([
      "09:00",
      "09:02",
      "09:04",
      "09:11",
    ]);
  });

  it("keeps nothing but counts and names: no prompt or response text reaches the extract", async () => {
    const out = await readClaudeCodeFile(
      file([
        {
          ...base,
          type: "user",
          origin: { kind: "human" },
          message: { role: "user", content: "secret prompt" },
        },
        assistant("msg_p", usage),
      ]),
    );
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });
});
