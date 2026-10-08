/**
 * The hosted team ledger, from the developer's side: the key `seatledger team join` saves, and the
 * one HTTP client `push`, `team` and the `seatledger_team_summary` tool use. Nothing here runs
 * unless one of those is asked for; every other command stays local and makes no request.
 *
 * The key lives in `~/.seatledger/team.json`, readable by you only (mode 0600), or in
 * `SEATLEDGER_KEY`. `SEATLEDGER_URL` points the CLI at another deployment (a preview, say).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { version } from "./version.js";

export const DEFAULT_URL = "https://agentwares-agentcheck.vercel.app";
const TIMEOUT_MS = 30_000;

export interface TeamConfig {
  url: string;
  key: string;
  teamId?: string;
  team?: string;
  member?: string;
  /** the last local day a push succeeded for; the next push starts two days before it */
  lastPushDay?: string;
}

export const teamFile = (home: string): string => path.join(home, "team.json");

/** The saved team, with SEATLEDGER_KEY / SEATLEDGER_URL taking precedence. null with no key. */
export function readTeamConfig(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): TeamConfig | null {
  let saved: Partial<TeamConfig> = {};
  const file = teamFile(home);
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Partial<TeamConfig>;
    } catch {
      saved = {};
    }
  }
  const key = env.SEATLEDGER_KEY?.trim() || saved.key;
  if (!key) return null;
  const url = (env.SEATLEDGER_URL?.trim() || saved.url || DEFAULT_URL).replace(/\/+$/, "");
  return { ...saved, key, url };
}

/** Written readable by you only: the key is a credential. */
export function writeTeamConfig(home: string, cfg: TeamConfig): string {
  mkdirSync(home, { recursive: true });
  const file = teamFile(home);
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function savedTeam(home: string): Partial<TeamConfig> | null {
  const file = teamFile(home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<TeamConfig>;
  } catch {
    return null;
  }
}

/** A refusal from the service (or the network), in the service's own shape. */
export class TeamApiError extends Error {
  constructor(
    readonly code: string,
    readonly cause_: string,
    readonly fix: string,
    readonly retryable: boolean,
    readonly status = 0,
  ) {
    super(`${code}: ${cause_}`);
  }
  toJSON() {
    return { code: this.code, cause: this.cause_, fix: this.fix, retryable: this.retryable };
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function callApi<T>(
  base: string,
  method: "GET" | "POST",
  route: string,
  opts: { key?: string; body?: unknown; fetch?: FetchLike } = {},
): Promise<T> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const url = `${base.replace(/\/+$/, "")}${route}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        "user-agent": `seatledger/${version()}`,
        accept: "application/json",
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TeamApiError(
      "UNREACHABLE",
      `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      "check your connection and SEATLEDGER_URL, then try again",
      true,
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = (body ?? {}) as Partial<Record<"code" | "cause" | "fix", string>> & {
      retryable?: boolean;
    };
    throw new TeamApiError(
      e.code ?? `HTTP_${res.status}`,
      e.cause ?? `${method} ${route} answered ${res.status}`,
      e.fix ?? "try again later",
      e.retryable ?? res.status >= 500,
      res.status,
    );
  }
  if (body === undefined)
    throw new TeamApiError(
      "BAD_RESPONSE",
      `${method} ${route} did not answer JSON`,
      "check SEATLEDGER_URL points at the seatledger service",
      false,
      res.status,
    );
  return body as T;
}

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A default developer name: your login, made to fit the team's naming rule. */
export function defaultHandle(): string {
  let name: string;
  try {
    name = os.userInfo().username;
  } catch {
    name = "";
  }
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return HANDLE.test(cleaned) ? cleaned : "dev";
}

export function validHandle(name: string): boolean {
  return HANDLE.test(name);
}

/** The deployment an invite link belongs to, so a preview's invite joins the preview. */
export function inviteBase(invite: string, fallback: string): string {
  try {
    const u = new URL(invite);
    if (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1")
      return u.origin;
  } catch {
    // a bare sli_… code
  }
  return fallback;
}
