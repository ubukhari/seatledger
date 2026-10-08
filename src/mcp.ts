/**
 * `seatledger mcp`: a read-only MCP server over stdio, so an agent can answer "what has this
 * machine spent today?" and "did the rate change?" from the same local record the CLI reads.
 *
 * Implemented here rather than on the MCP SDK so the package has no runtime dependencies. It
 * speaks the initialize-based protocol revisions (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05):
 * newline-delimited JSON-RPC on stdin/stdout, `initialize`, `ping`, `tools/list`, `tools/call`.
 * Any other method, including the 2026-07-28 `server/discover` probe, answers -32601, which is
 * what tells a dual-era client to fall back to `initialize`. Nothing but protocol goes to stdout.
 *
 * The tools return whatever the CLI would print, as data. Whatever an agent receives goes to its
 * model provider like any other tool result; project folder names are part of it.
 *
 * Two tools read this machine and make no request. `seatledger_team_summary` reads the hosted
 * team ledger this machine created or joined (`seatledger team create` / `team join`), with the
 * key saved for it; it is the only tool that opens a network connection, and only to that ledger.
 */
import { createInterface } from "node:readline";
import { load, type LoadOptions } from "./load.js";
import { seatledgerHome } from "./paths.js";
import { GROUP_BY, type GroupBy } from "./ledger.js";
import { parseSince, ratesView, reportView, summaryView } from "./views.js";
import { TeamApiError, type FetchLike } from "./team.js";
import { teamSummary } from "./team-commands.js";
import { CLIENTS, type Client } from "./types.js";
import { version } from "./version.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const SINCE_PATTERN = "^(\\d{4}-\\d{2}-\\d{2}|\\d{1,4}[dDwW])$";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    title: string;
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    /** true only for the tool that reads the hosted team ledger */
    openWorldHint: boolean;
  };
}

const annotations = (title: string, openWorld = false): ToolDefinition["annotations"] => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

const clientProp = {
  type: "string",
  enum: [...CLIENTS],
  description:
    "Only this coding-agent client: `claude-code` (Claude Code transcripts) or `codex` (Codex CLI rollouts). Omitted: both.",
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "seatledger_usage_summary",
    title: "Coding-agent usage on this machine",
    description:
      "Tokens and API-equivalent dollars from this machine's Claude Code and Codex transcripts, read locally. With no arguments: today by client and model, the last 7 days by day, progress against limits the user recorded with `seatledger limits set`, and the latest rate-limit readings Codex wrote to its own rollouts. With `since` or `group_by`: one table for that range, grouped by day, project folder, model or client. Tokens count input, output, cache reads and cache writes. API-equivalent means the same tokens at the vendor's API list prices (dated table, sources included); it is not what the user was billed, since a seat is a flat fee with an allowance. Requests on models without a list price are counted in tokens and listed as unpriced.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: SINCE_PATTERN,
          description:
            "Start of the range: a local date (`2026-09-01`) or a span back from today (`30d`, `12w`). Omitted with `group_by` set: 30d.",
        },
        group_by: {
          type: "string",
          enum: [...GROUP_BY],
          description:
            "Group the range by local `day`, `project` (working-directory folder name), `model` or `client`. Omitted with `since` set: day.",
        },
        client: clientProp,
      },
      additionalProperties: false,
    },
    annotations: annotations("Coding-agent usage on this machine"),
  },
  {
    name: "seatledger_rate_changes",
    title: "Token rate changes",
    description:
      "Step changes in how this machine's coding-agent requests use tokens, per client and model: tokens per request, cache-read share of prompt tokens, cache writes per cache read, tokens per user turn, the share of Claude Code cache writes made at the 1-hour lifetime, and Codex tokens per 1% of its 5-hour window. Each finding has the date it starts, the client version in use and whether that was its first day, before and after medians, and what the change is consistent with. It sees only this machine's requests, not the vendor's servers, so it never states a cause. Also returns each model's current baseline and the method. Days with fewer than 20 requests are left out.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: SINCE_PATTERN,
          description:
            "Start of the history to examine: a local date (`2026-07-01`) or a span back from today (`90d`). Omitted: 90d.",
        },
        client: clientProp,
        model: {
          type: "string",
          minLength: 1,
          description:
            "Only this model id, exactly as the client records it (e.g. `claude-opus-5-5`, `gpt-5.6-sol`). Omitted: every model.",
        },
      },
      additionalProperties: false,
    },
    annotations: annotations("Token rate changes"),
  },
  {
    name: "seatledger_team_summary",
    title: "Team coding-agent ledger",
    description:
      "The hosted seatledger team ledger this machine created or joined (`seatledger team create` or `seatledger team join`): what the team's coding-agent seats and tokens bought, from every developer's pushed daily aggregates. Returns team totals; tables by day, month, developer, model and client; and the rate-change findings feed, each with its date, the developer, the client version and whether that was its first day, and what the step is consistent with. A developer's key sees every team total and only their own row in `by_developer`; the owner key sees every developer. Dollars are API-equivalent (the same tokens at API list prices), not what anyone was billed. History is as long as the team's plan keeps (Free 30 days, Team and Business 13 months). Needs the key `seatledger team create` or `team join` saved in ~/.seatledger/team.json, or SEATLEDGER_KEY; without one it returns NO_TEAM_KEY. This tool makes one HTTPS request to that ledger and changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: "^(\\d{4}-\\d{2}-\\d{2}|\\d{1,4}[dDwWmM])$",
          description:
            "Start of the range: a date (`2026-09-01`) or a span back from today (`30d`, `12w`, `13m`). Never earlier than the plan keeps. Omitted: everything the plan keeps.",
        },
      },
      additionalProperties: false,
    },
    annotations: annotations("Team coding-agent ledger", true),
  },
];

export interface ToolError {
  code: string;
  cause: string;
  fix: string;
  retryable: boolean;
}

class InvalidInput extends Error {
  constructor(
    readonly cause_: string,
    readonly fix: string,
  ) {
    super(cause_);
  }
}

type Args = Record<string, unknown>;

function checkArgs(tool: ToolDefinition, args: unknown): Args {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new InvalidInput("arguments must be an object", "Pass an object, or omit arguments.");
  const props = tool.inputSchema.properties;
  for (const [k, v] of Object.entries(args)) {
    const spec = props[k];
    if (!spec)
      throw new InvalidInput(
        `unknown argument \`${k}\``,
        `Use only: ${Object.keys(props).join(", ")}.`,
      );
    if (typeof v !== "string")
      throw new InvalidInput(`\`${k}\` must be a string`, `Pass \`${k}\` as a string.`);
    const allowed = spec.enum as string[] | undefined;
    if (allowed && !allowed.includes(v))
      throw new InvalidInput(`\`${k}\` is "${v}"`, `Use one of: ${allowed.join(", ")}.`);
    if (typeof spec.pattern === "string" && !new RegExp(spec.pattern).test(v))
      throw new InvalidInput(
        `\`${k}\` is "${v}"`,
        "Use a local date like 2026-09-01 or a span like 30d or 12w.",
      );
    if (spec.minLength && v.length < Number(spec.minLength))
      throw new InvalidInput(`\`${k}\` is empty`, `Omit \`${k}\` or give a value.`);
  }
  return args as Args;
}

export interface McpContext {
  loadOptions?: Omit<LoadOptions, "since">;
  now?: () => number;
  home?: string;
  /** for `seatledger_team_summary` only; tests pass a fake */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  ctx: McpContext = {},
): Promise<{ structured: Record<string, unknown>; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const now = ctx.now?.() ?? Date.now();
  const home = ctx.home ?? ctx.loadOptions?.home ?? seatledgerHome();
  try {
    const args = checkArgs(tool, rawArgs);
    if (name === "seatledger_team_summary") {
      const summary = await teamSummary(
        { home, env: ctx.env ?? process.env, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) },
        typeof args.since === "string" ? args.since : undefined,
      );
      return { structured: { view: "team", ...(summary as object) }, isError: false };
    }
    const client = args.client as Client | undefined;
    const since = typeof args.since === "string" ? parseSince(args.since, now) : undefined;
    if (name === "seatledger_usage_summary") {
      if (since === undefined && args.group_by === undefined) {
        const loaded = await load({ ...ctx.loadOptions, home });
        return {
          structured: { view: "summary", ...summaryView(loaded, now, home, client) },
          isError: false,
        };
      }
      const from = since ?? parseSince("30d", now);
      const loaded = await load({ ...ctx.loadOptions, home, since: from });
      const by = (args.group_by as GroupBy | undefined) ?? "day";
      return {
        structured: { view: "report", ...reportView(loaded, now, by, from, client) },
        isError: false,
      };
    }
    const from = since ?? parseSince("90d", now);
    const loaded = await load({ ...ctx.loadOptions, home, since: from });
    const model = args.model as string | undefined;
    return { structured: { ...ratesView(loaded, now, from, { client, model }) }, isError: false };
  } catch (err) {
    const body: ToolError =
      err instanceof InvalidInput
        ? { code: "INVALID_INPUT", cause: err.cause_, fix: err.fix, retryable: false }
        : err instanceof TeamApiError
          ? err.toJSON()
          : {
              code: "INTERNAL",
              cause: err instanceof Error ? err.message : String(err),
              fix: "Run `npx seatledger` in a terminal to see the same error with its context, and report it at https://github.com/agentwares/seatledger/issues.",
              retryable: false,
            };
    return { structured: { ...body }, isError: true };
  }
}

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const INSTRUCTIONS =
  "seatledger reads this machine's Claude Code and Codex transcripts locally and reports tokens, API-equivalent dollars, the user's own limits and step changes in token rates. Read-only. seatledger_usage_summary and seatledger_rate_changes make no network calls; seatledger_team_summary reads the hosted team ledger this machine created or joined, with its saved key.";

export async function handleMessage(msg: unknown, ctx: McpContext): Promise<unknown> {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== undefined,
    );
    return out.length ? out : undefined;
  }
  const req = (msg && typeof msg === "object" ? msg : {}) as Request;
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  // A response to a request we never send: nothing to answer.
  if (!("method" in req) && ("result" in req || "error" in req)) return undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : undefined;
  }
  if (!hasId) return undefined; // notifications: initialized, cancelled, …
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<
    string,
    unknown
  >;
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "seatledger", title: "seatledger", version: version() },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
        return error(
          -32602,
          `Unknown tool: ${String(name)}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError,
        },
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. */
export async function serveStdio(ctx: McpContext = {}): Promise<void> {
  const write = (v: unknown) => {
    if (v !== undefined) process.stdout.write(JSON.stringify(v) + "\n");
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const p = handleMessage(msg, ctx)
      .then(write)
      .catch((err: unknown) => {
        process.stderr.write(
          `seatledger mcp: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
