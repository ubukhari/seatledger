/**
 * Where the clients keep their transcripts, and where seatledger keeps its own files.
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/projects` (several directories may be given, comma-separated),
 *   else `~/.claude/projects` and `~/.config/claude/projects`.
 * - Codex: `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, `CODEX_HOME` defaulting to
 *   `~/.codex`.
 * - seatledger: `$SEATLEDGER_HOME`, else `~/.seatledger` (your limits, and a cache of the counts).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Client } from "./types.js";

export interface SourceDirs {
  "claude-code": string[];
  codex: string[];
}

export interface DirOverrides {
  claudeDir?: string | undefined;
  codexDir?: string | undefined;
}

export function sourceDirs(
  overrides: DirOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): SourceDirs {
  const home = homedir();
  const claude = overrides.claudeDir
    ? [path.resolve(overrides.claudeDir)]
    : env.CLAUDE_CONFIG_DIR
      ? env.CLAUDE_CONFIG_DIR.split(",")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => path.join(path.resolve(d), "projects"))
      : [path.join(home, ".claude", "projects"), path.join(home, ".config", "claude", "projects")];
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  const codex = overrides.codexDir
    ? [path.resolve(overrides.codexDir)]
    : [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  return { "claude-code": claude, codex };
}

export function seatledgerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SEATLEDGER_HOME
    ? path.resolve(env.SEATLEDGER_HOME)
    : path.join(homedir(), ".seatledger");
}

export interface SourceFile {
  client: Client;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Spilled tool output and memory notes live beside transcripts; neither is a transcript. */
const SKIP_DIRS = new Set(["tool-results", "memory", "node_modules", ".git"]);

export function listSourceFiles(dirs: SourceDirs): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  for (const client of Object.keys(dirs) as Client[]) {
    for (const root of dirs[client]) {
      if (!existsSync(root)) continue;
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(p);
          } else if (e.isFile() && e.name.endsWith(".jsonl") && !seen.has(p)) {
            try {
              const st = statSync(p);
              seen.add(p);
              out.push({ client, path: p, size: st.size, mtimeMs: st.mtimeMs });
            } catch {
              // deleted while we walked
            }
          }
        }
      };
      walk(root);
    }
  }
  return out;
}
