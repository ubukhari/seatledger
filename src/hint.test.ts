/**
 * The one line about the team ledger: once a day, only on a terminal, never with --json or in MCP
 * output, never once the machine is on a team, and off with --quiet or SEATLEDGER_QUIET=1.
 * Printing it sends nothing (`main` gets a fetch that fails the test if called).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dim, hintFile, quietFromEnv, RATES_HINT, TEAM_HINT, teamHint } from "./hint.js";
import { main } from "./main.js";
import { handleMessage } from "./mcp.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";

let root: string;
let synth: SyntheticResult;
let n = 0;
const saved = {
  home: process.env.SEATLEDGER_HOME,
  now: process.env.SEATLEDGER_NOW,
  quiet: process.env.SEATLEDGER_QUIET,
  key: process.env.SEATLEDGER_KEY,
  noColor: process.env.NO_COLOR,
};
const DAY = 86_400_000;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "seatledger-hint-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src") });
  process.env.SEATLEDGER_NOW = new Date(synth.now).toISOString();
  delete process.env.SEATLEDGER_QUIET;
  delete process.env.SEATLEDGER_KEY;
  delete process.env.NO_COLOR;
});
afterAll(() => {
  for (const [k, v] of [
    ["SEATLEDGER_HOME", saved.home],
    ["SEATLEDGER_NOW", saved.now],
    ["SEATLEDGER_QUIET", saved.quiet],
    ["SEATLEDGER_KEY", saved.key],
    ["NO_COLOR", saved.noColor],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const freshHome = () => {
  const home = path.join(root, `home-${++n}`);
  process.env.SEATLEDGER_HOME = home;
  return home;
};

const noNetwork = async (): Promise<Response> => {
  throw new Error("the team line must not make a request");
};

async function run(args: string[], tty = true) {
  let out = "";
  let err = "";
  const sink = (f: (s: string) => void) =>
    Object.assign(
      new Writable({
        write(chunk, _enc, cb) {
          f(String(chunk));
          cb();
        },
      }),
      { isTTY: tty },
    );
  const code = await main(
    [...args, "--claude-dir", synth.claudeDir, "--codex-dir", synth.codexDir, "--no-cache"],
    { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    { fetch: noNetwork },
  );
  return { code, out, err };
}

const shows = (out: string, line: string) => out.includes(line);

describe("teamHint", () => {
  const ctx = (home: string, over: Partial<Parameters<typeof teamHint>[0]> = {}) => ({
    home,
    now: Date.parse("2026-10-07T09:00:00"),
    env: {},
    tty: true,
    quiet: false,
    ...over,
  });

  it("shows once a day, then again the next day", () => {
    const home = path.join(root, `unit-${++n}`);
    expect(teamHint(ctx(home), "team")).toBe(dim(TEAM_HINT, {}));
    expect(teamHint(ctx(home), "team")).toBeNull();
    expect(teamHint(ctx(home), "rates")).toBeNull();
    expect(existsSync(hintFile(home))).toBe(true);
    const tomorrow = Date.parse("2026-10-08T09:00:00");
    expect(teamHint(ctx(home, { now: tomorrow }), "rates")).toBe(dim(RATES_HINT, {}));
  });

  it("never off a terminal, with --quiet or SEATLEDGER_QUIET, or once on a team", () => {
    const home = path.join(root, `unit-${++n}`);
    expect(teamHint(ctx(home, { tty: false }), "team")).toBeNull();
    expect(teamHint(ctx(home, { quiet: true }), "team")).toBeNull();
    expect(teamHint(ctx(home, { env: { SEATLEDGER_QUIET: "1" } }), "team")).toBeNull();
    expect(teamHint(ctx(home, { env: { SEATLEDGER_KEY: "slk_x" } }), "team")).toBeNull();
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "team.json"), JSON.stringify({ url: "https://x", key: "slk_y" }));
    expect(teamHint(ctx(home), "team")).toBeNull();
    // none of those counted as showing it
    expect(existsSync(hintFile(home))).toBe(false);
  });

  it("SEATLEDGER_QUIET is on for any value but empty, 0 or false", () => {
    for (const v of ["1", "true", "yes"]) expect(quietFromEnv({ SEATLEDGER_QUIET: v })).toBe(true);
    for (const v of ["", "0", "false"]) expect(quietFromEnv({ SEATLEDGER_QUIET: v })).toBe(false);
    expect(quietFromEnv({})).toBe(false);
  });

  it("is dim unless NO_COLOR or a dumb terminal, and the line names the free plan", () => {
    expect(dim("x", {})).toBe("\u001b[2mx\u001b[22m");
    expect(dim("x", { NO_COLOR: "1" })).toBe("x");
    expect(dim("x", { TERM: "dumb" })).toBe("x");
    expect(TEAM_HINT).toContain("`npx seatledger team create`");
    expect(TEAM_HINT).toContain("free for up to 3 developers");
    expect(RATES_HINT).toContain("`npx seatledger team create`");
  });

  it.skipIf(process.getuid?.() === 0)("is not shown when it could not record that it was", () => {
    const home = path.join(root, `unit-${++n}`);
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o500);
    try {
      expect(teamHint(ctx(home), "team")).toBeNull();
    } finally {
      chmodSync(home, 0o700);
    }
  });
});

describe("in the CLI", () => {
  it("after the summary once, then not again that day; never with --json", async () => {
    freshHome();
    const json = await run(["--json"]);
    expect(json.code).toBe(0);
    expect(shows(json.out, TEAM_HINT)).toBe(false);
    const first = await run([]);
    expect(first.code).toBe(0);
    const lines = first.out.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(dim(TEAM_HINT, process.env));
    expect(lines.filter((l) => l.includes("team create"))).toHaveLength(1);
    const second = await run([]);
    expect(shows(second.out, TEAM_HINT)).toBe(false);
    const report = await run(["report", "--by", "model"]);
    expect(shows(report.out, TEAM_HINT)).toBe(false);
  });

  it("after report on a terminal, not when output is piped", async () => {
    freshHome();
    expect(shows((await run(["report"], false)).out, TEAM_HINT)).toBe(false);
    expect(shows((await run(["report"])).out, TEAM_HINT)).toBe(true);
  });

  it("after rates only when it found a change, with the rates wording", async () => {
    freshHome();
    const rates = await run(["rates"]);
    expect(rates.out).toContain("step changes found");
    expect(rates.out.trimEnd().split("\n").at(-1)).toBe(dim(RATES_HINT, process.env));
    expect(shows(rates.out, TEAM_HINT)).toBe(false);
    freshHome();
    const none = await run(["rates", "--since", "3d"]);
    expect(none.out).toContain("No step changes found");
    expect(shows(none.out, RATES_HINT)).toBe(false);
  });

  it("--quiet and SEATLEDGER_QUIET=1 turn it off, and say so in --help", async () => {
    freshHome();
    expect(shows((await run(["--quiet"])).out, TEAM_HINT)).toBe(false);
    process.env.SEATLEDGER_QUIET = "1";
    try {
      expect(shows((await run([])).out, TEAM_HINT)).toBe(false);
    } finally {
      delete process.env.SEATLEDGER_QUIET;
    }
    const help = await run(["--help"]);
    expect(help.out).toContain("--quiet");
    expect(help.out).toContain("SEATLEDGER_QUIET=1");
    expect(help.out).toContain("/seatledger?ref=cli");
  });

  it("never in MCP output", async () => {
    const home = freshHome();
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "seatledger_usage_summary", arguments: {} },
      },
      {
        home,
        loadOptions: {
          dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
          cache: false,
          home,
        },
        now: () => synth.now,
      },
    )) as { result: unknown };
    expect(JSON.stringify(res)).not.toContain("team create");
    expect(existsSync(hintFile(home))).toBe(false);
  });

  it("is one day's state, not a timer: a run 24 hours later shows it again", async () => {
    const home = freshHome();
    expect(shows((await run([])).out, TEAM_HINT)).toBe(true);
    process.env.SEATLEDGER_NOW = new Date(synth.now + DAY).toISOString();
    try {
      expect(shows((await run(["report"])).out, TEAM_HINT)).toBe(true);
    } finally {
      process.env.SEATLEDGER_NOW = new Date(synth.now).toISOString();
    }
    expect(existsSync(hintFile(home))).toBe(true);
  });
});
