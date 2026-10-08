import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { load } from "./load.js";
import { CACHE_DIR } from "./store.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";

let root: string;
let synth: SyntheticResult;
const dirs = () => ({ "claude-code": [synth.claudeDir], codex: [synth.codexDir] });

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "seatledger-load-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src"), days: 10 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("load", () => {
  it("counts each response once, across the lines and files that repeat it", async () => {
    const loaded = await load({ dirs: dirs(), cache: false, home: path.join(root, "nocache") });
    const claude = loaded.requests.filter((r) => r.client === "claude-code");
    const codex = loaded.requests.filter((r) => r.client === "codex");
    expect(claude).toHaveLength(synth.claudeRequests);
    expect(codex).toHaveLength(synth.codexRequests);
    expect(new Set(loaded.requests.map((r) => r.id)).size).toBe(loaded.requests.length);
    // the streamed first line of a response carries a partial output count; the merge keeps the final one
    expect(claude.every((r) => r.model.startsWith("claude-haiku") || r.output >= 150)).toBe(true);
  });

  it("attributes every main-model request to the turn a person started, subagents included", async () => {
    const loaded = await load({ dirs: dirs(), cache: false, home: path.join(root, "nocache") });
    const opus = loaded.requests.filter((r) => r.model === "claude-opus-5-5");
    expect(opus.every((r) => r.turn !== undefined)).toBe(true);
    const codex = loaded.requests.filter((r) => r.client === "codex");
    expect(codex.every((r) => r.turn?.startsWith("codex:"))).toBe(true);
  });

  it("serves unchanged transcripts from the cache, which holds counts and never text", async () => {
    const home = path.join(root, "home-cache");
    const first = await load({ dirs: dirs(), home });
    const read = first.sources.reduce((s, x) => s + x.read, 0);
    expect(read).toBeGreaterThan(0);
    const second = await load({ dirs: dirs(), home });
    expect(second.sources.reduce((s, x) => s + x.read, 0)).toBe(0);
    expect(second.requests).toEqual(first.requests);
    const cacheDir = path.join(home, CACHE_DIR);
    const text = readdirSync(cacheDir)
      .map((f) => readFileSync(path.join(cacheDir, f), "utf8"))
      .join("\n");
    expect(text).not.toMatch(/synthetic (prompt|reply)/);
  });

  it("keeps the counts of a transcript the client has since deleted", async () => {
    const home = path.join(root, "home-retain");
    const before = await load({ dirs: dirs(), home });
    const victimDir = path.join(synth.claudeDir, "-home-dev-webapp");
    const victim = readdirSync(victimDir).find((f) => f.endsWith(".jsonl"))!;
    unlinkSync(path.join(victimDir, victim));
    const after = await load({ dirs: dirs(), home });
    expect(after.requests.length).toBe(before.requests.length);
    expect(after.sources.find((s) => s.client === "claude-code")!.retained).toBe(1);
    // without the cache, the deleted transcript's requests are gone
    const fresh = await load({ dirs: dirs(), cache: false, home });
    expect(fresh.requests.length).toBeLessThan(before.requests.length);
  });

  it("drops requests before `since` and does not read transcripts last written before it", async () => {
    const since = synth.now - 2 * 86_400_000;
    const loaded = await load({ dirs: dirs(), cache: false, home: path.join(root, "x"), since });
    expect(loaded.requests.length).toBeGreaterThan(0);
    expect(loaded.requests.every((r) => r.ts >= since)).toBe(true);
  });

  it("reads one client when asked, and reports where it looked when nothing is there", async () => {
    const empty = path.join(root, "empty");
    const loaded = await load({
      dirs: { "claude-code": [empty], codex: [empty] },
      cache: false,
      home: empty,
      clients: ["codex"],
    });
    expect(loaded.requests).toEqual([]);
    expect(loaded.sources).toEqual([
      { client: "codex", roots: [empty], files: 0, read: 0, retained: 0, skippedLines: 0 },
    ]);
  });
});
