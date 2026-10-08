/**
 * The shapes everything else in seatledger works on. Readers turn a client's local transcript into
 * these; the ledger, the rate detector and the limits only ever see these. Nothing here can hold
 * prompt or response text: every field is a count, a timestamp, an identifier or a name the client
 * itself wrote (model id, version, folder name).
 */

export const CLIENTS = ["claude-code", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

export const CLIENT_LABEL: Readonly<Record<Client, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** One billed model request, deduplicated across files by `id`. */
export interface UsageRecord {
  client: Client;
  /** Dedup key: Claude Code `message.id:requestId`, Codex `response_id` (or a derived key). */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** Model id as the client wrote it. */
  model: string;
  /** Client version that made the request, or "" when the transcript does not say. */
  version: string;
  /** Folder name of the working directory, never a full path. */
  project: string;
  session: string;
  /** Input tokens that were neither read from nor written to the prompt cache. */
  input: number;
  /** Output tokens, reasoning included. */
  output: number;
  cacheRead: number;
  /** All cache-write tokens. */
  cacheWrite: number;
  /**
   * Of `cacheWrite`, the tokens written to the 1-hour cache. `null` when the transcript does not
   * split writes by lifetime (Codex, and Claude Code before the split existed).
   */
  cacheWrite1h: number | null;
  /** Claude fast mode (`usage.speed: "fast"`), billed at a premium. */
  fast: boolean;
  /** US-only inference (`usage.inference_geo: "us"`), billed at 1.1x. */
  geoUs: boolean;
  /** The human turn this request served, when the reader can tell; filled in by `load`. */
  turn?: string;
}

/** A turn a person started: Claude Code user prompts, used to attribute requests to turns. */
export interface PromptMark {
  session: string;
  ts: number;
}

/** One reading of a vendor's own rate-limit window, as the client wrote it locally. */
export interface QuotaSample {
  client: Client;
  ts: number;
  /** e.g. "codex" */
  limitId: string;
  /** "primary" or "secondary", as the client names them. */
  slot: "primary" | "secondary";
  windowMinutes: number | null;
  usedPercent: number;
  /** Epoch milliseconds, or null. */
  resetsAt: number | null;
  planType: string | null;
}

/** Everything one transcript file contributed. Cached per file by size and mtime. */
export interface FileExtract {
  client: Client;
  requests: UsageRecord[];
  prompts: PromptMark[];
  quota: QuotaSample[];
  /** Lines that were not JSON, or JSON the reader could not use. Counted, never stored. */
  skippedLines: number;
}

export function totalTokens(r: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">) {
  return r.input + r.output + r.cacheRead + r.cacheWrite;
}
