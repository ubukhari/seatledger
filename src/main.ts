/**
 * `seatledger` — what your coding-agent seats and tokens bought, from your own machine.
 *
 *   seatledger                      today and the last 7 days
 *   seatledger report               a range by day, project, model or client
 *   seatledger rates                step changes in how requests use tokens
 *   seatledger limits [set|clear]   your own limits and the burn toward them
 *   seatledger mcp                  the same, as a read-only MCP server on stdio
 *   seatledger demo                 all of it on synthetic history, without reading yours
 *   seatledger team create | join   start a hosted team ledger, or join one
 *   seatledger team                 its plan and your seat
 *   seatledger push [--dry-run]     this machine's aggregates to that team ledger
 *
 * Reads local transcripts only. No telemetry, no account. The only network requests are
 * `team create`, `team join`, `team`, `push` and the `seatledger_team_summary` tool, to the team
 * ledger you created or joined. After the summary, `report` and `rates`, a terminal may show one
 * dim line about the team ledger, at most once a day (src/hint.ts); it is local text.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { runDemo } from "./demo.js";
import { GROUP_BY, type GroupBy } from "./ledger.js";
import {
  clearLimits,
  readLimits,
  setLimit,
  WINDOWS,
  type LimitScope,
  type LimitWindow,
} from "./limits.js";
import { load, type LoadOptions } from "./load.js";
import { serveStdio } from "./mcp.js";
import { seatledgerHome, sourceDirs } from "./paths.js";
import { teamHint, type HintKind } from "./hint.js";
import { renderLimits, renderRates, renderReport, renderSummary } from "./render.js";
import { DEFAULT_URL, TeamApiError, type FetchLike } from "./team.js";
import {
  planCreate,
  planPush,
  renderCreate,
  renderCreateDryRun,
  renderDryRun,
  renderPush,
  runCreate,
  runJoin,
  runPush,
  teamStatus,
  TeamUsage,
  type TeamContext,
} from "./team-commands.js";
import { CLIENTS } from "./types.js";
import { version } from "./version.js";
import { parseSince, ratesView, reportView, summaryView } from "./views.js";

const HELP = `seatledger ${version()} — what your coding-agent seats and tokens bought, from this machine

Usage
  seatledger                         today and the last 7 days, your limits, vendor readings
  seatledger report [options]        a range: --since 30d|2026-09-01  --by day|project|model|client
  seatledger rates [options]         step changes in tokens per request, cache use, tokens per turn
                                     and Codex's tokens per 1% of its 5-hour window (--since 90d)
  seatledger limits                  your limits and how fast you are burning toward them
  seatledger limits set --window 5h|weekly (--tokens N | --usd N) [--client claude-code|codex]
  seatledger limits clear [--window 5h|weekly] [--client claude-code|codex]
  seatledger mcp                     read-only MCP server on stdio: seatledger_usage_summary,
                                     seatledger_rate_changes, seatledger_team_summary
  seatledger demo                    the summary and rates on synthetic history (reads nothing of yours)

Team ledger (optional; the only commands that send anything)
  seatledger team create [--name <team>] [--email <alert address>] [--as <name>] [--dry-run]
                                     start a team (free for up to 3 developers): the owner key is
                                     saved to ~/.seatledger/team.json (0600); prints the invite link
                                     for teammates and the dashboard. --dry-run shows what would be
                                     sent. Creating a team accepts the terms at
                                     ${DEFAULT_URL}/terms
  seatledger team join <invite link> [--as <name>] [--force]
                                     join a team; your key is saved to ~/.seatledger/team.json (0600)
  seatledger team                    the team's plan and your seat
  seatledger push [--dry-run] [--since 30d] [--project-names]
                                     send this machine's daily aggregates: per day, client, client
                                     version and model, the request count, four token counts and
                                     API-equivalent dollars, and the rates findings as numbers.
                                     Never prompts, responses, file paths, or folder names unless
                                     --project-names. --dry-run prints exactly what would be sent.

Options
  --client claude-code|codex         one client only
  --model <id>                       rates: one model only
  --json                             machine-readable output
  --claude-dir <dir>                 Claude Code projects dir (default $CLAUDE_CONFIG_DIR/projects,
                                     ~/.claude/projects, ~/.config/claude/projects)
  --codex-dir <dir>                  Codex sessions dir (default $CODEX_HOME/sessions, ~/.codex/sessions)
  --no-cache                         do not read or write ~/.seatledger/cache-v1
  --quiet                            no team-ledger line (also SEATLEDGER_QUIET=1)
  -h, --help / -v, --version

After the summary, report and rates, a terminal shows at most one dim line a day about the team
ledger, and none once this machine is on a team, with --json, or when output is not a terminal.
--quiet or SEATLEDGER_QUIET=1 turns it off. It is printed here; nothing is sent.

Dollars are API-equivalent: the same tokens at the vendor's API list prices. Not your bill.
Nothing is sent anywhere unless you run team create, team join, team or push.
Team ledger: ${DEFAULT_URL}/seatledger?ref=cli
Source: https://github.com/agentwares/seatledger`;

class UsageError extends Error {}

function parseAmount(v: string, flag: string): number {
  const m = /^([\d_.,]+)\s*([kmb])?$/i.exec(v.trim());
  const n = m ? Number(m[1]!.replace(/[_,]/g, "")) : NaN;
  if (!m || !Number.isFinite(n) || n <= 0)
    throw new UsageError(`${flag} takes a positive number like 50000000, 50M or 1.5B, not "${v}"`);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return n * mult;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${flag} takes ${allowed.join(" | ")}, not "${value}"`);
  return value as T;
}

/** Where output goes; tests pass their own. `out.isTTY` decides whether the team line may show. */
export interface Io {
  out: { write(chunk: string): unknown; isTTY?: boolean };
  err: { write(chunk: string): unknown };
}

/** The team commands' network access; tests pass a fake. */
export interface MainDeps {
  fetch?: FetchLike;
}

export async function main(
  argv: string[],
  io: Io = { out: process.stdout, err: process.stderr },
  deps: MainDeps = {},
): Promise<number> {
  const print = (s: string) => io.out.write(s.endsWith("\n") ? s : s + "\n");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "dry-run": { type: "boolean" },
        "project-names": { type: "boolean" },
        as: { type: "string" },
        force: { type: "boolean" },
        name: { type: "string" },
        email: { type: "string" },
        quiet: { type: "boolean" },
        since: { type: "string" },
        by: { type: "string" },
        client: { type: "string" },
        model: { type: "string" },
        window: { type: "string" },
        tokens: { type: "string" },
        usd: { type: "string" },
        "min-requests": { type: "string" },
        json: { type: "boolean" },
        "claude-dir": { type: "string" },
        "codex-dir": { type: "string" },
        "no-cache": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    io.err.write(`seatledger: ${(err as Error).message}\nRun seatledger --help for usage.\n`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  if (flags.help) return (print(HELP), 0);
  if (flags.version) return (print(version()), 0);

  const [command = "summary", sub] = positionals;
  const home = seatledgerHome();
  // SEATLEDGER_NOW pins the clock (reproducible screenshots and tests); otherwise it is now.
  const fixedNow = process.env.SEATLEDGER_NOW ? Date.parse(process.env.SEATLEDGER_NOW) : NaN;
  const clockNow = () => (Number.isFinite(fixedNow) ? fixedNow : Date.now());
  const now = clockNow();
  const json = (v: unknown) => print(JSON.stringify(v, null, 2));
  /** The one line about the team ledger, when it may show (src/hint.ts). */
  const hint = (kind: HintKind) => {
    const line = teamHint(
      { home, now, env: process.env, tty: io.out.isTTY === true, quiet: flags.quiet ?? false },
      kind,
    );
    if (line) print(line);
  };

  try {
    const client = oneOf(flags.client, CLIENTS, "--client");
    const loadOpts: LoadOptions = {
      dirs: sourceDirs({ claudeDir: flags["claude-dir"], codexDir: flags["codex-dir"] }),
      cache: !flags["no-cache"],
      home,
      onRead: (n) => {
        if (n > 50 && !flags.json)
          io.err.write(
            `seatledger: reading ${n} transcripts (later runs reuse the counts kept in ${path.join(home, "cache-v1")})…\n`,
          );
      },
    };

    switch (command) {
      case "summary": {
        const loaded = await load(loadOpts);
        const v = summaryView(loaded, now, home, client);
        if (flags.json) json(v);
        else {
          print(renderSummary(v, now));
          hint("team");
        }
        return 0;
      }
      case "report": {
        const since = parseSince(flags.since ?? "30d", now);
        const by: GroupBy = oneOf(flags.by, GROUP_BY, "--by") ?? "day";
        const loaded = await load({ ...loadOpts, since });
        const v = reportView(loaded, now, by, since, client);
        if (flags.json) json(v);
        else {
          print(renderReport(v));
          hint("team");
        }
        return 0;
      }
      case "rates": {
        const since = parseSince(flags.since ?? "90d", now);
        const minRequests = flags["min-requests"]
          ? parseAmount(flags["min-requests"], "--min-requests")
          : undefined;
        const loaded = await load({ ...loadOpts, since });
        const v = ratesView(
          loaded,
          now,
          since,
          { client, model: flags.model },
          minRequests ? { minRequests } : {},
        );
        if (flags.json) json(v);
        else {
          print(renderRates(v));
          if (v.findings.length > 0) hint("rates");
        }
        return 0;
      }
      case "limits": {
        const window = oneOf(flags.window, WINDOWS, "--window") as LimitWindow | undefined;
        const scope: LimitScope = client ?? "all";
        if (sub === "set") {
          if (!window) throw new UsageError("limits set needs --window 5h or --window weekly");
          if ((flags.tokens === undefined) === (flags.usd === undefined))
            throw new UsageError("limits set needs exactly one of --tokens N or --usd N");
          const amount =
            flags.tokens !== undefined
              ? { tokens: parseAmount(flags.tokens, "--tokens") }
              : { usd: parseAmount(flags.usd!, "--usd") };
          setLimit(home, { window, client: scope, ...amount }, now);
        } else if (sub === "clear") {
          clearLimits(home, window, client);
        } else if (sub !== undefined) {
          throw new UsageError(`limits takes set or clear, not "${sub}"`);
        }
        const loaded = await load(loadOpts);
        const v = summaryView(loaded, now, home, client);
        if (flags.json)
          json({ limits: v.limits, vendorReadings: v.vendorReadings, stored: readLimits(home) });
        else print(renderLimits(v.limits, v.vendorReadings, now).join("\n"));
        return 0;
      }
      case "mcp": {
        await serveStdio({
          loadOptions: { ...loadOpts, onRead: undefined },
          home,
          now: clockNow,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        return 0;
      }
      case "push": {
        const ctx = teamContext(loadOpts);
        const plan = await planPush(ctx, {
          ...(flags.since ? { since: parseSince(flags.since, now) } : {}),
          projectNames: flags["project-names"] ?? false,
        });
        if (flags["dry-run"]) {
          if (flags.json) json(plan.payloads);
          else print(renderDryRun(plan));
          return 0;
        }
        const outcome = await runPush(ctx, plan);
        if (flags.json) json(outcome);
        else print(renderPush(outcome));
        return 0;
      }
      case "team": {
        const ctx = teamContext(loadOpts);
        if (sub === "create") {
          const plan = planCreate(ctx, {
            ...(flags.name !== undefined ? { name: flags.name } : {}),
            ...(flags.email !== undefined ? { email: flags.email } : {}),
            ...(flags.as !== undefined ? { as: flags.as } : {}),
            ...(flags.force ? { force: true } : {}),
          });
          if (flags["dry-run"]) {
            if (flags.json)
              json({
                dry_run: true,
                method: "POST",
                url: plan.url + plan.route,
                body: plan.body,
                saves_to: plan.saveTo,
                terms: plan.terms,
              });
            else print(renderCreateDryRun(plan));
            return 0;
          }
          const created = await runCreate(ctx, plan);
          if (flags.json)
            json({
              ...created.created,
              saved_to: created.file,
              url: created.url,
              dashboard_url: created.dashboard,
              terms: created.terms,
            });
          else print(renderCreate(created));
          return 0;
        }
        if (sub === "join") {
          const r = await runJoin(ctx, positionals[2], {
            ...(flags.as !== undefined ? { as: flags.as } : {}),
            ...(flags.force ? { force: true } : {}),
          });
          if (flags.json) json({ ...r.joined, key: undefined, saved_to: r.file, url: r.url });
          else
            print(
              `Joined ${r.joined.team} as ${r.joined.member} (plan ${r.joined.plan}) at ${r.url}.\n` +
                `Your key is in ${r.file}, readable by you only.\n` +
                "Next: `npx seatledger push --dry-run` shows exactly what would be sent; `npx seatledger push` sends it.",
            );
          return 0;
        }
        if (sub !== undefined)
          throw new UsageError(`team takes create or join, or nothing; not "${sub}"`);
        const status = await teamStatus(ctx);
        if (flags.json) json(status);
        else print(renderTeam(status));
        return 0;
      }
      case "demo": {
        const demo = await runDemo();
        if (flags.json) json({ summary: demo.summary, rates: demo.rates });
        else
          print(
            `Synthetic history: nothing below is yours.\n\n${demo.summaryText}\n\n${demo.ratesText}`,
          );
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (
      err instanceof UsageError ||
      err instanceof TeamUsage ||
      (err instanceof Error && err.message.startsWith("--since"))
    ) {
      io.err.write(`seatledger: ${err.message}\nRun seatledger --help for usage.\n`);
      return 2;
    }
    if (err instanceof TeamApiError) {
      if (flags.json) io.err.write(JSON.stringify(err.toJSON(), null, 2) + "\n");
      else
        io.err.write(
          `seatledger: ${err.code}: ${err.cause_}\n  fix: ${err.fix}\n  retryable: ${err.retryable ? "yes" : "no"}\n`,
        );
      return 1;
    }
    io.err.write(`seatledger: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  function teamContext(loadOptions: LoadOptions): TeamContext {
    return {
      home,
      now,
      env: process.env,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      loadOptions,
    };
  }
}

/** `seatledger team` as two lines a person reads. */
function renderTeam(status: unknown): string {
  const s = status as {
    name?: string;
    plan?: { name?: string; developers?: number; history_days?: number };
    seats_used?: number;
    you?: { member?: string; role?: string };
    members?: { member: string; seat: number; can_push: boolean }[];
    dashboard_url?: string;
  };
  const me = s.members?.find((m) => m.member === s.you?.member);
  return [
    `${s.name ?? "Your team"}: seatledger ${s.plan?.name ?? "?"} — ${s.seats_used ?? "?"} of ${s.plan?.developers ?? "?"} developers, ${s.plan?.history_days ?? "?"} days of history.`,
    s.you?.member
      ? `You are ${s.you.member} (${s.you.role}), seat ${me?.seat ?? "?"}${me && !me.can_push ? " — past the plan's cap, so pushes are refused until the owner upgrades or frees a seat" : ""}.`
      : "",
    s.dashboard_url ? `Dashboard (team owner): ${withRef(s.dashboard_url)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Links the CLI prints to the seatledger pages carry ?ref=cli, which the page's beacon records. */
function withRef(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("ref", "cli");
    return u.toString();
  } catch {
    return url;
  }
}
