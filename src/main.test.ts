import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";

let root: string;
let synth: SyntheticResult;
const saved = { home: process.env.SEATLEDGER_HOME, now: process.env.SEATLEDGER_NOW };

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "seatledger-cli-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src") });
  process.env.SEATLEDGER_HOME = path.join(root, "home");
  process.env.SEATLEDGER_NOW = new Date(synth.now).toISOString();
});
afterAll(() => {
  for (const [k, v] of [
    ["SEATLEDGER_HOME", saved.home],
    ["SEATLEDGER_NOW", saved.now],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function run(...args: string[]) {
  let out = "";
  let err = "";
  const sink = (f: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, cb) {
        f(String(chunk));
        cb();
      },
    });
  const code = await main(
    [...args, "--claude-dir", synth.claudeDir, "--codex-dir", synth.codexDir],
    { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
  );
  return { code, out, err };
}

describe("seatledger (summary)", () => {
  it("prints today, the last 7 days, limits and where it read from, labelling dollars API-equivalent", async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain("Today, Wed 7 Oct");
    expect(out).toContain("Last 7 days, Thu 1 Oct – Wed 7 Oct");
    expect(out).toContain("Claude Code · claude-opus-5-5");
    expect(out).toContain("API-equiv $");
    const flat = out.replace(/\s+/g, " ");
    expect(flat).toContain("Not what you were billed");
    expect(out).toContain("Limits: none set");
    expect(out).toContain("Codex 5-hour window:");
    expect(flat).toMatch(
      /Read \d+ Claude Code transcripts and \d+ Codex transcripts, on this machine only\. Nothing was sent anywhere\./,
    );
  });

  it("--json is the same view as data", async () => {
    const { code, out } = await run("--json");
    expect(code).toBe(0);
    const v = JSON.parse(out) as {
      today: { rows: unknown[] };
      last7Days: { days: unknown[] };
      prices: unknown[];
    };
    expect(v.last7Days.days).toHaveLength(7);
    expect(v.prices).toHaveLength(2);
  });
});

describe("seatledger report", () => {
  it("groups by project", async () => {
    const { code, out } = await run("report", "--by", "project", "--since", "14d");
    expect(code).toBe(0);
    for (const p of ["webapp", "api-server", "infra"]) expect(out).toContain(p);
  });

  it("rejects a bad --by or --since with usage, exit 2", async () => {
    expect((await run("report", "--by", "week")).code).toBe(2);
    const bad = await run("report", "--since", "yesterday");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--since takes a date");
  });
});

describe("seatledger rates", () => {
  it("prints the finding and the method", async () => {
    const { code, out } = await run("rates");
    expect(code).toBe(0);
    expect(out).toContain("From 30 Sep (Claude Code 2.1.230, the first day on it)");
    expect(out).toContain("Method:");
  });
});

describe("seatledger limits", () => {
  it("sets a limit, shows the burn toward it, and clears it", async () => {
    const set = await run("limits", "set", "--window", "5h", "--tokens", "50M");
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/5-hour window, all clients: .* of 50\.0M tokens/);
    const summary = await run();
    expect(summary.out).toContain("Your limits");
    const cleared = await run("limits", "clear");
    expect(cleared.out).toContain("Limits: none set");
  });

  it("needs a window and exactly one amount", async () => {
    expect((await run("limits", "set", "--tokens", "5M")).code).toBe(2);
    expect((await run("limits", "set", "--window", "5h")).code).toBe(2);
    expect(
      (await run("limits", "set", "--window", "5h", "--tokens", "5M", "--usd", "3")).code,
    ).toBe(2);
    expect((await run("limits", "set", "--window", "daily", "--tokens", "5M")).code).toBe(2);
  });
});

describe("usage", () => {
  it("unknown commands and flags exit 2", async () => {
    expect((await run("frobnicate")).code).toBe(2);
    expect((await run("--frobnicate")).code).toBe(2);
  });
});
