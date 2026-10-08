/**
 * `seatledger push`, `team join` and `seatledger_team_summary` against a fake service: what a push
 * carries (aggregates and numbers only), that --dry-run sends nothing, that the key file is
 * readable by its owner only and never printed, and how the CLI splits a long history.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { load } from "./load.js";
import { main } from "./main.js";
import { handleMessage } from "./mcp.js";
import {
  buildPushPayload,
  MAX_ROWS_PER_PUSH,
  splitPayload,
  type PushPayload,
  type PushRow,
} from "./push.js";
import { dailySeries, rateReport } from "./rates.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";
import { startOfDay } from "./ledger.js";

let root: string;
let synth: SyntheticResult;
const saved = {
  home: process.env.SEATLEDGER_HOME,
  now: process.env.SEATLEDGER_NOW,
  key: process.env.SEATLEDGER_KEY,
  url: process.env.SEATLEDGER_URL,
};
let home: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "seatledger-push-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src") });
  process.env.SEATLEDGER_NOW = new Date(synth.now).toISOString();
  delete process.env.SEATLEDGER_KEY;
  delete process.env.SEATLEDGER_URL;
});
afterEach(() => {
  delete process.env.SEATLEDGER_KEY;
});
afterAll(() => {
  for (const [k, v] of [
    ["SEATLEDGER_HOME", saved.home],
    ["SEATLEDGER_NOW", saved.now],
    ["SEATLEDGER_KEY", saved.key],
    ["SEATLEDGER_URL", saved.url],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function freshHome(): string {
  home = path.join(root, `home-${++n}`);
  process.env.SEATLEDGER_HOME = home;
  return home;
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeService(answer: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const a = answer(call);
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

async function run(args: string[], fetch?: (u: string, i?: RequestInit) => Promise<Response>) {
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
    [...args, "--claude-dir", synth.claudeDir, "--codex-dir", synth.codexDir, "--no-cache"],
    { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    fetch ? { fetch } : {},
  );
  return { code, out, err };
}

async function payloadFor(opts: { projectNames?: boolean } = {}): Promise<PushPayload> {
  const loaded = await load({
    dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
    cache: false,
    home: path.join(root, "lib-home"),
  });
  return buildPushPayload(loaded, {
    since: startOfDay(synth.now, 399),
    now: synth.now,
    rates: rateReport(dailySeries(loaded.requests, loaded.quota)),
    ...opts,
  });
}

const JOINED = {
  team_id: "team_1",
  team: "Acme",
  member: "alice",
  key: "slk_" + "a1".repeat(20),
  plan: "free",
};

describe("what a push carries", () => {
  it("one row per day × client × version × model, counts that add up, numbers-only findings", async () => {
    const p = await payloadFor();
    expect(p.schema).toBe("seatledger.push/v1");
    expect(p.days[0]).toBe("2026-08-25");
    expect(p.days.at(-1)).toBe("2026-10-07");
    expect(p.days).toHaveLength(44);
    const requests = p.rows.reduce((s, r) => s + r.requests, 0);
    expect(requests).toBe(synth.claudeRequests + synth.codexRequests);
    const keys = p.rows.map((r) => [r.day, r.client, r.client_version, r.model].join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(p.rows.some((r) => "project" in r)).toBe(false);
    for (const f of p.findings)
      for (const v of Object.values(f)) if (typeof v === "string") expect(v).not.toMatch(/\s/);
    // Codex's own quota readings are a series across its models
    expect(p.findings.map((f) => [f.client, f.model, f.date])).toEqual(
      expect.arrayContaining([
        ["claude-code", "claude-opus-5-5", "2026-09-30"],
        ["codex", "*", "2026-09-22"],
      ]),
    );
    const allowed = new Set([
      "day",
      "client",
      "client_version",
      "model",
      "requests",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "api_equivalent_usd",
    ]);
    for (const r of p.rows) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
  });

  it("folder names only with --project-names, and only as a short token", async () => {
    const p = await payloadFor({ projectNames: true });
    const projects = new Set(p.rows.map((r: PushRow) => r.project));
    expect([...projects].sort()).toEqual(["api-server", "infra", "webapp"]);
  });

  it("a long history goes in several pushes, oldest first, findings on the last", () => {
    const days = Array.from({ length: 450 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 6, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const rows = days.flatMap((day) =>
      Array.from({ length: 12 }, (_, m) => ({
        day,
        client: "claude-code" as const,
        client_version: "2.1.0",
        model: `m-${m}`,
        requests: 1,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
        api_equivalent_usd: 0.01,
      })),
    );
    const parts = splitPayload({ schema: "seatledger.push/v1", days, rows, findings: [] });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.days.length).toBeLessThanOrEqual(400);
      expect(part.rows.length).toBeLessThanOrEqual(MAX_ROWS_PER_PUSH);
    }
    expect(parts.flatMap((x) => x.days)).toEqual(days);
    expect(parts.flatMap((x) => x.rows)).toHaveLength(rows.length);
  });
});

describe("seatledger push", () => {
  it("--dry-run prints exactly the payload and sends nothing, even without a team", async () => {
    freshHome();
    const svc = fakeService(() => ({ body: {} }));
    const { code, out } = await run(["push", "--dry-run"], svc.fetch);
    expect(code).toBe(0);
    expect(svc.calls).toHaveLength(0);
    expect(out).toContain("nothing was sent");
    const json = JSON.parse(out.slice(out.indexOf("{"))) as PushPayload;
    expect(json.schema).toBe("seatledger.push/v1");
    expect(json.rows.length).toBeGreaterThan(0);
  });

  it("without a team key it says how to join, and sends nothing", async () => {
    freshHome();
    const svc = fakeService(() => ({ body: {} }));
    const { code, err } = await run(["push"], svc.fetch);
    expect(code).toBe(2);
    expect(err).toContain("seatledger team join");
    expect(svc.calls).toHaveLength(0);
  });

  it("team join saves the key readable by you only, never prints it, and push uses it", async () => {
    freshHome();
    const svc = fakeService((c) =>
      c.url.endsWith("/join")
        ? { status: 201, body: JOINED }
        : {
            body: {
              team: "team_1",
              member: "alice",
              plan: "free",
              history_days: 30,
              history_start: "2026-09-08",
              days_replaced: 30,
              rows_stored: 90,
              rows_removed: 0,
              days_skipped: Array.from({ length: 14 }, () => "x"),
              findings: { received: 2, new: 2, seen_before: 0 },
              alerts: { alerted: 0, duplicates: 0, dashboard_only: 2 },
            },
          },
    );
    const invite = "https://preview.seatledger.test/seatledger/join/sli_" + "0f".repeat(12);
    const joined = await run(["team", "join", invite, "--as", "alice"], svc.fetch);
    expect(joined.code).toBe(0);
    expect(joined.out).toContain("Joined Acme as alice");
    expect(joined.out).not.toContain(JOINED.key);
    expect(svc.calls[0]).toMatchObject({
      url: "https://preview.seatledger.test/api/seatledger/v1/join",
      method: "POST",
      auth: null,
      body: { invite, member: "alice" },
    });
    const file = path.join(home, "team.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      url: "https://preview.seatledger.test",
      key: JOINED.key,
      member: "alice",
    });

    const again = await run(["team", "join", invite], svc.fetch);
    expect(again.code).toBe(2);
    expect(again.err).toContain("--force");

    const pushed = await run(["push"], svc.fetch);
    expect(pushed.code).toBe(0);
    const call = svc.calls.at(-1)!;
    expect(call.url).toBe("https://preview.seatledger.test/api/seatledger/v1/push");
    expect(call.auth).toBe(`Bearer ${JOINED.key}`);
    expect((call.body as PushPayload).schema).toBe("seatledger.push/v1");
    expect(pushed.out).toContain("Pushed 30 days (90 rows)");
    expect(pushed.out).toContain("14 days older than the plan keeps were not stored");
    expect(pushed.out).not.toContain(JOINED.key);
    expect(JSON.parse(readFileSync(file, "utf8")).lastPushDay).toBe("2026-10-07");
  });

  it("a refusal from the service is printed with its fix", async () => {
    freshHome();
    process.env.SEATLEDGER_KEY = JOINED.key;
    const svc = fakeService(() => ({
      status: 402,
      body: {
        code: "SEAT_LIMIT",
        cause: "Acme is on seatledger Free, which covers 3 developers",
        fix: "the team owner upgrades",
        retryable: false,
      },
    }));
    const { code, err } = await run(["push", "--since", "7d"], svc.fetch);
    expect(code).toBe(1);
    expect(err).toContain("SEAT_LIMIT: Acme is on seatledger Free");
    expect(err).toContain("fix: the team owner upgrades");
  });
});

describe("seatledger team create", () => {
  const CREATED = {
    team_id: "team_9",
    name: "Acme platform",
    plan: "free",
    developers: 3,
    history_days: 30,
    owner_key: "slk_" + "c3".repeat(20),
    member: "owner",
    invite_url: "https://preview.seatledger.test/seatledger/join/sli_" + "9a".repeat(12),
    notice: "Save owner_key now",
    next: [],
  };
  const PUSHED = {
    team: "team_9",
    member: "owner",
    plan: "free",
    history_days: 30,
    history_start: "2026-09-08",
    days_replaced: 30,
    rows_stored: 90,
    rows_removed: 0,
    days_skipped: [],
    findings: { received: 2, new: 2, seen_before: 0 },
    alerts: { alerted: 0, duplicates: 0, dashboard_only: 2 },
  };
  const service = () =>
    fakeService((c) =>
      c.url.endsWith("/teams") ? { status: 201, body: CREATED } : { body: PUSHED },
    );

  it("creates the team, saves the owner key like team join, prints the invite and the dashboard, never the key", async () => {
    freshHome();
    process.env.SEATLEDGER_URL = "https://preview.seatledger.test/";
    try {
      const svc = service();
      const created = await run(
        ["team", "create", "--name", "Acme platform", "--email", "lead@example.com"],
        svc.fetch,
      );
      expect(created.code, created.err).toBe(0);
      expect(svc.calls[0]).toMatchObject({
        url: "https://preview.seatledger.test/api/seatledger/v1/teams",
        method: "POST",
        auth: null,
        body: { accept_terms: true, name: "Acme platform", owner_email: "lead@example.com" },
      });
      expect(created.out).toContain("Created Acme platform on seatledger Free (3 developers");
      expect(created.out).toContain(`npx seatledger team join ${CREATED.invite_url} --as <name>`);
      expect(created.out).toContain(
        "Dashboard: https://preview.seatledger.test/seatledger/dashboard?ref=cli",
      );
      expect(created.out).toContain("accepted the terms at https://preview.seatledger.test/terms");
      expect(created.out).not.toContain(CREATED.owner_key);
      const file = path.join(home, "team.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        url: "https://preview.seatledger.test",
        key: CREATED.owner_key,
        teamId: "team_9",
        team: "Acme platform",
        member: "owner",
      });

      // the saved owner key is this machine's push key
      const pushed = await run(["push", "--since", "7d"], svc.fetch);
      expect(pushed.code, pushed.err).toBe(0);
      expect(svc.calls.at(-1)).toMatchObject({
        url: "https://preview.seatledger.test/api/seatledger/v1/push",
        auth: `Bearer ${CREATED.owner_key}`,
      });

      // a second create would replace that key, so it needs --force
      const again = await run(["team", "create"], svc.fetch);
      expect(again.code).toBe(1);
      expect(again.err).toContain("ALREADY_ON_TEAM");
      expect(again.err).toContain("fix: run `seatledger team`");
      expect(again.err).toContain("retryable: no");
      expect(svc.calls.filter((c) => c.url.endsWith("/teams"))).toHaveLength(1);
    } finally {
      delete process.env.SEATLEDGER_URL;
    }
  });

  it("--dry-run prints exactly what would be sent and sends nothing", async () => {
    freshHome();
    const svc = service();
    const dry = await run(["team", "create", "--dry-run", "--as", "lead"], svc.fetch);
    expect(dry.code).toBe(0);
    expect(svc.calls).toHaveLength(0);
    expect(dry.out).toContain("nothing was sent");
    expect(dry.out).toContain("https://agentwares-agentcheck.vercel.app/api/seatledger/v1/teams");
    expect(JSON.parse(dry.out.slice(dry.out.indexOf("{"), dry.out.indexOf("}") + 1))).toEqual({
      accept_terms: true,
      member: "lead",
    });
    const json = await run(["team", "create", "--dry-run", "--json"], svc.fetch);
    expect(JSON.parse(json.out)).toMatchObject({
      dry_run: true,
      method: "POST",
      body: { accept_terms: true },
    });
    expect(svc.calls).toHaveLength(0);
    expect(existsSync(path.join(home, "team.json"))).toBe(false);
  });

  it("--json answers without the key", async () => {
    freshHome();
    const svc = service();
    const res = await run(["team", "create", "--json"], svc.fetch);
    expect(res.code, res.err).toBe(0);
    const body = JSON.parse(res.out) as Record<string, unknown>;
    expect(body).toMatchObject({
      team_id: "team_9",
      invite_url: CREATED.invite_url,
      dashboard_url: "https://agentwares-agentcheck.vercel.app/seatledger/dashboard?ref=cli",
    });
    expect(res.out).not.toContain(CREATED.owner_key);
    expect(body).not.toHaveProperty("owner_key");
  });

  it("a bad name, address or developer name fails before anything is sent, with code, cause, fix", async () => {
    freshHome();
    const svc = service();
    for (const [args, code] of [
      [["--name", "  "], "INVALID_NAME"],
      [["--name", "Acme\nplatform"], "INVALID_NAME"],
      [["--email", "not-an-address"], "INVALID_EMAIL"],
      [["--as", "Alice Smith"], "INVALID_MEMBER"],
    ] as const) {
      const r = await run(["team", "create", ...args, "--json"], svc.fetch);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.err)).toMatchObject({ code, retryable: false });
      expect((JSON.parse(r.err) as { fix: string }).fix.length).toBeGreaterThan(10);
    }
    expect(svc.calls).toHaveLength(0);
  });

  it("a refusal from the service is printed with its fix and whether to retry", async () => {
    freshHome();
    const svc = fakeService(() => ({
      status: 429,
      body: {
        code: "RATE_LIMITED",
        cause: "10 teams already created from this client this hour",
        fix: "reuse the team you created, or wait for the next hour",
        retryable: true,
      },
    }));
    const res = await run(["team", "create"], svc.fetch);
    expect(res.code).toBe(1);
    expect(res.err).toContain("RATE_LIMITED: 10 teams already created");
    expect(res.err).toContain("fix: reuse the team you created");
    expect(res.err).toContain("retryable: yes");
    expect(existsSync(path.join(home, "team.json"))).toBe(false);
  });
});

describe("seatledger_team_summary", () => {
  const call = (fetch: (u: string, i?: RequestInit) => Promise<Response>, env: NodeJS.ProcessEnv) =>
    handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "seatledger_team_summary", arguments: { since: "30d" } },
      },
      { home: freshHome(), env, fetch },
    ) as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;

  it("without a key returns NO_TEAM_KEY and makes no request", async () => {
    const svc = fakeService(() => ({ body: {} }));
    const res = await call(svc.fetch, {});
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent).toMatchObject({ code: "NO_TEAM_KEY", retryable: false });
    expect(svc.calls).toHaveLength(0);
  });

  it("with a key reads the team ledger, read-only", async () => {
    const svc = fakeService(() => ({ body: { totals: { requests: 7 }, findings: [] } }));
    const res = await call(svc.fetch, {
      SEATLEDGER_KEY: JOINED.key,
      SEATLEDGER_URL: "https://preview.seatledger.test",
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toMatchObject({ view: "team", totals: { requests: 7 } });
    expect(svc.calls[0]).toMatchObject({
      url: "https://preview.seatledger.test/api/seatledger/v1/summary?since=30d",
      method: "GET",
      auth: `Bearer ${JOINED.key}`,
    });
  });
});
