/**
 * Claude Code transcripts: `~/.claude/projects/<project>/<session>.jsonl`, plus subagent
 * transcripts under `<session>/subagents/` ($CLAUDE_CONFIG_DIR replaces `~/.claude`).
 *
 * Verified on 7 Oct 2026 against Claude Code 2.1.229–2.1.286 transcripts on a real machine
 * (metadata only) and the 2.1.292 changelog:
 *
 * - every API response is an `assistant` line with `message.id`, `requestId`, `message.model`,
 *   `version`, `cwd`, `sessionId`, `timestamp` and `message.usage` = `{ input_tokens,
 *   output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation: {
 *   ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }, speed, inference_geo, … }`;
 * - one response is written as several lines (one per content block) that repeat the same usage,
 *   except `output_tokens`, which grows to its final value on the last line. So lines are merged
 *   per `message.id:requestId` keeping the largest count, not the first one;
 * - the same response can appear in more than one file (subagent transcripts, resumed and
 *   set-aside sessions), which `load` deduplicates across files by the same key;
 * - `<synthetic>` messages are written by the client, not billed, and are skipped.
 *
 * A turn a person started is a main-thread `user` line that is not a tool result, not meta and not
 * a compaction summary. Newer versions say who wrote it (`origin.kind`, `turnOrigin`); older ones
 * are recognised by the client's own markers for command output, interruptions and notifications.
 */
import { folderName, forEachJsonLine, num, obj, str, time } from "../jsonl.js";
import type { FileExtract, PromptMark, UsageRecord } from "../types.js";

/** Text the client writes into a `user` line itself, on older versions that do not say so. */
const MACHINE_TURN_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<bash-stdout>",
  "<bash-stderr>",
  "[Request interrupted",
];

export async function readClaudeCodeFile(file: string): Promise<FileExtract> {
  const byId = new Map<string, UsageRecord>();
  const prompts: PromptMark[] = [];
  const stats = { skipped: 0 };

  await forEachJsonLine(
    file,
    (raw) => raw.includes('"usage"') || (raw.includes('"user"') && !raw.includes('"tool_result"')),
    (line) => {
      if (line.type === "assistant") {
        const record = assistantRecord(line);
        if (!record) return;
        const prev = byId.get(record.id);
        byId.set(record.id, prev ? mergeRecords(prev, record) : record);
      } else if (line.type === "user") {
        const mark = promptMark(line);
        if (mark) prompts.push(mark);
      }
    },
    stats,
  );

  return {
    client: "claude-code",
    requests: [...byId.values()],
    prompts,
    quota: [],
    skippedLines: stats.skipped,
  };
}

function assistantRecord(line: Record<string, unknown>): UsageRecord | undefined {
  const message = obj(line.message);
  const usage = obj(message?.usage);
  const model = str(message?.model);
  const ts = time(line.timestamp);
  if (!message || !usage || !model || model === "<synthetic>" || ts === undefined) return undefined;

  const messageId = str(message.id) ?? str(line.uuid);
  if (!messageId) return undefined;
  const id = `${messageId}:${str(line.requestId) ?? ""}`;

  const split = obj(usage.cache_creation);
  const write5m = num(split?.ephemeral_5m_input_tokens);
  const write1h = num(split?.ephemeral_1h_input_tokens);
  const cacheWrite = Math.max(num(usage.cache_creation_input_tokens), write5m + write1h);

  return {
    client: "claude-code",
    id,
    ts,
    model,
    version: str(line.version) ?? "",
    project: folderName(str(line.cwd)),
    session: str(line.sessionId) ?? "",
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h: split ? Math.min(write1h, cacheWrite) : null,
    fast: usage.speed === "fast",
    geoUs: usage.inference_geo === "us",
  };
}

/** Lines of one response: counts only grow, so the largest of each is the response's. */
export function mergeRecords(a: UsageRecord, b: UsageRecord): UsageRecord {
  const split =
    a.cacheWrite1h === null && b.cacheWrite1h === null
      ? null
      : Math.max(a.cacheWrite1h ?? 0, b.cacheWrite1h ?? 0);
  return {
    ...a,
    ts: Math.min(a.ts, b.ts),
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheWrite1h: split,
    fast: a.fast || b.fast,
    geoUs: a.geoUs || b.geoUs,
    version: a.version || b.version,
    project: a.project || b.project,
    session: a.session || b.session,
  };
}

function promptMark(line: Record<string, unknown>): PromptMark | undefined {
  if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true)
    return undefined;
  if (line.isVisibleInTranscriptOnly === true) return undefined;
  const ts = time(line.timestamp);
  const session = str(line.sessionId);
  if (ts === undefined || !session) return undefined;

  const content = obj(line.message)?.content;
  if (Array.isArray(content) && content.some((b) => obj(b)?.type === "tool_result"))
    return undefined;

  // Newer versions say who wrote the turn.
  const kind = str(obj(line.origin)?.kind);
  if (kind !== undefined) return kind === "human" ? { session, ts } : undefined;
  const turnOrigin = str(line.turnOrigin);
  if (turnOrigin !== undefined) return turnOrigin === "human" ? { session, ts } : undefined;

  // Older ones: the client's own markers. Only the opening characters are looked at.
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (str(obj(content.find((b) => obj(b)?.type === "text"))?.text) ?? "")
        : "";
  const head = text.trimStart().slice(0, 40);
  if (MACHINE_TURN_PREFIXES.some((p) => head.startsWith(p))) return undefined;
  if (head.length === 0 && !(Array.isArray(content) && content.length > 0)) return undefined;
  return { session, ts };
}
