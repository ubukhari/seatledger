/**
 * `seatledger push`, `seatledger team join` and `seatledger team`: the only commands that make a
 * network request, and only to the team ledger the developer joined.
 */
import { dayKey, startOfDay } from "./ledger.js";
import { load, type LoadOptions } from "./load.js";
import { buildPushPayload, splitPayload, type PushAnswer, type PushPayload } from "./push.js";
import { dailySeries, rateReport } from "./rates.js";
import {
  callApi,
  DEFAULT_URL,
  defaultHandle,
  inviteBase,
  readTeamConfig,
  savedTeam,
  teamFile,
  TeamApiError,
  validHandle,
  writeTeamConfig,
  type FetchLike,
  type TeamConfig,
} from "./team.js";

export interface TeamContext {
  home: string;
  now: number;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  loadOptions: LoadOptions;
}

export class TeamUsage extends Error {}

const RATES_CONTEXT_DAYS = 90;
/** With no earlier push: as far back as any plan keeps (13 months), within the service's limit. */
const FIRST_PUSH_DAYS = 400;

function notOnTeam(): TeamUsage {
  return new TeamUsage(
    "not on a team yet: run `seatledger team join <invite link> --as <name>`, or `seatledger team create` to start one, or set SEATLEDGER_KEY",
  );
}

export interface PushPlan {
  url: string;
  since: number;
  payloads: PushPayload[];
}

/** What a push would send, without sending it. */
export async function planPush(
  ctx: TeamContext,
  opts: { since?: number; projectNames?: boolean },
): Promise<PushPlan> {
  const cfg = readTeamConfig(ctx.home, ctx.env);
  const url = cfg?.url ?? (ctx.env.SEATLEDGER_URL?.trim() || DEFAULT_URL);
  const since =
    opts.since ??
    (cfg?.lastPushDay
      ? startOfDay(Date.parse(`${cfg.lastPushDay}T12:00:00`), 2)
      : startOfDay(ctx.now, FIRST_PUSH_DAYS - 1));
  const loaded = await load({
    ...ctx.loadOptions,
    since: Math.min(since, startOfDay(ctx.now, RATES_CONTEXT_DAYS - 1)),
  });
  const rates = rateReport(dailySeries(loaded.requests, loaded.quota));
  const payload = buildPushPayload(loaded, {
    since,
    now: ctx.now,
    projectNames: opts.projectNames ?? false,
    rates,
  });
  return { url, since, payloads: splitPayload(payload) };
}

export interface PushOutcome {
  url: string;
  pushes: PushAnswer[];
}

export async function runPush(ctx: TeamContext, plan: PushPlan): Promise<PushOutcome> {
  const cfg = readTeamConfig(ctx.home, ctx.env);
  if (!cfg) throw notOnTeam();
  const pushes: PushAnswer[] = [];
  for (const p of plan.payloads)
    pushes.push(
      await callApi<PushAnswer>(cfg.url, "POST", "/api/seatledger/v1/push", {
        key: cfg.key,
        body: p,
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      }),
    );
  // Remember where to start next time, in the saved file only (never when the key is from env).
  const saved = savedTeam(ctx.home);
  if (saved?.key && saved.key === cfg.key && pushes.length > 0)
    writeTeamConfig(ctx.home, { ...(saved as TeamConfig), lastPushDay: dayKey(ctx.now) });
  return { url: cfg.url, pushes };
}

export function renderPush(o: PushOutcome): string {
  if (o.pushes.length === 0)
    return "Nothing to push: no coding-agent requests on this machine in that range.";
  const last = o.pushes[o.pushes.length - 1]!;
  const sum = (f: (a: PushAnswer) => number) => o.pushes.reduce((n, a) => n + f(a), 0);
  const skipped = o.pushes.flatMap((a) => a.days_skipped);
  const lines = [
    `Pushed ${sum((a) => a.days_replaced)} days (${sum((a) => a.rows_stored)} rows) to ${o.url} as ${last.member}, plan ${last.plan} (${last.history_days} days of history, from ${last.history_start}).`,
  ];
  if (skipped.length)
    lines.push(
      `${skipped.length} day${skipped.length === 1 ? "" : "s"} older than the plan keeps were not stored.`,
    );
  const f = last.findings;
  if (f.received)
    lines.push(
      `Rate findings: ${f.received} sent, ${f.new} new to the team ledger, ${f.seen_before} seen before.`,
    );
  if (last.alerts.alerted)
    lines.push(`Alerted the team owner (email: ${last.alerts.email ?? "none"}).`);
  if (last.alerts.dashboard_only)
    lines.push(
      "Findings are on the dashboard; email and Slack alerts come with Team and Business.",
    );
  return lines.join("\n");
}

export function renderDryRun(plan: PushPlan): string {
  const head = `seatledger push --dry-run: nothing was sent. ${plan.payloads.length === 0 ? "There is nothing to push." : `This is exactly what would be POSTed to ${plan.url}/api/seatledger/v1/push${plan.payloads.length > 1 ? ` in ${plan.payloads.length} requests` : ""}:`}`;
  return [head, ...plan.payloads.map((p) => JSON.stringify(p, null, 2))].join("\n");
}

export interface Joined {
  team_id: string;
  team: string;
  member: string;
  key: string;
  plan: string;
}

export async function runJoin(
  ctx: TeamContext,
  invite: string | undefined,
  opts: { as?: string; force?: boolean; url?: string },
): Promise<{ joined: Joined; file: string; url: string }> {
  if (!invite)
    throw new TeamUsage("team join needs the invite link: seatledger team join <link> --as <name>");
  const member = opts.as ?? defaultHandle();
  if (!validHandle(member))
    throw new TeamUsage(`--as takes a name of a-z, 0-9, . _ - (up to 32), not "${member}"`);
  const existing = savedTeam(ctx.home);
  if (existing?.key && !opts.force)
    throw new TeamUsage(
      `already on ${existing.team ?? "a team"} as ${existing.member ?? "?"} (${teamFile(ctx.home)}); pass --force to replace that key`,
    );
  const url = inviteBase(invite, opts.url ?? (ctx.env.SEATLEDGER_URL?.trim() || DEFAULT_URL));
  const joined = await callApi<Joined>(url, "POST", "/api/seatledger/v1/join", {
    body: { invite, member },
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  const file = writeTeamConfig(ctx.home, {
    url,
    key: joined.key,
    teamId: joined.team_id,
    team: joined.team,
    member: joined.member,
  });
  return { joined, file, url };
}

// ---- team create ------------------------------------------------------------------------------

/** The service's rule for a team name (apps/agentcheck seatledger/_lib/protocol.ts). */
const TEAM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._&'-]{0,59}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateOptions {
  name?: string;
  email?: string;
  as?: string;
  force?: boolean;
}

/** What `team create` would POST, and where; `--dry-run` prints exactly this. */
export interface CreatePlan {
  url: string;
  route: "/api/seatledger/v1/teams";
  body: { accept_terms: true; name?: string; member?: string; owner_email?: string };
  saveTo: string;
  terms: string;
}

/** The service's answer to POST /api/seatledger/v1/teams. */
export interface Created {
  team_id: string;
  name: string;
  plan: string;
  developers: number;
  history_days: number;
  owner_key: string;
  member: string;
  invite_url: string;
}

export interface CreateOutcome {
  created: Omit<Created, "owner_key">;
  url: string;
  file: string;
  dashboard: string;
  terms: string;
  /** SEATLEDGER_KEY is set, so it, not the saved owner key, is what push and team use */
  envKeyShadows: boolean;
}

const invalid = (field: string, cause: string, fix: string) =>
  new TeamApiError(`INVALID_${field}`, cause, fix, false);

/** Checks the flags the way the service will, so a bad name fails before anything is sent. */
export function planCreate(ctx: TeamContext, opts: CreateOptions): CreatePlan {
  const body: CreatePlan["body"] = { accept_terms: true };
  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!TEAM_NAME.test(name))
      throw invalid(
        "NAME",
        `--name "${opts.name}" is not a team name: up to 60 letters, digits, spaces and . _ & ' -, starting with a letter or digit`,
        'pass a plain name, e.g. --name "Acme platform"',
      );
    body.name = name;
  }
  if (opts.as !== undefined) {
    if (!validHandle(opts.as))
      throw invalid(
        "MEMBER",
        `--as "${opts.as}" is not a developer name: a-z, 0-9, . _ - (up to 32), starting with a letter or digit`,
        "pass a short lower-case name, e.g. --as alice",
      );
    body.member = opts.as;
  }
  if (opts.email !== undefined) {
    const email = opts.email.trim();
    if (!EMAIL.test(email) || email.length > 254)
      throw invalid(
        "EMAIL",
        `--email "${opts.email}" is not an email address`,
        "pass the address rate-change alerts should go to on a paid plan, e.g. --email lead@example.com",
      );
    body.owner_email = email;
  }
  const existing = savedTeam(ctx.home);
  if (existing?.key && !opts.force)
    throw new TeamApiError(
      "ALREADY_ON_TEAM",
      `this machine is already on ${existing.team ?? "a team"} as ${existing.member ?? "?"} (${teamFile(ctx.home)})`,
      "run `seatledger team` to see that team; pass --force to replace its key with the new team's owner key",
      false,
    );
  const url = (ctx.env.SEATLEDGER_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
  return {
    url,
    route: "/api/seatledger/v1/teams",
    body,
    saveTo: teamFile(ctx.home),
    terms: `${url}/terms`,
  };
}

/** Creates the team, then saves its owner key exactly as `team join` saves a developer key. */
export async function runCreate(ctx: TeamContext, plan: CreatePlan): Promise<CreateOutcome> {
  const created = await callApi<Created>(plan.url, "POST", plan.route, {
    body: plan.body,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  if (typeof created.owner_key !== "string" || typeof created.invite_url !== "string")
    throw new TeamApiError(
      "BAD_RESPONSE",
      `POST ${plan.route} did not return an owner key and an invite link`,
      "check SEATLEDGER_URL points at the seatledger service",
      false,
    );
  const file = writeTeamConfig(ctx.home, {
    url: plan.url,
    key: created.owner_key,
    teamId: created.team_id,
    team: created.name,
    member: created.member,
  });
  return {
    // everything the service said except the key, which is saved and never printed
    created: {
      team_id: created.team_id,
      name: created.name,
      plan: created.plan,
      developers: created.developers,
      history_days: created.history_days,
      member: created.member,
      invite_url: created.invite_url,
    },
    url: plan.url,
    file,
    dashboard: `${plan.url}/seatledger/dashboard?ref=cli`,
    terms: plan.terms,
    envKeyShadows: Boolean(ctx.env.SEATLEDGER_KEY?.trim()),
  };
}

const planName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);

export function renderCreate(o: CreateOutcome): string {
  const c = o.created;
  const history = c.history_days >= 365 ? "13 months" : `${c.history_days} days`;
  return [
    `Created ${c.name} on seatledger ${planName(c.plan)} (${c.developers} developers, ${history} of history) at ${o.url}.`,
    `The owner key is in ${o.file}, readable by you only, and is also this machine's push key. It is not printed.`,
    ...(o.envKeyShadows
      ? [
          "SEATLEDGER_KEY is set in your environment and wins over the saved key: unset it to push to this team.",
        ]
      : []),
    "",
    "Send your teammates this invite link. Each runs, once:",
    `  npx seatledger team join ${c.invite_url} --as <name>`,
    "",
    "On this machine:",
    "  npx seatledger push --dry-run   # exactly what would be sent; sends nothing",
    "  npx seatledger push",
    "",
    `Dashboard: ${o.dashboard}`,
    `  Sign in with GitHub and attach this team with the owner key from ${o.file}.`,
    `Creating the team accepted the terms at ${o.terms}.`,
  ].join("\n");
}

export function renderCreateDryRun(plan: CreatePlan): string {
  return [
    `seatledger team create --dry-run: nothing was sent. This is exactly what would be POSTed to ${plan.url}${plan.route}:`,
    JSON.stringify(plan.body, null, 2),
    `The owner key it returns would be saved to ${plan.saveTo}, readable by you only.`,
    `Creating a team accepts the terms at ${plan.terms}.`,
  ].join("\n");
}

export async function teamStatus(ctx: TeamContext): Promise<unknown> {
  const cfg = readTeamConfig(ctx.home, ctx.env);
  if (!cfg) throw notOnTeam();
  return callApi(cfg.url, "GET", "/api/seatledger/v1/team", {
    key: cfg.key,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
}

export async function teamSummary(
  ctx: Pick<TeamContext, "home" | "env" | "fetch">,
  since?: string,
): Promise<unknown> {
  const cfg = readTeamConfig(ctx.home, ctx.env);
  if (!cfg)
    throw new TeamApiError(
      "NO_TEAM_KEY",
      "this machine has not joined a seatledger team",
      "run `npx seatledger team join <invite link> --as <name>` (the team owner has the link), or `npx seatledger team create` to start a team, or set SEATLEDGER_KEY",
      false,
    );
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return callApi(cfg.url, "GET", `/api/seatledger/v1/summary${q}`, {
    key: cfg.key,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
}
