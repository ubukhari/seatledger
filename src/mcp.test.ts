import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMessage, PROTOCOL_VERSIONS, TOOLS, type McpContext } from "./mcp.js";
import { writeSyntheticHistory, type SyntheticResult } from "./synthetic.js";

let root: string;
let synth: SyntheticResult;
let ctx: McpContext;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "seatledger-mcp-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src") });
  ctx = {
    loadOptions: {
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
    },
    home: path.join(root, "home"),
    now: () => synth.now,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `id: null` sends a notification. */
const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  handleMessage(
    { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) },
    ctx,
  );

describe("tool definitions, as an agent reads them", () => {
  // The same checks as scripts/check-tool-schemas.mjs applies to every served tool in this repo.
  for (const tool of TOOLS) {
    it(`${tool.name}: namespaced, described, strict, read-only`, () => {
      expect(tool.name).toMatch(/^seatledger_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThanOrEqual(40);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const [field, spec] of Object.entries(tool.inputSchema.properties)) {
        expect(typeof spec.description, field).toBe("string");
        expect((spec.description as string).length, field).toBeGreaterThan(20);
      }
      for (const r of tool.inputSchema.required ?? [])
        expect(tool.inputSchema.properties).toHaveProperty(r);
      // all four MCP hints explicit: OpenAI refuses a server that leaves one unset (BUG-8)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // only the hosted team ledger is outside this machine
        openWorldHint: tool.name === "seatledger_team_summary",
      });
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    });
    it(`${tool.name}: describes, does not instruct`, () => {
      expect(tool.description).not.toMatch(
        /\b(call this|use this tool|you should|always call|before calling)\b/i,
      );
    });
  }
});

describe("protocol", () => {
  it("negotiates the client's version when supported, else offers the latest it speaks", async () => {
    for (const v of PROTOCOL_VERSIONS) {
      const res = (await rpc("initialize", {
        protocolVersion: v,
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      })) as {
        result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object };
      };
      expect(res.result.protocolVersion).toBe(v);
      expect(res.result.serverInfo.name).toBe("seatledger");
      expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    }
    const future = (await rpc("initialize", { protocolVersion: "2099-01-01" })) as {
      result: { protocolVersion: string };
    };
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("answers the 2026-07-28 discovery probe with method-not-found, so dual-era clients fall back", async () => {
    expect(await rpc("server/discover", { _meta: {} })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found: server/discover" },
    });
  });

  it("does not answer notifications, and rejects an unknown tool as a protocol error", async () => {
    expect(await rpc("notifications/initialized", undefined, null)).toBeUndefined();
    const res = (await rpc("tools/call", { name: "nope", arguments: {} })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32602);
  });

  it("returns invalid arguments as a tool error with code, cause, fix and retryable", async () => {
    for (const args of [
      { since: "last tuesday" },
      { group_by: "week" },
      { colour: "red" },
      { client: 3 },
    ]) {
      const res = (await rpc("tools/call", {
        name: "seatledger_usage_summary",
        arguments: args,
      })) as {
        result: { isError: boolean; structuredContent: Record<string, unknown> };
      };
      expect(res.result.isError).toBe(true);
      expect(res.result.structuredContent).toMatchObject({
        code: "INVALID_INPUT",
        retryable: false,
      });
      expect(typeof res.result.structuredContent.cause).toBe("string");
      expect(typeof res.result.structuredContent.fix).toBe("string");
    }
  });
});

describe("with the official MCP client", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serverSide.onmessage = (msg: JSONRPCMessage) => {
      void handleMessage(msg, ctx).then((res) => {
        if (res !== undefined) void serverSide.send(res as JSONRPCMessage);
      });
    };
    await serverSide.start();
    const client = new Client({ name: "seatledger-test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("lists the tools and reads the summary, a grouped report and the rate changes", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "seatledger_usage_summary",
      "seatledger_rate_changes",
      "seatledger_plan_compare",
      "seatledger_team_summary",
    ]);

    const summary = await client.callTool({ name: "seatledger_usage_summary", arguments: {} });
    expect(summary.isError).toBe(false);
    const s = summary.structuredContent as {
      view: string;
      today: { totals: { requests: number } };
      apiEquivalentNote: string;
    };
    expect(s.view).toBe("summary");
    expect(s.today.totals.requests).toBeGreaterThan(0);
    expect(s.apiEquivalentNote).toMatch(/^API-equivalent/);

    const byProject = await client.callTool({
      name: "seatledger_usage_summary",
      arguments: { since: "14d", group_by: "project" },
    });
    const r = byProject.structuredContent as { view: string; rows: { key: string }[] };
    expect(r.view).toBe("report");
    expect(r.rows.map((x) => x.key).sort()).toEqual(["api-server", "infra", "webapp"]);

    const rates = await client.callTool({
      name: "seatledger_rate_changes",
      arguments: { client: "claude-code" },
    });
    const f = rates.structuredContent as {
      findings: { date: string; version: string }[];
      method: string;
    };
    expect(f.findings.map((x) => [x.date, x.version])).toEqual([["2026-09-30", "2.1.230"]]);
    expect(f.method).toMatch(/at least 20 requests/);
    await client.close();
  });
});

describe("seatledger_plan_compare", () => {
  const call = (args: unknown) =>
    rpc("tools/call", { name: "seatledger_plan_compare", arguments: args }) as Promise<{
      result: { isError: boolean; structuredContent: Record<string, unknown> };
    }>;

  it("is strict about plans: an array of known ids or groups, nothing else", () => {
    const tool = TOOLS.find((t) => t.name === "seatledger_plan_compare")!;
    expect(tool.inputSchema.properties.plans).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string" },
    });
    const allowed = (tool.inputSchema.properties.plans!.items as { enum: string[] }).enum;
    expect(allowed).toEqual(expect.arrayContaining(["claude-max-5x", "codex", "copilot"]));
    expect(tool.annotations.openWorldHint).toBe(false);
    expect(tool.description).toMatch(/never invented/);
    expect(tool.description).toMatch(/no local logs/);
  });

  it("prices this machine's last 30 days on every plan, with sources and dates", async () => {
    const res = await call({});
    expect(res.result.isError).toBe(false);
    const v = res.result.structuredContent as {
      view: string;
      period: { days: number };
      workloads: { client: string }[];
      quotes: { plan: string; kind: string }[];
      answer: { byClient: { client: string }[] };
      sources: { plans: { seen: string }[] };
    };
    expect(v.view).toBe("plan_compare");
    expect(v.period.days).toBe(30);
    expect(v.workloads.map((w) => w.client)).toEqual(["claude-code", "codex"]);
    expect(v.quotes.find((q) => q.plan === "claude-max-5x")!.kind).toBe("allowance-unpublished");
    expect(v.quotes.find((q) => q.plan === "chatgpt-plus")!.kind).toBe("measured");
    expect(v.answer.byClient).toHaveLength(2);
    for (const p of v.sources.plans) expect(p.seen).toMatch(/^2026-/);
  });

  it("narrows to the plans asked for, and takes a range", async () => {
    const res = await call({ plans: ["copilot", "anthropic-api"], since: "14d" });
    const v = res.result.structuredContent as {
      plansCompared: string[];
      period: { days: number };
    };
    expect(v.plansCompared).toEqual([
      "anthropic-api",
      "copilot-pro",
      "copilot-pro-plus",
      "copilot-max",
    ]);
    expect(v.period.days).toBeGreaterThan(13);
    expect(v.period.days).toBeLessThan(14);
  });

  it("refuses an unknown plan, an empty list or a string, with code, cause and fix", async () => {
    for (const args of [{ plans: ["claude-ultra"] }, { plans: [] }, { plans: "claude" }]) {
      const res = await call(args);
      expect(res.result.isError).toBe(true);
      expect(res.result.structuredContent).toMatchObject({
        code: "INVALID_INPUT",
        retryable: false,
      });
      expect(String(res.result.structuredContent.fix)).toMatch(/claude-max-5x|omit/);
    }
  });
});
