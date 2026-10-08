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
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
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
