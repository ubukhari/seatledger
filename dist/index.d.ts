/**
 * The shapes everything else in seatledger works on. Readers turn a client's local transcript into
 * these; the ledger, the rate detector and the limits only ever see these. Nothing here can hold
 * prompt or response text: every field is a count, a timestamp, an identifier or a name the client
 * itself wrote (model id, version, folder name).
 */
declare const CLIENTS: readonly ["claude-code", "codex"];
type Client = (typeof CLIENTS)[number];
declare const CLIENT_LABEL: Readonly<Record<Client, string>>;
/** One billed model request, deduplicated across files by `id`. */
interface UsageRecord {
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
interface PromptMark {
    session: string;
    ts: number;
}
/** One reading of a vendor's own rate-limit window, as the client wrote it locally. */
interface QuotaSample {
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
interface FileExtract {
    client: Client;
    requests: UsageRecord[];
    prompts: PromptMark[];
    quota: QuotaSample[];
    /** Lines that were not JSON, or JSON the reader could not use. Counted, never stored. */
    skippedLines: number;
}
declare function totalTokens(r: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">): number;

declare function readClaudeCodeFile(file: string): Promise<FileExtract>;

declare function readCodexFile(file: string): Promise<FileExtract>;

interface SourceDirs {
    "claude-code": string[];
    codex: string[];
}
interface DirOverrides {
    claudeDir?: string | undefined;
    codexDir?: string | undefined;
}
declare function sourceDirs(overrides?: DirOverrides, env?: NodeJS.ProcessEnv): SourceDirs;
declare function seatledgerHome(env?: NodeJS.ProcessEnv): string;
interface SourceFile {
    client: Client;
    path: string;
    size: number;
    mtimeMs: number;
}
declare function listSourceFiles(dirs: SourceDirs): SourceFile[];

interface LoadOptions {
    dirs?: SourceDirs;
    /** Epoch ms; requests before it are dropped, and transcripts last written before it are not read. */
    since?: number;
    /** Use and update `~/.seatledger/cache-v1`. Default true. */
    cache?: boolean;
    /** seatledger's home (cache, limits). Default `$SEATLEDGER_HOME` or `~/.seatledger`. */
    home?: string;
    /** Clients to read. Default both. */
    clients?: readonly Client[];
    /** Called once with the number of transcripts that have to be read (not served from cache). */
    onRead?: (files: number) => void;
}
interface SourceSummary {
    client: Client;
    roots: string[];
    /** Transcripts found on disk. */
    files: number;
    /** Of those, read this run (new or changed since the cache). */
    read: number;
    /** Cached counts kept from transcripts that no longer exist (deleted by the client's cleanup). */
    retained: number;
    /** Lines that were not JSON or not usable; counted, never shown. */
    skippedLines: number;
}
interface Loaded {
    requests: UsageRecord[];
    quota: QuotaSample[];
    sources: SourceSummary[];
    since: number | undefined;
}
declare function load(opts?: LoadOptions): Promise<Loaded>;
/**
 * Claude Code requests belong to the latest turn a person started in the same session before
 * them; subagent requests share their parent's session, so they land on the turn that spawned
 * them. Codex records carry their root turn already.
 */
declare function assignTurns(requests: UsageRecord[], prompts: PromptMark[]): UsageRecord[];

/**
 * API list prices, used to say what a request would have cost on the vendor's API. It is an
 * API-equivalent figure, never what you were billed: a seat (Pro, Max, Plus, Team…) is a flat fee
 * with an allowance, and nothing on your machine records how the vendor counts usage against it.
 *
 * Each table is dated and sourced. Prices change; when a model is missing, its tokens are counted
 * and its dollars shown as unpriced rather than guessed.
 */

interface PriceSource {
    provider: "Anthropic" | "OpenAI";
    url: string;
    /** The date the table below was read from `url`. */
    read: string;
}
declare const PRICE_SOURCES: readonly PriceSource[];
/** USD per million tokens. */
interface ModelPrice {
    provider: PriceSource["provider"];
    input: number;
    output: number;
    cacheRead: number;
    /** Writes to the 5-minute cache (Anthropic), or the one cache-write price (OpenAI). */
    cacheWrite: number;
    /** Writes to the 1-hour cache (Anthropic only). */
    cacheWrite1h?: number;
    /** Requests whose prompt is above `threshold` tokens are billed at these prices (OpenAI). */
    long?: {
        threshold: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    /** Claude fast mode: these replace `input` and `output`; cache multipliers apply on top. */
    fast?: {
        input: number;
        output: number;
    };
}
/**
 * The table key for a model id as a client writes it: dated snapshots, Bedrock and Vertex forms
 * and context-window suffixes all name the same list price.
 */
declare function priceKey(model: string): string;
declare function priceFor(model: string): ModelPrice | undefined;
declare const pricedModels: () => string[];
/** API-equivalent USD for one request, or `null` when the model has no list price here. */
declare function apiEquivalentUsd(r: UsageRecord): number | null;

declare const GROUP_BY: readonly ["day", "project", "model", "client"];
type GroupBy = (typeof GROUP_BY)[number];
interface Totals {
    requests: number;
    /** Distinct turns a person started, where the transcript lets us tell. */
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tokens: number;
    /** API-equivalent USD of the priced requests. */
    apiEquivalentUsd: number;
    unpricedRequests: number;
    unpricedModels: string[];
}
interface LedgerRow extends Totals {
    key: string;
}
/** Local calendar day, YYYY-MM-DD. */
declare function dayKey(ts: number): string;
declare function totals(requests: readonly UsageRecord[]): Totals;
/** Rows sorted by day ascending, or by API-equivalent dollars (then tokens) for other groupings. */
declare function groupRows(requests: readonly UsageRecord[], by: GroupBy): LedgerRow[];

declare const METRICS: readonly ["tokens_per_request", "cache_read_share", "cache_write_per_read", "tokens_per_turn", "cache_1h_write_share", "tokens_per_quota_percent"];
type Metric = (typeof METRICS)[number];
declare const METRIC_LABEL: Readonly<Record<Metric, string>>;
interface RateOptions {
    minRequests?: number;
    /** Active days on each side of a candidate change. */
    window?: number;
    /** Relative change for ratio metrics, e.g. 0.3 for 30%. */
    ratioThreshold?: number;
    /** Absolute change for share metrics, e.g. 0.1 for 10 percentage points. */
    shareThreshold?: number;
}
interface DayPoint {
    day: string;
    requests: number;
    turns: number;
    version: string;
    values: Partial<Record<Metric, number>>;
    cacheReadsPerRequest: number;
    cacheWritesPerRequest: number;
}
interface Series {
    client: Client;
    /** Model id, or "all models" for the Codex quota series. */
    model: string;
    days: DayPoint[];
}
interface RateChange {
    metric: Metric;
    label: string;
    date: string;
    before: number;
    after: number;
    /** after / before for ratios; after − before for shares. */
    change: number;
    beforeDays: [string, string];
    afterDays: [string, string];
    score: number;
}
interface RateFinding {
    client: Client;
    model: string;
    date: string;
    version: string;
    previousVersion: string;
    /** True when `date` is the first active day on `version` for this model. */
    versionChanged: boolean;
    changes: RateChange[];
    cacheReadsPerRequest: [before: number, after: number];
    cacheWritesPerRequest: [before: number, after: number];
    sentence: string;
    consistentWith: string;
}
interface Baseline {
    client: Client;
    model: string;
    activeDays: number;
    firstDay: string;
    lastDay: string;
    version: string;
    /** Median of the last `window` active days. */
    current: Partial<Record<Metric, number>>;
}
interface RateReport {
    method: string;
    findings: RateFinding[];
    baselines: Baseline[];
}
declare function dailySeries(requests: readonly UsageRecord[], quota?: readonly QuotaSample[], opts?: RateOptions): Series[];
/** Step changes in one metric of one series. */
declare function detectSteps(days: readonly DayPoint[], metric: Metric, opts?: RateOptions): RateChange[];
/** Run the detector over every series and turn the steps into findings people can read. */
declare function rateReport(series: readonly Series[], opts?: RateOptions): RateReport;
declare const METHOD: string;

declare const WINDOWS: readonly ["5h", "weekly"];
type LimitWindow = (typeof WINDOWS)[number];
type LimitScope = Client | "all";
interface Limit {
    window: LimitWindow;
    client: LimitScope;
    /** Total tokens (input, output, cache reads and cache writes). */
    tokens?: number;
    /** API-equivalent USD. */
    usd?: number;
    setAt: string;
}
declare function readLimits(home: string): Limit[];
/** Set (or replace) the limit for one window and scope. Returns the limits now in force. */
declare function setLimit(home: string, limit: Omit<Limit, "setAt">, now?: number): Limit[];
declare function clearLimits(home: string, window?: LimitWindow, client?: LimitScope): Limit[];
interface LimitStatus {
    limit: Limit;
    unit: "tokens" | "usd";
    amount: number;
    used: number;
    /** used / amount */
    fraction: number;
    windowStart: number | null;
    /** When the current 5h window closes; null for weekly, or when no window is open. */
    windowEnd: number | null;
    /** Per hour, over the open window (5h) or the last 24 hours (weekly). */
    burnPerHour: number;
    /** When the limit is (or was) reached at the current burn rate; null if not before reset. */
    reachedAt: number | null;
    /** True when it has already been reached in this window. */
    reached: boolean;
    /** Busiest 5-hour window of the last 30 days (5h limits only), to calibrate against. */
    busiest: {
        start: number;
        used: number;
    } | null;
}
declare function limitStatus(limit: Limit, requests: readonly UsageRecord[], now: number): LimitStatus;
interface VendorReading {
    client: Client;
    limitId: string;
    slot: "primary" | "secondary";
    windowMinutes: number | null;
    usedPercent: number;
    resetsAt: number | null;
    planType: string | null;
    /** When the client wrote this reading. */
    readAt: number;
    /** False once `resetsAt` has passed: the reading describes a window that is over. */
    current: boolean;
}
/** The latest reading of each vendor window, exactly as the client recorded it locally. */
declare function vendorReadings(quota: readonly QuotaSample[], now: number): VendorReading[];

/**
 * What each command shows, as data. The CLI renders these as text and `--json`; the MCP tools
 * return them as structured content. One source, so the two cannot disagree.
 */

declare const API_EQUIVALENT_NOTE = "API-equivalent: what these tokens would cost at the vendor's API list prices. Not what you were billed; a seat is a flat fee with an allowance.";
interface Common {
    generatedAt: string;
    apiEquivalentNote: string;
    prices: readonly PriceSource[];
    sources: SourceSummary[];
}
interface SummaryView extends Common {
    today: {
        day: string;
        rows: LedgerRow[];
        totals: Totals;
    };
    last7Days: {
        from: string;
        to: string;
        days: LedgerRow[];
        totals: Totals;
    };
    limits: LimitStatus[];
    vendorReadings: VendorReading[];
}
declare function summaryView(loaded: Loaded, now: number, home: string, client?: Client): SummaryView;
interface ReportView extends Common {
    by: GroupBy;
    from: string | null;
    client: Client | null;
    rows: LedgerRow[];
    totals: Totals;
}
declare function reportView(loaded: Loaded, now: number, by: GroupBy, since: number | undefined, client?: Client): ReportView;
interface RatesView extends Common, RateReport {
    from: string | null;
}
declare function ratesView(loaded: Loaded, now: number, since: number | undefined, filter?: {
    client?: Client | undefined;
    model?: string | undefined;
}, opts?: RateOptions): RatesView;
/**
 * `--since`: a date (2026-09-01) or a number of days back from today (30d, 12w). Returns the local
 * midnight it starts at, or throws a message meant for the person who typed it.
 */
declare function parseSince(value: string, now: number): number;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

declare const PROTOCOL_VERSIONS: readonly ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
interface ToolDefinition {
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
declare const TOOLS: readonly ToolDefinition[];
interface McpContext {
    loadOptions?: Omit<LoadOptions, "since">;
    now?: () => number;
    home?: string;
    /** for `seatledger_team_summary` only; tests pass a fake */
    fetch?: FetchLike;
    env?: NodeJS.ProcessEnv;
}
declare function callTool(name: string, rawArgs: unknown, ctx?: McpContext): Promise<{
    structured: Record<string, unknown>;
    isError: boolean;
}>;
declare function handleMessage(msg: unknown, ctx: McpContext): Promise<unknown>;

interface SyntheticOptions {
    /** Directory to write into: `<dir>/claude/projects/…` and `<dir>/codex/sessions/…`. */
    dir: string;
    /** First day, YYYY-MM-DD (UTC). */
    start?: string;
    days?: number;
    seed?: number;
    /** false: a history with no change in it. */
    step?: false | {
        date: string;
    };
    codexStep?: false | {
        date: string;
    };
}
interface SyntheticResult {
    claudeDir: string;
    codexDir: string;
    /** 16:00 UTC on the last day: a fixed "now" for reproducible output. */
    now: number;
    claudeRequests: number;
    codexRequests: number;
}
declare function writeSyntheticHistory(opts: SyntheticOptions): SyntheticResult;

declare const PUSH_SCHEMA_ID = "seatledger.push/v1";
interface PushRow {
    day: string;
    client: Client;
    client_version: string;
    model: string;
    project?: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    api_equivalent_usd: number | null;
}
interface PushFinding {
    client: Client;
    model: string;
    date: string;
    version: string;
    previous_version: string;
    version_changed: boolean;
    changes: {
        metric: string;
        before: number;
        after: number;
        change: number;
    }[];
    cache_reads_per_request: [number, number];
    cache_writes_per_request: [number, number];
}
interface PushPayload {
    schema: typeof PUSH_SCHEMA_ID;
    days: string[];
    rows: PushRow[];
    findings: PushFinding[];
}
declare function toPushFinding(f: RateFinding): PushFinding;
interface BuildOptions {
    /** epoch ms: the first local day to cover (never before this machine's own first day) */
    since: number;
    now: number;
    projectNames?: boolean;
    rates?: RateReport;
}
/** The payload for one push, before it is split to fit the service's limits. */
declare function buildPushPayload(loaded: Loaded, opts: BuildOptions): PushPayload;
/**
 * Split into pushes the service accepts: contiguous runs of days with at most 400 days and 5,000
 * rows each, oldest first. Findings ride on the last one.
 */
declare function splitPayload(p: PushPayload): PushPayload[];

interface Demo {
    summary: SummaryView;
    rates: RatesView;
    summaryText: string;
    ratesText: string;
    now: number;
}
declare function runDemo(): Promise<Demo>;
/** The README screenshot: `seatledger`, then the findings of `seatledger rates`. */
declare function screenshotText(demo: Demo): string;
/** Terminal-style SVG of plain text: one <text> per line, monospace, dark background. */
declare function textToSvg(text: string): string;

export { API_EQUIVALENT_NOTE, CLIENTS, CLIENT_LABEL, type Client, type Demo, type FileExtract, GROUP_BY, type GroupBy, type LedgerRow, type Limit, type LimitStatus, type LoadOptions, type Loaded, METHOD, METRICS, METRIC_LABEL, type Metric, type ModelPrice, PRICE_SOURCES, PROTOCOL_VERSIONS, PUSH_SCHEMA_ID, type PriceSource, type PromptMark, type PushFinding, type PushPayload, type PushRow, type QuotaSample, type RateChange, type RateFinding, type RateReport, type Series, type SourceDirs, type SourceSummary, type SyntheticOptions, TOOLS, type Totals, type UsageRecord, type VendorReading, apiEquivalentUsd, assignTurns, buildPushPayload, callTool, clearLimits, dailySeries, dayKey, detectSteps, groupRows, handleMessage, limitStatus, listSourceFiles, load, parseSince, priceFor, priceKey, pricedModels, rateReport, ratesView, readClaudeCodeFile, readCodexFile, readLimits, reportView, runDemo, screenshotText, seatledgerHome, setLimit, sourceDirs, splitPayload, summaryView, textToSvg, toPushFinding, totalTokens, totals, vendorReadings, writeSyntheticHistory };
