/**
 * Streaming JSONL: one parsed object per line, without holding the file in memory. Transcripts run
 * to hundreds of megabytes, and most of every line is prompt and response text seatledger never
 * looks at, so a cheap substring test decides which lines are parsed at all. Lines that are not
 * JSON are counted and skipped: a transcript being written while we read it ends mid-line.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface JsonlStats {
  skipped: number;
}

export async function forEachJsonLine(
  file: string,
  wanted: (raw: string) => boolean,
  onObject: (value: Record<string, unknown>) => void,
  stats: JsonlStats,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (raw.length === 0 || !wanted(raw)) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        stats.skipped += 1;
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        onObject(value as Record<string, unknown>);
      } else {
        stats.skipped += 1;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Narrowing helpers for untrusted JSON: unknown fields are ignored, wrong types read as absent. */
export const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A non-negative finite count, else 0. */
export const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

export const time = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

/** The last path segment of a working directory: the folder name, never the full path. */
export function folderName(cwd: string | undefined): string {
  if (!cwd) return "";
  // A Claude Code worktree lives at <repo>/.claude/worktrees/<name>; report the repo.
  const trimmed = cwd
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
