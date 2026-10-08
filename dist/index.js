// src/types.ts
var CLIENTS = ["claude-code", "codex"];
var CLIENT_LABEL = {
  "claude-code": "Claude Code",
  codex: "Codex"
};
function totalTokens(r) {
  return r.input + r.output + r.cacheRead + r.cacheWrite;
}

// src/jsonl.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
async function forEachJsonLine(file, wanted, onObject, stats) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (raw.length === 0 || !wanted(raw)) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        stats.skipped += 1;
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        onObject(value);
      } else {
        stats.skipped += 1;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var str = (v) => typeof v === "string" ? v : void 0;
var num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
var time = (v) => {
  if (typeof v !== "string") return void 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : void 0;
};
function folderName(cwd) {
  if (!cwd) return "";
  const trimmed = cwd.replace(/[\\/]+$/, "").replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// src/readers/claude-code.ts
var MACHINE_TURN_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<bash-stdout>",
  "<bash-stderr>",
  "[Request interrupted"
];
async function readClaudeCodeFile(file) {
  const byId = /* @__PURE__ */ new Map();
  const prompts = [];
  const stats = { skipped: 0 };
  await forEachJsonLine(
    file,
    (raw) => raw.includes('"usage"') || raw.includes('"user"') && !raw.includes('"tool_result"'),
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
    stats
  );
  return {
    client: "claude-code",
    requests: [...byId.values()],
    prompts,
    quota: [],
    skippedLines: stats.skipped
  };
}
function assistantRecord(line) {
  const message = obj(line.message);
  const usage = obj(message?.usage);
  const model = str(message?.model);
  const ts = time(line.timestamp);
  if (!message || !usage || !model || model === "<synthetic>" || ts === void 0) return void 0;
  const messageId = str(message.id) ?? str(line.uuid);
  if (!messageId) return void 0;
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
    geoUs: usage.inference_geo === "us"
  };
}
function mergeRecords(a, b) {
  const split = a.cacheWrite1h === null && b.cacheWrite1h === null ? null : Math.max(a.cacheWrite1h ?? 0, b.cacheWrite1h ?? 0);
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
    session: a.session || b.session
  };
}
function promptMark(line) {
  if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true)
    return void 0;
  if (line.isVisibleInTranscriptOnly === true) return void 0;
  const ts = time(line.timestamp);
  const session = str(line.sessionId);
  if (ts === void 0 || !session) return void 0;
  const content = obj(line.message)?.content;
  if (Array.isArray(content) && content.some((b) => obj(b)?.type === "tool_result"))
    return void 0;
  const kind = str(obj(line.origin)?.kind);
  if (kind !== void 0) return kind === "human" ? { session, ts } : void 0;
  const turnOrigin = str(line.turnOrigin);
  if (turnOrigin !== void 0) return turnOrigin === "human" ? { session, ts } : void 0;
  const text = typeof content === "string" ? content : Array.isArray(content) ? str(obj(content.find((b) => obj(b)?.type === "text"))?.text) ?? "" : "";
  const head = text.trimStart().slice(0, 40);
  if (MACHINE_TURN_PREFIXES.some((p) => head.startsWith(p))) return void 0;
  if (head.length === 0 && !(Array.isArray(content) && content.length > 0)) return void 0;
  return { session, ts };
}

// src/readers/codex.ts
function usageOf(v) {
  const u = obj(v);
  if (!u) return void 0;
  const input = num(u.input_tokens);
  const cacheRead = Math.min(num(u.cached_input_tokens), input);
  const cacheWrite = Math.min(num(u.cache_write_input_tokens), input - cacheRead);
  return {
    input: input - cacheRead - cacheWrite,
    output: num(u.output_tokens),
    cacheRead,
    cacheWrite
  };
}
var usageKey = (u) => `${u.input}/${u.output}/${u.cacheRead}/${u.cacheWrite}`;
async function readCodexFile(file) {
  const stats = { skipped: 0 };
  let thread = "";
  let project = "";
  let version2 = "";
  let model = "";
  let turn;
  const turnModel = /* @__PURE__ */ new Map();
  const records = [];
  const fromCounts = [];
  const quota = [];
  let lastTotal = -1;
  let firstRecordTs;
  const base = (ts, m) => ({
    client: "codex",
    ts,
    model: m || "unknown",
    version: version2,
    project,
    session: thread,
    cacheWrite1h: null,
    fast: false,
    geoUs: false
  });
  await forEachJsonLine(
    file,
    (raw) => raw.includes('"token_count"') || raw.includes('"token_usage_record"') || raw.includes('"turn_context"') || raw.includes('"session_meta"'),
    (line) => {
      const payload = obj(line.payload) ?? {};
      const ts = time(line.timestamp);
      switch (line.type) {
        case "session_meta": {
          thread = str(payload.id) ?? thread;
          project = folderName(str(payload.cwd)) || project;
          version2 = str(payload.cli_version) ?? version2;
          return;
        }
        case "turn_context": {
          model = str(payload.model) ?? model;
          turn = str(payload.turn_id) ?? turn;
          if (turn && model) turnModel.set(turn, model);
          return;
        }
        case "token_usage_record": {
          const usage = usageOf(payload.usage);
          const responseId = str(payload.response_id);
          if (!usage || !responseId || ts === void 0) return;
          const turnId = str(payload.turn_id);
          const rootTurn = str(payload.root_turn_id) ?? turnId;
          firstRecordTs ??= ts;
          records.push({
            ...base(ts, turnId && turnModel.get(turnId) || model),
            id: `codex:${responseId}`,
            ...usage,
            ...rootTurn ? { turn: `codex:${rootTurn}` } : {}
          });
          return;
        }
        case "event_msg": {
          if (payload.type !== "token_count" || ts === void 0) return;
          const info = obj(payload.info);
          const total = num(obj(info?.total_token_usage)?.total_tokens);
          const last = usageOf(info?.last_token_usage);
          if (info && last && total > lastTotal) {
            const sum = last.input + last.output + last.cacheRead + last.cacheWrite;
            if (sum > 0) {
              fromCounts.push({
                record: {
                  ...base(ts, model),
                  id: `codex-tc:${str(line.timestamp)}:${total}`,
                  ...last,
                  ...turn ? { turn: `codex:${turn}` } : {}
                },
                key: usageKey(last)
              });
            }
            lastTotal = total;
          }
          collectQuota(payload.rate_limits, ts, quota);
          return;
        }
      }
    },
    stats
  );
  let requests = records;
  if (records.length === 0) {
    requests = fromCounts.map((c) => c.record);
  } else {
    const seen = new Set(records.map(usageKey));
    for (const c of fromCounts) {
      if (firstRecordTs !== void 0 && c.record.ts < firstRecordTs - 5e3 && !seen.has(c.key))
        requests.push(c.record);
    }
  }
  return {
    client: "codex",
    requests,
    prompts: [],
    quota: compressQuota(quota),
    skippedLines: stats.skipped
  };
}
function compressQuota(samples) {
  const out = [];
  const last = /* @__PURE__ */ new Map();
  const lastKept = /* @__PURE__ */ new Map();
  for (const s of samples) {
    const k = `${s.limitId}/${s.slot}`;
    const prev = lastKept.get(k);
    if (!prev || prev.usedPercent !== s.usedPercent || prev.resetsAt !== s.resetsAt) {
      out.push(s);
      lastKept.set(k, s);
    }
    last.set(k, s);
  }
  for (const [k, s] of last) if (lastKept.get(k) !== s) out.push(s);
  return out.sort((a, b) => a.ts - b.ts);
}
function collectQuota(v, ts, into) {
  const limits = obj(v);
  if (!limits) return;
  const limitId = str(limits.limit_id) ?? "codex";
  const planType = str(limits.plan_type) ?? null;
  for (const slot of ["primary", "secondary"]) {
    const w = obj(limits[slot]);
    if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
    const resets = typeof w.resets_at === "number" ? w.resets_at * 1e3 : null;
    into.push({
      client: "codex",
      ts,
      limitId,
      slot,
      windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
      usedPercent: w.used_percent,
      resetsAt: resets,
      planType
    });
  }
}

// src/load.ts
import path3 from "path";

// src/paths.ts
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
function sourceDirs(overrides = {}, env = process.env) {
  const home = homedir();
  const claude = overrides.claudeDir ? [path.resolve(overrides.claudeDir)] : env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(",").map((d) => d.trim()).filter(Boolean).map((d) => path.join(path.resolve(d), "projects")) : [path.join(home, ".claude", "projects"), path.join(home, ".config", "claude", "projects")];
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  const codex = overrides.codexDir ? [path.resolve(overrides.codexDir)] : [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  return { "claude-code": claude, codex };
}
function seatledgerHome(env = process.env) {
  return env.SEATLEDGER_HOME ? path.resolve(env.SEATLEDGER_HOME) : path.join(homedir(), ".seatledger");
}
var SKIP_DIRS = /* @__PURE__ */ new Set(["tool-results", "memory", "node_modules", ".git"]);
function listSourceFiles(dirs) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const client of Object.keys(dirs)) {
    for (const root of dirs[client]) {
      if (!existsSync(root)) continue;
      const walk = (dir) => {
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
            }
          }
        }
      };
      walk(root);
    }
  }
  return out;
}

// src/store.ts
import { createHash } from "crypto";
import { mkdirSync, readFileSync, readdirSync as readdirSync2, renameSync, writeFileSync } from "fs";
import path2 from "path";
var CACHE_DIR = "cache-v1";
var FAST = 1;
var GEO_US = 2;
function encode(e) {
  const strings = [];
  const index = /* @__PURE__ */ new Map();
  const s = (v) => {
    let i = index.get(v);
    if (i === void 0) {
      i = strings.push(v) - 1;
      index.set(v, i);
    }
    return i;
  };
  return {
    v: 1,
    src: e.src,
    size: e.size,
    mtimeMs: e.mtimeMs,
    client: e.client,
    strings,
    requests: e.requests.map((r) => [
      r.id,
      r.ts,
      s(r.model),
      s(r.version),
      s(r.project),
      s(r.session),
      r.input,
      r.output,
      r.cacheRead,
      r.cacheWrite,
      r.cacheWrite1h ?? -1,
      (r.fast ? FAST : 0) | (r.geoUs ? GEO_US : 0),
      r.turn === void 0 ? -1 : s(r.turn)
    ]),
    prompts: e.prompts.map((p) => [s(p.session), p.ts]),
    quota: e.quota.map((q) => [
      q.ts,
      q.limitId,
      q.slot === "primary" ? 0 : 1,
      q.windowMinutes,
      q.usedPercent,
      q.resetsAt,
      q.planType
    ]),
    skipped: e.skippedLines
  };
}
function decode(w) {
  const at = (i) => w.strings[i] ?? "";
  return {
    src: w.src,
    size: w.size,
    mtimeMs: w.mtimeMs,
    client: w.client,
    skippedLines: w.skipped,
    requests: w.requests.map((r) => ({
      client: w.client,
      id: r[0],
      ts: r[1],
      model: at(r[2]),
      version: at(r[3]),
      project: at(r[4]),
      session: at(r[5]),
      input: r[6],
      output: r[7],
      cacheRead: r[8],
      cacheWrite: r[9],
      cacheWrite1h: r[10] < 0 ? null : r[10],
      fast: (r[11] & FAST) !== 0,
      geoUs: (r[11] & GEO_US) !== 0,
      ...r[12] >= 0 ? { turn: at(r[12]) } : {}
    })),
    prompts: w.prompts.map(([si, ts]) => ({ session: at(si), ts })),
    quota: w.quota.map((q) => ({
      client: w.client,
      ts: q[0],
      limitId: q[1],
      slot: q[2] === 0 ? "primary" : "secondary",
      windowMinutes: q[3],
      usedPercent: q[4],
      resetsAt: q[5],
      planType: q[6]
    }))
  };
}
var fileFor = (dir, src) => path2.join(dir, createHash("sha256").update(src).digest("hex").slice(0, 32) + ".json");
function readCache(home) {
  const dir = path2.join(home, CACHE_DIR);
  const out = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync2(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path2.join(dir, name), "utf8"));
      if (wire.v !== 1 || typeof wire.src !== "string") continue;
      out.set(wire.src, decode(wire));
    } catch {
    }
  }
  return out;
}
function writeCacheEntry(home, entry) {
  const dir = path2.join(home, CACHE_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    const file = fileFor(dir, entry.src);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 384 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// src/load.ts
var READERS = {
  "claude-code": readClaudeCodeFile,
  codex: readCodexFile
};
var under = (file, roots) => roots.some((r) => file === r || file.startsWith(r.endsWith(path3.sep) ? r : r + path3.sep));
async function load(opts = {}) {
  const dirs = opts.dirs ?? sourceDirs();
  const clients = opts.clients ?? ["claude-code", "codex"];
  const useCache = opts.cache ?? true;
  const home = opts.home ?? seatledgerHome();
  const since = opts.since;
  const cache = useCache ? readCache(home) : /* @__PURE__ */ new Map();
  const files = listSourceFiles(dirs).filter((f) => clients.includes(f.client));
  const onDisk = new Set(files.map((f) => f.path));
  const extracts = [];
  const summary = new Map(
    clients.map((c) => [
      c,
      { client: c, roots: dirs[c], files: 0, read: 0, retained: 0, skippedLines: 0 }
    ])
  );
  const toRead = [];
  for (const f of files) {
    summary.get(f.client).files += 1;
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.client === f.client) {
      extracts.push(hit);
    } else if (since !== void 0 && f.mtimeMs < since) {
      if (hit && hit.client === f.client) extracts.push(hit);
    } else {
      toRead.push(f);
    }
  }
  opts.onRead?.(toRead.length);
  let next = 0;
  const worker = async () => {
    while (next < toRead.length) {
      const f = toRead[next++];
      let extract;
      try {
        extract = await READERS[f.client](f.path);
      } catch {
        continue;
      }
      summary.get(f.client).read += 1;
      extracts.push(extract);
      if (useCache)
        writeCacheEntry(home, { ...extract, src: f.path, size: f.size, mtimeMs: f.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !clients.includes(entry.client)) continue;
    if (!under(src, dirs[entry.client])) continue;
    extracts.push(entry);
    summary.get(entry.client).retained += 1;
  }
  const byId = /* @__PURE__ */ new Map();
  const prompts = /* @__PURE__ */ new Map();
  const quota = /* @__PURE__ */ new Map();
  for (const e of extracts) {
    summary.get(e.client).skippedLines += e.skippedLines;
    for (const r of e.requests) {
      const prev = byId.get(r.id);
      byId.set(r.id, prev ? mergeRecords(prev, r) : r);
    }
    for (const p of e.prompts) prompts.set(`${p.session}@${p.ts}`, p);
    for (const q of e.quota) quota.set(`${q.limitId}/${q.slot}@${q.ts}`, q);
  }
  const requests = assignTurns([...byId.values()], [...prompts.values()]).filter(
    (r) => since === void 0 || r.ts >= since
  );
  requests.sort((a, b) => a.ts - b.ts);
  return {
    requests,
    quota: [...quota.values()].sort((a, b) => a.ts - b.ts),
    sources: [...summary.values()],
    since
  };
}
function assignTurns(requests, prompts) {
  const bySession = /* @__PURE__ */ new Map();
  for (const p of prompts) {
    const list = bySession.get(p.session) ?? [];
    list.push(p.ts);
    bySession.set(p.session, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a - b);
  return requests.map((r) => {
    if (r.client !== "claude-code" || r.turn !== void 0) return r;
    const list = bySession.get(r.session);
    if (!list) return r;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (list[mid] <= r.ts) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? r : { ...r, turn: `${r.session}@${list[found]}` };
  });
}

// src/prices.ts
var PRICE_SOURCES = [
  {
    provider: "Anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    read: "2026-10-07"
  },
  { provider: "OpenAI", url: "https://developers.openai.com/api/docs/pricing", read: "2026-10-07" }
];
var anthropic = (input, write5m, write1h, read, output, fast) => ({
  provider: "Anthropic",
  input,
  output,
  cacheRead: read,
  cacheWrite: write5m,
  cacheWrite1h: write1h,
  ...fast ? { fast } : {}
});
var ANTHROPIC = {
  "claude-fable-5-1": anthropic(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": anthropic(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": anthropic(10, 12.5, 20, 1, 50),
  "claude-mythos-5": anthropic(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": anthropic(4, 5, 8, 0.2, 20, { input: 8, output: 40 }),
  "claude-opus-5": anthropic(5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-8": anthropic(5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-7": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1": anthropic(15, 18.75, 30, 1.5, 75),
  "claude-opus-4": anthropic(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5-5": anthropic(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-5": anthropic(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-haiku-4-5": anthropic(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku": anthropic(0.8, 1, 1.6, 0.08, 4)
};
var openai = (input, cacheRead, cacheWrite, output, long) => ({
  provider: "OpenAI",
  input,
  output,
  cacheRead,
  // No separate write price: written tokens are billed as ordinary input.
  cacheWrite: cacheWrite ?? input,
  ...long ? {
    long: {
      threshold: 272e3,
      input: long[0],
      cacheRead: long[1],
      cacheWrite: long[2] ?? long[0],
      output: long[3]
    }
  } : {}
});
var OPENAI = {
  "gpt-6-astra": openai(10, 1, 12.5, 50, [20, 2, 25, 75]),
  "gpt-6.1-sol": openai(2, 0.1, 2.5, 10, [4, 0.2, 5, 15]),
  "gpt-6-sol": openai(2, 0.2, 2.5, 10, [4, 0.4, 5, 15]),
  "gpt-6-luna": openai(0.1, 0.01, 0.125, 0.5, [0.2, 0.02, 0.25, 0.75]),
  "gpt-5.6-sol": openai(4, 0.4, 5, 20, [8, 0.8, 10, 30]),
  "gpt-5.6-terra": openai(2, 0.2, 2.5, 12, [4, 0.4, 5, 18]),
  "gpt-5.6-luna": openai(0.2, 0.02, 0.25, 1.2, [0.4, 0.04, 0.5, 1.8]),
  "gpt-5.5": openai(5, 0.5, null, 30, [10, 1, null, 45]),
  "gpt-5.4": openai(2.5, 0.25, null, 15, [5, 0.5, null, 22.5]),
  "gpt-5.4-mini": openai(0.75, 0.075, null, 4.5),
  "gpt-5.3-codex": openai(1.75, 0.175, null, 14),
  "gpt-5.2": openai(1.75, 0.175, null, 14),
  "gpt-5.1": openai(1.25, 0.125, null, 10),
  "gpt-5": openai(1.25, 0.125, null, 10),
  "gpt-5-mini": openai(0.25, 0.025, null, 2)
};
function priceKey(model) {
  let m = model.toLowerCase().trim();
  m = m.replace(/\[[^\]]*\]$/, "");
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  m = m.replace(/-v\d+(?::\d+)?$/, "");
  m = m.replace(/@\d{8}$/, "");
  m = m.replace(/-\d{8}$/, "");
  m = m.replace(/-latest$/, "");
  if (m === "claude-opus-4-0") m = "claude-opus-4";
  if (m === "claude-sonnet-4-0") m = "claude-sonnet-4";
  return m;
}
function priceFor(model) {
  const key = priceKey(model);
  return ANTHROPIC[key] ?? OPENAI[key];
}
var pricedModels = () => [...Object.keys(ANTHROPIC), ...Object.keys(OPENAI)];
function apiEquivalentUsd(r) {
  const p = priceFor(r.model);
  if (!p) return null;
  const promptTokens = r.input + r.cacheRead + r.cacheWrite;
  let input = p.input;
  let output = p.output;
  let cacheRead = p.cacheRead;
  let cacheWrite = p.cacheWrite;
  let cacheWrite1h = p.cacheWrite1h ?? p.cacheWrite;
  if (p.long && promptTokens > p.long.threshold) {
    ({ input, output, cacheRead, cacheWrite } = p.long);
    cacheWrite1h = cacheWrite;
  }
  if (r.fast && p.fast) {
    const k = p.fast.input / p.input;
    input = p.fast.input;
    output = p.fast.output;
    cacheRead *= k;
    cacheWrite *= k;
    cacheWrite1h *= k;
  }
  const write1h = r.cacheWrite1h ?? 0;
  const write5m = r.cacheWrite - write1h;
  const usd2 = (r.input * input + r.output * output + r.cacheRead * cacheRead + write5m * cacheWrite + write1h * cacheWrite1h) / 1e6;
  return r.geoUs && p.provider === "Anthropic" ? usd2 * 1.1 : usd2;
}

// src/ledger.ts
var GROUP_BY = ["day", "project", "model", "client"];
var pad = (n) => String(n).padStart(2, "0");
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(now, daysBack = 0) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}
var Acc = class {
  requests = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  usd = 0;
  unpriced = 0;
  unpricedModels = /* @__PURE__ */ new Set();
  turns = /* @__PURE__ */ new Set();
  add(r) {
    this.requests += 1;
    this.input += r.input;
    this.output += r.output;
    this.cacheRead += r.cacheRead;
    this.cacheWrite += r.cacheWrite;
    if (r.turn) this.turns.add(r.turn);
    const usd2 = apiEquivalentUsd(r);
    if (usd2 === null) {
      this.unpriced += 1;
      this.unpricedModels.add(r.model);
    } else this.usd += usd2;
  }
  totals() {
    return {
      requests: this.requests,
      turns: this.turns.size,
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      tokens: totalTokens(this),
      apiEquivalentUsd: round2(this.usd),
      unpricedRequests: this.unpriced,
      unpricedModels: [...this.unpricedModels].sort()
    };
  }
};
var round2 = (n) => Math.round(n * 100) / 100;
function groupKey(r, by) {
  switch (by) {
    case "day":
      return dayKey(r.ts);
    case "project":
      return r.project || "(unknown folder)";
    case "model":
      return r.model;
    case "client":
      return CLIENT_LABEL[r.client];
  }
}
function totals(requests) {
  const acc = new Acc();
  for (const r of requests) acc.add(r);
  return acc.totals();
}
function groupRows(requests, by) {
  return rowsBy(requests, (r) => groupKey(r, by), by === "day");
}
function rowsByClientModel(requests) {
  return rowsBy(requests, (r) => `${CLIENT_LABEL[r.client]} \xB7 ${r.model}`, false);
}
function rowsBy(requests, keyOf, chronological) {
  const accs = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const key = keyOf(r);
    let acc = accs.get(key);
    if (!acc) accs.set(key, acc = new Acc());
    acc.add(r);
  }
  const rows = [...accs].map(([key, acc]) => ({ key, ...acc.totals() }));
  return chronological ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows.sort((a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd || b.tokens - a.tokens);
}
function fillDays(rows, from, to) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  for (let t = startOfDay(from); t <= to; ) {
    const key = dayKey(t);
    out.push(byKey.get(key) ?? { key, ...new Acc().totals() });
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    t = d.getTime();
  }
  return out;
}

// src/rates.ts
var METRICS = [
  "tokens_per_request",
  "cache_read_share",
  "cache_write_per_read",
  "tokens_per_turn",
  "cache_1h_write_share",
  "tokens_per_quota_percent"
];
var METRIC_LABEL = {
  tokens_per_request: "tokens per request",
  cache_read_share: "cache-read share of prompt tokens",
  cache_write_per_read: "cache writes per cache read",
  tokens_per_turn: "tokens per user turn",
  cache_1h_write_share: "share of cache writes at the 1-hour lifetime",
  tokens_per_quota_percent: "tokens per 1% of the 5-hour window"
};
var SHARE_METRICS = /* @__PURE__ */ new Set(["cache_read_share", "cache_1h_write_share"]);
var DEFAULTS = {
  minRequests: 20,
  window: 7,
  ratioThreshold: 0.3,
  shareThreshold: 0.1
};
var MIN_SIDE = 3;
var SEPARATION = 0.75;
var NOISE_SIGMAS = 3;
var MIN_TURNS = 3;
var DayAcc = class {
  requests = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  splitWrites = 0;
  writes1h = 0;
  turns = /* @__PURE__ */ new Set();
  versions = /* @__PURE__ */ new Map();
  add(r) {
    this.requests += 1;
    this.input += r.input;
    this.output += r.output;
    this.cacheRead += r.cacheRead;
    this.cacheWrite += r.cacheWrite;
    if (r.cacheWrite1h !== null) {
      this.splitWrites += r.cacheWrite;
      this.writes1h += r.cacheWrite1h;
    }
    if (r.turn) this.turns.add(r.turn);
    this.versions.set(r.version, (this.versions.get(r.version) ?? 0) + 1);
  }
  point(day, minRequests) {
    if (this.requests < minRequests) return void 0;
    const tokens2 = totalTokens(this);
    const prompt = this.input + this.cacheRead + this.cacheWrite;
    const values = { tokens_per_request: tokens2 / this.requests };
    if (prompt > 0) values.cache_read_share = this.cacheRead / prompt;
    if (this.cacheRead > 0) values.cache_write_per_read = this.cacheWrite / this.cacheRead;
    if (this.turns.size >= MIN_TURNS) values.tokens_per_turn = tokens2 / this.turns.size;
    if (this.splitWrites > 0) values.cache_1h_write_share = this.writes1h / this.splitWrites;
    let version2 = "";
    let most = -1;
    for (const [v, n] of this.versions) if (n > most) [version2, most] = [v, n];
    return {
      day,
      requests: this.requests,
      turns: this.turns.size,
      version: version2,
      values,
      cacheReadsPerRequest: this.cacheRead / this.requests,
      cacheWritesPerRequest: this.cacheWrite / this.requests
    };
  }
};
function dailySeries(requests, quota = [], opts = {}) {
  const { minRequests } = { ...DEFAULTS, ...opts };
  const groups = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const key = `${r.client}\0${r.model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { client: r.client, model: r.model, days: /* @__PURE__ */ new Map() });
    const day = dayKey(r.ts);
    let acc = g.days.get(day);
    if (!acc) g.days.set(day, acc = new DayAcc());
    acc.add(r);
  }
  const out = [];
  for (const g of groups.values()) {
    const days = [...g.days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, acc]) => acc.point(day, minRequests)).filter((p) => p !== void 0);
    if (days.length > 0) out.push({ client: g.client, model: g.model, days });
  }
  const q = quotaSeries(requests, quota, minRequests);
  if (q) out.push(q);
  return out.sort((a, b) => a.client.localeCompare(b.client) || a.model.localeCompare(b.model));
}
function quotaSeries(requests, quota, minRequests) {
  const primary = quota.filter(
    (s) => s.client === "codex" && s.slot === "primary" && s.resetsAt !== null
  );
  if (primary.length < 2) return void 0;
  const windows = /* @__PURE__ */ new Map();
  for (const s of primary) {
    const k = `${s.limitId}@${Math.round(s.resetsAt / 6e4)}`;
    const list = windows.get(k) ?? [];
    list.push(s);
    windows.set(k, list);
  }
  const codex = requests.filter((r) => r.client === "codex");
  const perDay = /* @__PURE__ */ new Map();
  for (const list of windows.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0];
    const last = list[list.length - 1];
    const moved = last.usedPercent - first.usedPercent;
    if (moved <= 0) continue;
    let tokens2 = 0;
    let n = 0;
    const versions = /* @__PURE__ */ new Map();
    for (const r of codex) {
      if (r.ts <= first.ts || r.ts > last.ts) continue;
      tokens2 += totalTokens(r);
      n += 1;
      versions.set(r.version, (versions.get(r.version) ?? 0) + 1);
    }
    if (n === 0) continue;
    const day = dayKey(last.ts);
    const acc = perDay.get(day) ?? { tokens: 0, points: 0, requests: 0, versions: /* @__PURE__ */ new Map() };
    acc.tokens += tokens2;
    acc.points += moved;
    acc.requests += n;
    for (const [v, c] of versions) acc.versions.set(v, (acc.versions.get(v) ?? 0) + c);
    perDay.set(day, acc);
  }
  const days = [];
  for (const [day, acc] of [...perDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (acc.requests < minRequests || acc.points < 2) continue;
    let version2 = "";
    let most = -1;
    for (const [v, c] of acc.versions) if (c > most) [version2, most] = [v, c];
    days.push({
      day,
      requests: acc.requests,
      turns: 0,
      version: version2,
      values: { tokens_per_quota_percent: acc.tokens / acc.points },
      cacheReadsPerRequest: 0,
      cacheWritesPerRequest: 0
    });
  }
  return days.length > 0 ? { client: "codex", model: "all models", days } : void 0;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(xs) {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}
function detectSteps(days, metric, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const share = SHARE_METRICS.has(metric);
  const pts = days.map((d) => ({ day: d.day, v: d.values[metric] })).filter(
    (p) => p.v !== void 0 && Number.isFinite(p.v) && // ratios are compared in log space, where a zero has no place: such days sit out
    (share || p.v > 0)
  );
  const out = [];
  let floor = 0;
  let i = MIN_SIDE;
  while (i <= pts.length - MIN_SIDE) {
    const candidates = [];
    for (let j = i; j <= pts.length - MIN_SIDE; j++) {
      const c = candidateAt(pts, j, Math.max(floor, j - o.window), o, share, metric);
      if (c) candidates.push(c);
      else if (candidates.length > 0) break;
    }
    if (candidates.length === 0) break;
    const best = candidates.reduce((a, b) => b.score > a.score ? b : a);
    out.push(best);
    const at = pts.findIndex((p) => p.day === best.date);
    floor = at;
    i = at + MIN_SIDE;
  }
  return out;
}
function candidateAt(pts, j, from, o, share, metric) {
  const before = pts.slice(from, j);
  const after = pts.slice(j, Math.min(pts.length, j + o.window));
  if (before.length < MIN_SIDE || after.length < MIN_SIDE) return void 0;
  const b = median(before.map((p) => p.v));
  const a = median(after.map((p) => p.v));
  let magnitude;
  if (share) {
    magnitude = Math.abs(a - b);
    if (magnitude < o.shareThreshold) return void 0;
  } else {
    if (b <= 0 || a <= 0) return void 0;
    magnitude = Math.abs(Math.log(a / b));
    if (magnitude < Math.log(1 + o.ratioThreshold)) return void 0;
  }
  const t = (v) => share ? v : Math.log(v);
  const tb = before.map((p) => t(p.v));
  const ta = after.map((p) => t(p.v));
  const mid = (t(a) + t(b)) / 2;
  const up = a > b;
  const sideAfter = ta.filter((v) => up ? v > mid : v < mid).length / ta.length;
  const sideBefore = tb.filter((v) => up ? v < mid : v > mid).length / tb.length;
  const beyond = Math.min(sideAfter, sideBefore);
  if (beyond < SEPARATION) return void 0;
  const noise = 1.4826 * Math.max(mad(tb), mad(ta));
  if (magnitude < NOISE_SIGMAS * noise) return void 0;
  return {
    metric,
    label: METRIC_LABEL[metric],
    date: pts[j].day,
    before: b,
    after: a,
    change: share ? a - b : a / b,
    beforeDays: [before[0].day, before[before.length - 1].day],
    afterDays: [after[0].day, after[after.length - 1].day],
    score: magnitude * beyond
  };
}
function rateReport(series, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];
  const baselines = [];
  for (const s of series) {
    const changes = METRICS.flatMap((m) => detectSteps(s.days, m, o));
    findings.push(...cluster(s, changes));
    const recent = s.days.slice(-o.window);
    const current = {};
    for (const m of METRICS) {
      const vs = recent.map((d) => d.values[m]).filter((v) => v !== void 0);
      if (vs.length > 0) current[m] = median(vs);
    }
    baselines.push({
      client: s.client,
      model: s.model,
      activeDays: s.days.length,
      firstDay: s.days[0].day,
      lastDay: s.days[s.days.length - 1].day,
      version: s.days[s.days.length - 1].version,
      current
    });
  }
  findings.sort((a, b) => b.date.localeCompare(a.date));
  return { method: methodText(o), findings, baselines };
}
function methodText(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return `Per client and model, daily figures from complete days with at least ${o.minRequests} requests. A day is flagged when the median of it and up to ${o.window - 1} active days after differs from the median of up to ${o.window} active days before by at least ${Math.round(o.ratioThreshold * 100)}% (${Math.round(o.shareThreshold * 100)} percentage points for shares), at least 3/4 of the days on each side sit on their own side of the midpoint, and the difference exceeds ${NOISE_SIGMAS}x the day-to-day spread. Findings say what moved and what it is consistent with; they cannot see the vendor's side.`;
}
var METHOD = methodText();
function cluster(s, changes) {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  const index = (day) => s.days.findIndex((d) => d.day === day);
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && index(c.date) - index(g[0].date) <= 2) g.push(c);
    else groups.push([c]);
  }
  return groups.map((g) => finding(s, g));
}
function finding(s, changes) {
  const lead = changes.reduce((a, b) => b.score > a.score ? b : a);
  const at = s.days.findIndex((d) => d.day === lead.date);
  const day = s.days[at];
  const prev = s.days[at - 1];
  const before = s.days.slice(Math.max(0, at - 7), at);
  const after = s.days.slice(at, at + 7);
  const med = (xs, f2) => xs.length ? median(xs.map(f2)) : 0;
  const reads = [
    med(before, (d) => d.cacheReadsPerRequest),
    med(after, (d) => d.cacheReadsPerRequest)
  ];
  const writes = [
    med(before, (d) => d.cacheWritesPerRequest),
    med(after, (d) => d.cacheWritesPerRequest)
  ];
  const earlierVersions = new Set(s.days.slice(0, at).map((d) => d.version));
  const versionChanged = !!prev && day.version !== prev.version && !earlierVersions.has(day.version);
  const f = {
    client: s.client,
    model: s.model,
    date: lead.date,
    version: day.version,
    previousVersion: prev?.version ?? "",
    versionChanged,
    changes: [...changes].sort((a, b) => b.score - a.score),
    cacheReadsPerRequest: reads,
    cacheWritesPerRequest: writes,
    sentence: "",
    consistentWith: ""
  };
  f.consistentWith = interpret(f);
  f.sentence = describe(f);
  return f;
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var shortDate = (day) => {
  const [, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
};
function movement(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return "changed";
  if (ratio >= 1.9 && ratio < 2.15) return "doubled";
  if (ratio >= 2.15) return `rose ${ratio.toFixed(1)}x`;
  if (ratio > 1) return `rose ${Math.round((ratio - 1) * 100)}%`;
  if (ratio <= 0.55 && ratio > 0.45) return "halved";
  return `fell ${Math.round((1 - ratio) * 100)}%`;
}
var pct = (x) => `${Math.round(x * 100)}%`;
function describe(f) {
  const client = CLIENT_LABEL[f.client];
  const clauses = [];
  const has = (m) => f.changes.find((c) => c.metric === m);
  const cacheMoved = has("cache_read_share") || has("cache_write_per_read") || has("cache_1h_write_share");
  if (cacheMoved && f.cacheReadsPerRequest[0] > 0 && f.cacheWritesPerRequest[0] > 0) {
    clauses.push(
      `cache reads per request ${movement(f.cacheReadsPerRequest[1] / f.cacheReadsPerRequest[0])}`,
      `cache writes per request ${movement(f.cacheWritesPerRequest[1] / f.cacheWritesPerRequest[0])}`
    );
  }
  for (const c of f.changes) {
    if (c.metric === "cache_write_per_read" && clauses.length > 0) continue;
    clauses.push(
      SHARE_METRICS.has(c.metric) ? `the ${c.label} went from ${pct(c.before)} to ${pct(c.after)}` : `${c.label} ${movement(c.change)}`
    );
  }
  const list = clauses.length <= 1 ? clauses[0] ?? "" : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  const where = `${client} ${f.version || "(version not recorded)"}`;
  const on = f.versionChanged ? `${where}, the first day on it` : where;
  const subject = f.model === "all models" ? `across ${client} models` : `on ${f.model}`;
  return `From ${shortDate(f.date)} (${on}), ${list} ${subject} \u2014 ${f.consistentWith}`;
}
function interpret(f) {
  const get = (m) => f.changes.find((c) => c.metric === m);
  const parts = [];
  const h1 = get("cache_1h_write_share");
  const readShare = get("cache_read_share");
  const writePerRead = get("cache_write_per_read");
  const perRequest = get("tokens_per_request");
  const perTurn = get("tokens_per_turn");
  const quota = get("tokens_per_quota_percent");
  if (h1) {
    parts.push(
      h1.change < 0 ? "the transcript itself shows writes moving from the 1-hour to the 5-minute cache lifetime, so a pause of more than five minutes now pays for a new cache write" : "the transcript itself shows writes moving from the 5-minute to the 1-hour cache lifetime (1-hour writes cost 2x input instead of 1.25x, and survive longer pauses)"
    );
  } else if (readShare && readShare.change < 0 || writePerRead && writePerRead.change > 1) {
    parts.push(
      "consistent with a shorter cache lifetime, or a prompt prefix that changes more often, so the cache is written again instead of read"
    );
  } else if (readShare && readShare.change > 0 || writePerRead && writePerRead.change < 1) {
    parts.push("consistent with a longer cache lifetime or a more stable prompt prefix");
  }
  if (perRequest && !readShare && !writePerRead && !h1) {
    parts.push(
      perRequest.change > 1 ? "consistent with a larger prompt on every request (system prompt, tool, skill or MCP definitions) or larger contexts in your own work" : "consistent with a smaller fixed prompt, earlier compaction, or smaller contexts in your own work"
    );
  }
  if (perTurn && !perRequest) {
    parts.push(
      perTurn.change > 1 ? "consistent with more requests per turn: more tool calls or subagents for each prompt" : "consistent with fewer requests per turn"
    );
  }
  if (quota) {
    parts.push(
      quota.change < 1 ? "consistent with a smaller allowance per token: the same tokens now use more of the 5-hour window (usage on other devices on the same account also lowers this)" : "consistent with a larger allowance per token, or with less usage on other devices on the same account"
    );
  }
  if (parts.length === 0) parts.push("a step change in how this model's requests use tokens");
  const versionNote = f.versionChanged ? `It starts with ${CLIENT_LABEL[f.client]} ${f.version}${f.previousVersion ? ` (previously ${f.previousVersion})` : ""}.` : f.model === "all models" ? "" : `There was no ${CLIENT_LABEL[f.client]} version change that day, so a change in your own work is as likely.`;
  return `${parts.join("; ")}.${versionNote ? " " + versionNote : ""}`;
}

// src/limits.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "fs";
import path4 from "path";
var WINDOWS = ["5h", "weekly"];
var FIVE_HOURS = 5 * 36e5;
var WEEK = 7 * 864e5;
var limitsPath = (home) => path4.join(home, "limits.json");
function readLimits(home) {
  try {
    const f = JSON.parse(readFileSync2(limitsPath(home), "utf8"));
    return Array.isArray(f.limits) ? f.limits.filter(isLimit) : [];
  } catch {
    return [];
  }
}
function isLimit(v) {
  const l = v;
  return !!l && WINDOWS.includes(l.window) && (l.client === "all" || l.client === "claude-code" || l.client === "codex") && (typeof l.tokens === "number" || typeof l.usd === "number");
}
function writeLimits(home, limits) {
  mkdirSync2(home, { recursive: true, mode: 448 });
  const file = limitsPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify({ v: 1, limits }, null, 2) + "\n", {
    mode: 384
  });
  renameSync2(tmp, file);
}
function setLimit(home, limit, now = Date.now()) {
  const rest = readLimits(home).filter(
    (l) => !(l.window === limit.window && l.client === limit.client)
  );
  const next = [...rest, { ...limit, setAt: new Date(now).toISOString() }];
  writeLimits(home, next);
  return next;
}
function clearLimits(home, window, client) {
  const next = readLimits(home).filter(
    (l) => window !== void 0 && l.window !== window || client !== void 0 && l.client !== client
  );
  writeLimits(home, next);
  return next;
}
var measure = (r, unit) => unit === "tokens" ? totalTokens(r) : apiEquivalentUsd(r) ?? 0;
function fiveHourWindows(sorted) {
  const out = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && r.ts < cur.start + FIVE_HOURS) cur.records.push(r);
    else out.push({ start: r.ts, records: [r] });
  }
  return out;
}
function limitStatus(limit, requests, now) {
  const unit = limit.tokens !== void 0 ? "tokens" : "usd";
  const amount = limit.tokens ?? limit.usd;
  const mine = requests.filter((r) => limit.client === "all" || r.client === limit.client).filter((r) => r.ts <= now).sort((a, b) => a.ts - b.ts);
  if (limit.window === "5h") {
    const windows = fiveHourWindows(mine);
    let busiest = null;
    for (const w of windows) {
      if (w.start < now - 30 * 864e5) continue;
      const used3 = w.records.reduce((s, r) => s + measure(r, unit), 0);
      if (!busiest || used3 > busiest.used) busiest = { start: w.start, used: used3 };
    }
    const last = windows[windows.length - 1];
    const open = last && now < last.start + FIVE_HOURS ? last : void 0;
    if (!open) {
      return {
        limit,
        unit,
        amount,
        used: 0,
        fraction: 0,
        windowStart: null,
        windowEnd: null,
        burnPerHour: 0,
        reachedAt: null,
        reached: false,
        busiest
      };
    }
    const end = open.start + FIVE_HOURS;
    let used2 = 0;
    let reachedAt2 = null;
    for (const r of open.records) {
      used2 += measure(r, unit);
      if (reachedAt2 === null && used2 >= amount) reachedAt2 = r.ts;
    }
    const elapsedH = Math.max((now - open.start) / 36e5, 1 / 12);
    const burn2 = used2 / elapsedH;
    if (reachedAt2 === null && burn2 > 0) {
      const eta = now + (amount - used2) / burn2 * 36e5;
      reachedAt2 = eta < end ? eta : null;
    }
    return {
      limit,
      unit,
      amount,
      used: used2,
      fraction: used2 / amount,
      windowStart: open.start,
      windowEnd: end,
      burnPerHour: burn2,
      reachedAt: reachedAt2,
      reached: used2 >= amount,
      busiest
    };
  }
  const start = now - WEEK;
  const week = mine.filter((r) => r.ts > start);
  const used = week.reduce((s, r) => s + measure(r, unit), 0);
  const lastDay = week.filter((r) => r.ts > now - 864e5);
  const burn = lastDay.reduce((s, r) => s + measure(r, unit), 0) / 24;
  let reachedAt = null;
  if (used >= amount) {
    let acc = 0;
    for (const r of week) {
      acc += measure(r, unit);
      if (acc >= amount) {
        reachedAt = r.ts;
        break;
      }
    }
  } else if (burn > 0) {
    reachedAt = now + (amount - used) / burn * 36e5;
  }
  return {
    limit,
    unit,
    amount,
    used,
    fraction: used / amount,
    windowStart: start,
    windowEnd: null,
    burnPerHour: burn,
    reachedAt,
    reached: used >= amount,
    busiest: null
  };
}
function vendorReadings(quota, now) {
  const latest = /* @__PURE__ */ new Map();
  for (const q of quota) {
    const k = `${q.client}/${q.limitId}/${q.slot}`;
    const prev = latest.get(k);
    if (!prev || q.ts >= prev.ts) latest.set(k, q);
  }
  return [...latest.values()].map((q) => ({
    client: q.client,
    limitId: q.limitId,
    slot: q.slot,
    windowMinutes: q.windowMinutes,
    usedPercent: q.usedPercent,
    resetsAt: q.resetsAt,
    planType: q.planType,
    readAt: q.ts,
    current: q.resetsAt === null || q.resetsAt > now
  })).sort((a, b) => a.limitId.localeCompare(b.limitId) || a.slot.localeCompare(b.slot));
}

// src/views.ts
var API_EQUIVALENT_NOTE = "API-equivalent: what these tokens would cost at the vendor's API list prices. Not what you were billed; a seat is a flat fee with an allowance.";
var common = (loaded, now) => ({
  generatedAt: new Date(now).toISOString(),
  apiEquivalentNote: API_EQUIVALENT_NOTE,
  prices: PRICE_SOURCES,
  sources: loaded.sources
});
var filterClient = (rs, client) => client ? rs.filter((r) => r.client === client) : rs;
function summaryView(loaded, now, home, client) {
  const requests = filterClient(loaded.requests, client).filter((r) => r.ts <= now);
  const todayStart = startOfDay(now);
  const weekStart = startOfDay(now, 6);
  const today = requests.filter((r) => r.ts >= todayStart);
  const week = requests.filter((r) => r.ts >= weekStart);
  const days = fillDays(groupRows(week, "day"), weekStart, now);
  return {
    ...common(loaded, now),
    today: {
      day: days[days.length - 1].key,
      rows: rowsByClientModel(today),
      totals: totals(today)
    },
    last7Days: { from: days[0].key, to: days[days.length - 1].key, days, totals: totals(week) },
    limits: readLimits(home).filter((l) => !client || l.client === "all" || l.client === client).map((l) => limitStatus(l, loaded.requests, now)),
    vendorReadings: vendorReadings(
      loaded.quota.filter((q) => !client || q.client === client),
      now
    )
  };
}
function reportView(loaded, now, by, since, client) {
  const requests = filterClient(loaded.requests, client).filter(
    (r) => r.ts <= now && (since === void 0 || r.ts >= since)
  );
  let rows = groupRows(requests, by);
  if (by === "day" && since !== void 0) rows = fillDays(rows, since, now);
  return {
    ...common(loaded, now),
    by,
    from: since === void 0 ? null : new Date(since).toISOString(),
    client: client ?? null,
    rows,
    totals: totals(requests)
  };
}
function ratesView(loaded, now, since, filter = {}, opts = {}) {
  const today = startOfDay(now);
  const requests = filterClient(loaded.requests, filter.client).filter(
    (r) => r.ts < today && (since === void 0 || r.ts >= since)
  );
  const quota = loaded.quota.filter(
    (q) => (!filter.client || q.client === filter.client) && q.ts < today && (since === void 0 || q.ts >= since)
  );
  let series = dailySeries(requests, quota, opts);
  if (filter.model) series = series.filter((s) => s.model === filter.model);
  return {
    ...common(loaded, now),
    from: since === void 0 ? null : new Date(since).toISOString(),
    ...rateReport(series, opts)
  };
}
function parseSince(value, now) {
  const v = value.trim();
  const rel = /^(\d{1,4})\s*([dw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]) * (rel[2].toLowerCase() === "w" ? 7 : 1);
    return startOfDay(now, Math.max(0, n - 1));
  }
  const abs = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (abs) {
    const d = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]));
    if (!Number.isNaN(d.getTime()) && d.getDate() === Number(abs[3])) return d.getTime();
  }
  throw new Error(`--since takes a date like 2026-09-01 or a span like 30d or 12w, not "${value}"`);
}

// src/mcp.ts
import { createInterface as createInterface2 } from "readline";

// src/team.ts
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "fs";
import os from "os";
import path5 from "path";

// src/version.ts
import { readFileSync as readFileSync3 } from "fs";
var cached;
function version() {
  if (cached !== void 0) return cached;
  try {
    cached = JSON.parse(readFileSync3(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

// src/team.ts
var DEFAULT_URL = "https://agentwares-agentcheck.vercel.app";
var TIMEOUT_MS = 3e4;
var teamFile = (home) => path5.join(home, "team.json");
function readTeamConfig(home, env = process.env) {
  let saved = {};
  const file = teamFile(home);
  if (existsSync2(file)) {
    try {
      saved = JSON.parse(readFileSync4(file, "utf8"));
    } catch {
      saved = {};
    }
  }
  const key = env.SEATLEDGER_KEY?.trim() || saved.key;
  if (!key) return null;
  const url = (env.SEATLEDGER_URL?.trim() || saved.url || DEFAULT_URL).replace(/\/+$/, "");
  return { ...saved, key, url };
}
var TeamApiError = class extends Error {
  constructor(code, cause_, fix, retryable, status = 0) {
    super(`${code}: ${cause_}`);
    this.code = code;
    this.cause_ = cause_;
    this.fix = fix;
    this.retryable = retryable;
    this.status = status;
  }
  code;
  cause_;
  fix;
  retryable;
  status;
  toJSON() {
    return { code: this.code, cause: this.cause_, fix: this.fix, retryable: this.retryable };
  }
};
async function callApi(base, method, route, opts = {}) {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const url = `${base.replace(/\/+$/, "")}${route}`;
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        "user-agent": `seatledger/${version()}`,
        accept: "application/json",
        ...opts.key ? { authorization: `Bearer ${opts.key}` } : {},
        ...opts.body !== void 0 ? { "content-type": "application/json" } : {}
      },
      ...opts.body !== void 0 ? { body: JSON.stringify(opts.body) } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new TeamApiError(
      "UNREACHABLE",
      `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      "check your connection and SEATLEDGER_URL, then try again",
      true
    );
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = void 0;
  }
  if (!res.ok) {
    const e = body ?? {};
    throw new TeamApiError(
      e.code ?? `HTTP_${res.status}`,
      e.cause ?? `${method} ${route} answered ${res.status}`,
      e.fix ?? "try again later",
      e.retryable ?? res.status >= 500,
      res.status
    );
  }
  if (body === void 0)
    throw new TeamApiError(
      "BAD_RESPONSE",
      `${method} ${route} did not answer JSON`,
      "check SEATLEDGER_URL points at the seatledger service",
      false,
      res.status
    );
  return body;
}

// src/push.ts
var PUSH_SCHEMA_ID = "seatledger.push/v1";
var MAX_DAYS_PER_PUSH = 400;
var MAX_ROWS_PER_PUSH = 5e3;
var fit = (value, allowed, max) => value.replace(allowed, "-").slice(0, max);
var modelId = (m) => m === "all models" ? "*" : fit(m, /[^A-Za-z0-9._:@/+-]+/g, 80).replace(/^[^A-Za-z0-9]+/, "") || "unknown";
var versionId = (v) => fit(v, /[^0-9A-Za-z.+_-]+/g, 40).replace(/^[^0-9A-Za-z]+/, "");
var projectId = (p) => fit(p, /[^A-Za-z0-9._-]+/g, 64);
var round = (n, places = 6) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
function nextDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + 1, 12).getTime());
}
function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = nextDay(d)) out.push(d);
  return out;
}
function toPushFinding(f) {
  return {
    client: f.client,
    model: modelId(f.model),
    date: f.date,
    version: versionId(f.version),
    previous_version: versionId(f.previousVersion),
    version_changed: f.versionChanged,
    changes: f.changes.map((c) => ({
      metric: c.metric,
      before: round(c.before),
      after: round(c.after),
      change: round(c.change)
    })),
    cache_reads_per_request: [round(f.cacheReadsPerRequest[0]), round(f.cacheReadsPerRequest[1])],
    cache_writes_per_request: [
      round(f.cacheWritesPerRequest[0]),
      round(f.cacheWritesPerRequest[1])
    ]
  };
}
function buildPushPayload(loaded, opts) {
  const sinceTs = startOfDay(opts.since);
  const inRange = loaded.requests.filter((r) => r.ts >= sinceTs && r.ts <= opts.now);
  const today = dayKey(opts.now);
  const first = inRange.reduce((m, r) => Math.min(m, r.ts), Infinity);
  const days = Number.isFinite(first) ? dayRange(dayKey(first), today) : [];
  const groups = /* @__PURE__ */ new Map();
  for (const r of inRange) {
    const day = dayKey(r.ts);
    const project = opts.projectNames && r.project ? projectId(r.project) : void 0;
    const key = [day, r.client, r.version, r.model, project ?? ""].join("\0");
    let g = groups.get(key);
    if (!g) {
      g = {
        row: {
          day,
          client: r.client,
          client_version: versionId(r.version),
          model: modelId(r.model),
          ...project ? { project } : {},
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          api_equivalent_usd: 0
        },
        unpriced: false
      };
      groups.set(key, g);
    }
    add(g, r);
  }
  const rows = [...groups.values()].map(({ row, unpriced }) => ({
    ...row,
    api_equivalent_usd: unpriced ? null : round(row.api_equivalent_usd ?? 0, 4)
  })).sort(
    (a, b) => a.day.localeCompare(b.day) || a.client.localeCompare(b.client) || a.model.localeCompare(b.model)
  );
  const findings = (opts.rates?.findings ?? []).map(toPushFinding);
  return { schema: PUSH_SCHEMA_ID, days, rows, findings };
}
function add(g, r) {
  g.row.requests += 1;
  g.row.input_tokens += r.input;
  g.row.output_tokens += r.output;
  g.row.cache_read_tokens += r.cacheRead;
  g.row.cache_write_tokens += r.cacheWrite;
  const usd2 = apiEquivalentUsd(r);
  if (usd2 === null) g.unpriced = true;
  else g.row.api_equivalent_usd = (g.row.api_equivalent_usd ?? 0) + usd2;
}
function splitPayload(p) {
  if (p.days.length === 0) return [];
  const rowsByDay = /* @__PURE__ */ new Map();
  for (const r of p.rows) rowsByDay.set(r.day, [...rowsByDay.get(r.day) ?? [], r]);
  const out = [];
  let cur = { schema: PUSH_SCHEMA_ID, days: [], rows: [], findings: [] };
  for (const day of p.days) {
    const dayRows = rowsByDay.get(day) ?? [];
    if (cur.days.length > 0 && (cur.days.length >= MAX_DAYS_PER_PUSH || cur.rows.length + dayRows.length > MAX_ROWS_PER_PUSH)) {
      out.push(cur);
      cur = { schema: PUSH_SCHEMA_ID, days: [], rows: [], findings: [] };
    }
    cur.days.push(day);
    cur.rows.push(...dayRows);
  }
  cur.findings = p.findings;
  out.push(cur);
  return out;
}

// src/team-commands.ts
async function teamSummary(ctx, since) {
  const cfg = readTeamConfig(ctx.home, ctx.env);
  if (!cfg)
    throw new TeamApiError(
      "NO_TEAM_KEY",
      "this machine has not joined a seatledger team",
      "run `npx seatledger team join <invite link> --as <name>` (the team owner has the link), or set SEATLEDGER_KEY",
      false
    );
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return callApi(cfg.url, "GET", `/api/seatledger/v1/summary${q}`, {
    key: cfg.key,
    ...ctx.fetch ? { fetch: ctx.fetch } : {}
  });
}

// src/mcp.ts
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var SINCE_PATTERN = "^(\\d{4}-\\d{2}-\\d{2}|\\d{1,4}[dDwW])$";
var annotations = (title, openWorld = false) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld
});
var clientProp = {
  type: "string",
  enum: [...CLIENTS],
  description: "Only this coding-agent client: `claude-code` (Claude Code transcripts) or `codex` (Codex CLI rollouts). Omitted: both."
};
var TOOLS = [
  {
    name: "seatledger_usage_summary",
    title: "Coding-agent usage on this machine",
    description: "Tokens and API-equivalent dollars from this machine's Claude Code and Codex transcripts, read locally. With no arguments: today by client and model, the last 7 days by day, progress against limits the user recorded with `seatledger limits set`, and the latest rate-limit readings Codex wrote to its own rollouts. With `since` or `group_by`: one table for that range, grouped by day, project folder, model or client. Tokens count input, output, cache reads and cache writes. API-equivalent means the same tokens at the vendor's API list prices (dated table, sources included); it is not what the user was billed, since a seat is a flat fee with an allowance. Requests on models without a list price are counted in tokens and listed as unpriced.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: SINCE_PATTERN,
          description: "Start of the range: a local date (`2026-09-01`) or a span back from today (`30d`, `12w`). Omitted with `group_by` set: 30d."
        },
        group_by: {
          type: "string",
          enum: [...GROUP_BY],
          description: "Group the range by local `day`, `project` (working-directory folder name), `model` or `client`. Omitted with `since` set: day."
        },
        client: clientProp
      },
      additionalProperties: false
    },
    annotations: annotations("Coding-agent usage on this machine")
  },
  {
    name: "seatledger_rate_changes",
    title: "Token rate changes",
    description: "Step changes in how this machine's coding-agent requests use tokens, per client and model: tokens per request, cache-read share of prompt tokens, cache writes per cache read, tokens per user turn, the share of Claude Code cache writes made at the 1-hour lifetime, and Codex tokens per 1% of its 5-hour window. Each finding has the date it starts, the client version in use and whether that was its first day, before and after medians, and what the change is consistent with. It sees only this machine's requests, not the vendor's servers, so it never states a cause. Also returns each model's current baseline and the method. Days with fewer than 20 requests are left out.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: SINCE_PATTERN,
          description: "Start of the history to examine: a local date (`2026-07-01`) or a span back from today (`90d`). Omitted: 90d."
        },
        client: clientProp,
        model: {
          type: "string",
          minLength: 1,
          description: "Only this model id, exactly as the client records it (e.g. `claude-opus-5-5`, `gpt-5.6-sol`). Omitted: every model."
        }
      },
      additionalProperties: false
    },
    annotations: annotations("Token rate changes")
  },
  {
    name: "seatledger_team_summary",
    title: "Team coding-agent ledger",
    description: "The hosted seatledger team ledger this machine joined with `seatledger team join`: what the team's coding-agent seats and tokens bought, from every developer's pushed daily aggregates. Returns team totals; tables by day, month, developer, model and client; and the rate-change findings feed, each with its date, the developer, the client version and whether that was its first day, and what the step is consistent with. A developer's key sees every team total and only their own row in `by_developer`; the owner key sees every developer. Dollars are API-equivalent (the same tokens at API list prices), not what anyone was billed. History is as long as the team's plan keeps (Free 30 days, Team and Business 13 months). Needs the key `seatledger team join` saved in ~/.seatledger/team.json, or SEATLEDGER_KEY; without one it returns NO_TEAM_KEY. This tool makes one HTTPS request to that ledger and changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: "^(\\d{4}-\\d{2}-\\d{2}|\\d{1,4}[dDwWmM])$",
          description: "Start of the range: a date (`2026-09-01`) or a span back from today (`30d`, `12w`, `13m`). Never earlier than the plan keeps. Omitted: everything the plan keeps."
        }
      },
      additionalProperties: false
    },
    annotations: annotations("Team coding-agent ledger", true)
  }
];
var InvalidInput = class extends Error {
  constructor(cause_, fix) {
    super(cause_);
    this.cause_ = cause_;
    this.fix = fix;
  }
  cause_;
  fix;
};
function checkArgs(tool, args) {
  if (args === void 0 || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new InvalidInput("arguments must be an object", "Pass an object, or omit arguments.");
  const props = tool.inputSchema.properties;
  for (const [k, v] of Object.entries(args)) {
    const spec = props[k];
    if (!spec)
      throw new InvalidInput(
        `unknown argument \`${k}\``,
        `Use only: ${Object.keys(props).join(", ")}.`
      );
    if (typeof v !== "string")
      throw new InvalidInput(`\`${k}\` must be a string`, `Pass \`${k}\` as a string.`);
    const allowed = spec.enum;
    if (allowed && !allowed.includes(v))
      throw new InvalidInput(`\`${k}\` is "${v}"`, `Use one of: ${allowed.join(", ")}.`);
    if (typeof spec.pattern === "string" && !new RegExp(spec.pattern).test(v))
      throw new InvalidInput(
        `\`${k}\` is "${v}"`,
        "Use a local date like 2026-09-01 or a span like 30d or 12w."
      );
    if (spec.minLength && v.length < Number(spec.minLength))
      throw new InvalidInput(`\`${k}\` is empty`, `Omit \`${k}\` or give a value.`);
  }
  return args;
}
async function callTool(name, rawArgs, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const now = ctx.now?.() ?? Date.now();
  const home = ctx.home ?? ctx.loadOptions?.home ?? seatledgerHome();
  try {
    const args = checkArgs(tool, rawArgs);
    if (name === "seatledger_team_summary") {
      const summary = await teamSummary(
        { home, env: ctx.env ?? process.env, ...ctx.fetch ? { fetch: ctx.fetch } : {} },
        typeof args.since === "string" ? args.since : void 0
      );
      return { structured: { view: "team", ...summary }, isError: false };
    }
    const client = args.client;
    const since = typeof args.since === "string" ? parseSince(args.since, now) : void 0;
    if (name === "seatledger_usage_summary") {
      if (since === void 0 && args.group_by === void 0) {
        const loaded3 = await load({ ...ctx.loadOptions, home });
        return {
          structured: { view: "summary", ...summaryView(loaded3, now, home, client) },
          isError: false
        };
      }
      const from2 = since ?? parseSince("30d", now);
      const loaded2 = await load({ ...ctx.loadOptions, home, since: from2 });
      const by = args.group_by ?? "day";
      return {
        structured: { view: "report", ...reportView(loaded2, now, by, from2, client) },
        isError: false
      };
    }
    const from = since ?? parseSince("90d", now);
    const loaded = await load({ ...ctx.loadOptions, home, since: from });
    const model = args.model;
    return { structured: { ...ratesView(loaded, now, from, { client, model }) }, isError: false };
  } catch (err) {
    const body = err instanceof InvalidInput ? { code: "INVALID_INPUT", cause: err.cause_, fix: err.fix, retryable: false } : err instanceof TeamApiError ? err.toJSON() : {
      code: "INTERNAL",
      cause: err instanceof Error ? err.message : String(err),
      fix: "Run `npx seatledger` in a terminal to see the same error with its context, and report it at https://github.com/agentwares/seatledger/issues.",
      retryable: false
    };
    return { structured: { ...body }, isError: true };
  }
}
var INSTRUCTIONS = "seatledger reads this machine's Claude Code and Codex transcripts locally and reports tokens, API-equivalent dollars, the user's own limits and step changes in token rates. Read-only. seatledger_usage_summary and seatledger_rate_changes make no network calls; seatledger_team_summary reads the hosted team ledger this machine joined, with its saved key.";
async function handleMessage(msg, ctx) {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== void 0
    );
    return out.length ? out : void 0;
  }
  const req = msg && typeof msg === "object" ? msg : {};
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code, message) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
  if (!("method" in req) && ("result" in req || "error" in req)) return void 0;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : void 0;
  }
  if (!hasId) return void 0;
  const params = req.params && typeof req.params === "object" ? req.params : {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "seatledger", title: "seatledger", version: version() },
          instructions: INSTRUCTIONS
        }
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
          `Unknown tool: ${String(name)}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError
        }
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}

// src/synthetic.ts
import { mkdirSync as mkdirSync4, writeFileSync as writeFileSync4 } from "fs";
import path6 from "path";
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var PROJECTS = ["webapp", "api-server", "infra"];
var DAY = 864e5;
function writeSyntheticHistory(opts) {
  const start = Date.parse(`${opts.start ?? "2026-08-25"}T00:00:00Z`);
  const days = opts.days ?? 44;
  const rand = rng(opts.seed ?? 7);
  const step = opts.step === false ? void 0 : Date.parse(`${(opts.step ?? { date: "2026-09-30" }).date}T00:00:00Z`);
  const codexStep = opts.codexStep === false ? void 0 : Date.parse(`${(opts.codexStep ?? { date: "2026-09-22" }).date}T00:00:00Z`);
  const claudeDir = path6.join(opts.dir, "claude", "projects");
  const codexDir = path6.join(opts.dir, "codex", "sessions");
  const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
  let claudeRequests = 0;
  let codexRequests = 0;
  let msg = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY;
    const weekend = new Date(dayStart).getUTCDay() % 6 === 0;
    const after = step !== void 0 && dayStart >= step;
    const version2 = after ? "2.1.230" : dayStart >= start + 12 * DAY ? "2.1.229" : "2.1.226";
    const sessions = weekend ? 1 : between(2, 3);
    let clock2 = dayStart + 9 * 36e5;
    for (let s = 0; s < sessions; s++) {
      const project = PROJECTS[(d + s) % PROJECTS.length];
      const session = `00000000-0000-4000-8000-${String(d * 10 + s).padStart(12, "0")}`;
      const lines = [];
      const sub = [];
      let context = 21e3;
      const turns = between(4, 7);
      for (let t2 = 0; t2 < turns; t2++) {
        clock2 += between(2, 9) * 6e4;
        lines.push(
          JSON.stringify({
            type: "user",
            sessionId: session,
            cwd: `/home/dev/${project}`,
            version: version2,
            isSidechain: false,
            timestamp: new Date(clock2).toISOString(),
            origin: { kind: "human" },
            message: { role: "user", content: "synthetic prompt" }
          })
        );
        const requests = between(4, 9);
        for (let q = 0; q < requests; q++) {
          clock2 += between(10, 70) * 1e3;
          const fresh = between(1500, 4500);
          const miss = rand() < (after ? 0.42 : 0.04);
          const cacheRead = miss ? 0 : context;
          const cacheWrite = miss ? context + fresh : fresh;
          context += fresh;
          const output = between(150, 1800);
          const sidechain = q === requests - 1 && t2 % 3 === 2;
          const id = `msg_synthetic_${++msg}`;
          const usage = (out2) => ({
            input_tokens: between(2, 12),
            cache_creation_input_tokens: cacheWrite,
            cache_read_input_tokens: cacheRead,
            cache_creation: after ? { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite },
            output_tokens: out2,
            service_tier: "standard",
            speed: "standard"
          });
          const line = (out2, stop) => JSON.stringify({
            type: "assistant",
            sessionId: session,
            cwd: `/home/dev/${project}`,
            version: version2,
            isSidechain: sidechain,
            requestId: `req_synthetic_${msg}`,
            timestamp: new Date(clock2).toISOString(),
            message: {
              id,
              model: "claude-opus-5-5",
              role: "assistant",
              type: "message",
              content: [{ type: "text", text: "synthetic reply" }],
              stop_reason: stop,
              usage: usage(out2)
            }
          });
          const target = sidechain ? sub : lines;
          target.push(line(Math.round(output / 3), null), line(output, "tool_use"));
          if (sidechain) lines.push(line(output, "tool_use"));
          lines.push(
            JSON.stringify({
              type: "user",
              sessionId: session,
              timestamp: new Date(clock2 + 500).toISOString(),
              message: { role: "user", content: [{ type: "tool_result", content: "synthetic" }] }
            })
          );
          claudeRequests += 1;
        }
      }
      for (let h = 0; h < 3; h++) {
        clock2 += 2e4;
        lines.push(
          JSON.stringify({
            type: "assistant",
            sessionId: session,
            cwd: `/home/dev/${project}`,
            version: version2,
            requestId: `req_haiku_${msg}_${h}`,
            timestamp: new Date(clock2).toISOString(),
            message: {
              id: `msg_haiku_${msg}_${h}`,
              model: "claude-haiku-4-5-20251001",
              content: [{ type: "text", text: "synthetic" }],
              usage: {
                input_tokens: 900,
                output_tokens: 40,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0
              }
            }
          })
        );
        claudeRequests += 1;
      }
      const dir2 = path6.join(claudeDir, `-home-dev-${project}`);
      mkdirSync4(dir2, { recursive: true });
      writeFileSync4(path6.join(dir2, `${session}.jsonl`), lines.join("\n") + "\n");
      if (sub.length > 0) {
        const subDir = path6.join(dir2, session, "subagents");
        mkdirSync4(subDir, { recursive: true });
        writeFileSync4(path6.join(subDir, "agent-synthetic.jsonl"), sub.join("\n") + "\n");
      }
    }
    if (weekend) continue;
    const codexAfter = codexStep !== void 0 && dayStart >= codexStep;
    const cli = codexAfter ? "0.159.0" : "0.158.0";
    const tokensPerPercent = codexAfter ? 4e4 : 8e4;
    const thread = `11111111-0000-4000-8000-${String(d).padStart(12, "0")}`;
    const begin = dayStart + 13 * 36e5;
    const resetsAt = Math.round((begin + 5 * 36e5) / 1e3);
    const out = [
      JSON.stringify({
        timestamp: new Date(begin).toISOString(),
        type: "session_meta",
        payload: {
          id: thread,
          cwd: "/home/dev/api-server",
          cli_version: cli,
          originator: "codex_cli_rs"
        }
      })
    ];
    let t = begin;
    let total = 0;
    let codexContext = 12e3;
    const turnsToday = between(5, 7);
    for (let turn = 0; turn < turnsToday; turn++) {
      const turnId = `turn-${d}-${turn}`;
      t += between(3, 8) * 6e4;
      out.push(
        JSON.stringify({
          timestamp: new Date(t).toISOString(),
          type: "turn_context",
          payload: { turn_id: turnId, model: "gpt-5.6-sol", cwd: "/home/dev/api-server" }
        })
      );
      const responses = between(4, 6);
      for (let r = 0; r < responses; r++) {
        t += between(15, 60) * 1e3;
        const fresh = between(800, 3e3);
        const cached2 = Math.round(codexContext * 0.9);
        const input = codexContext + fresh;
        codexContext += fresh;
        const output = between(200, 1500);
        const usage = {
          input_tokens: input,
          cached_input_tokens: cached2,
          cache_write_input_tokens: fresh,
          output_tokens: output,
          reasoning_output_tokens: Math.round(output / 2),
          total_tokens: input + output
        };
        total += input + output;
        const used = Math.min(100, total / tokensPerPercent);
        out.push(
          JSON.stringify({
            timestamp: new Date(t).toISOString(),
            type: "token_usage_record",
            payload: {
              thread_id: thread,
              turn_id: turnId,
              root_turn_id: turnId,
              response_id: `resp_${d}_${turn}_${r}`,
              usage
            }
          }),
          JSON.stringify({
            timestamp: new Date(t + 10).toISOString(),
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { ...usage, total_tokens: total },
                last_token_usage: usage,
                model_context_window: 4e5
              },
              rate_limits: {
                limit_id: "codex",
                primary: {
                  used_percent: Math.round(used * 10) / 10,
                  window_minutes: 300,
                  resets_at: resetsAt
                },
                secondary: {
                  used_percent: Math.round(used / 4),
                  window_minutes: 10080,
                  resets_at: resetsAt + 4 * 86400
                },
                plan_type: "pro"
              }
            }
          })
        );
        codexRequests += 1;
      }
    }
    const date = new Date(dayStart).toISOString().slice(0, 10).split("-");
    const dir = path6.join(codexDir, date[0], date[1], date[2]);
    mkdirSync4(dir, { recursive: true });
    writeFileSync4(
      path6.join(
        dir,
        `rollout-${new Date(begin).toISOString().slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`
      ),
      out.join("\n") + "\n"
    );
  }
  return {
    claudeDir,
    codexDir,
    now: start + (days - 1) * DAY + 16 * 36e5,
    claudeRequests,
    codexRequests
  };
}

// src/demo.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path7 from "path";

// src/format.ts
function tokens(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
function int(n) {
  return Math.round(n).toLocaleString("en-US");
}
function usd(n) {
  if (n >= 1e3) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}
function percent(x) {
  return `${Math.round(x * 100)}%`;
}
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${DAYS[date.getDay()]} ${d} ${MONTHS2[m - 1]}`;
}
function clock(ts, now) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hm;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS2[d.getMonth()]} ${hm}`;
}
function duration(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.round(h / 24)}d`;
}
function table(head, rows, align = []) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells2) => cells2.map(
    (c, i) => (align[i] ?? (i === 0 ? "left" : "right")) === "right" ? c.padStart(widths[i]) : c.padEnd(widths[i])
  ).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].map((l) => `  ${l}`).join("\n");
}

// src/render.ts
var HEAD = [
  "",
  "requests",
  "input",
  "output",
  "cache write",
  "cache read",
  "tokens",
  "API-equiv $"
];
function cells(key, t) {
  return [
    key,
    int(t.requests),
    tokens(t.input),
    tokens(t.output),
    tokens(t.cacheWrite),
    tokens(t.cacheRead),
    tokens(t.tokens),
    t.requests === 0 ? "\u2014" : usd(t.apiEquivalentUsd) + (t.unpricedRequests > 0 ? "*" : "")
  ];
}
function ledgerTable(rows, total, label = (k) => k) {
  const body = rows.map((r) => cells(label(r.key), r));
  if (rows.length > 1) body.push(cells("total", total));
  return table(HEAD, body);
}
function unpricedNote(t) {
  if (t.unpricedRequests === 0) return [];
  return [
    `  * excludes ${int(t.unpricedRequests)} requests on models with no API list price (${t.unpricedModels.join(", ")}); their tokens are counted.`
  ];
}
function renderSummary(v, now) {
  const out = [];
  out.push("seatledger \u2014 what your coding-agent seats and tokens bought, from this machine");
  out.push("");
  out.push(`Today, ${dayLabel(v.today.day)}`);
  out.push(
    v.today.rows.length === 0 ? "  no requests yet today" : ledgerTable(v.today.rows, v.today.totals)
  );
  out.push(...unpricedNote(v.today.totals));
  out.push("");
  out.push(`Last 7 days, ${dayLabel(v.last7Days.from)} \u2013 ${dayLabel(v.last7Days.to)}`);
  out.push(ledgerTable(v.last7Days.days, v.last7Days.totals, dayLabel));
  out.push(...unpricedNote(v.last7Days.totals));
  out.push("");
  out.push(...renderLimits(v.limits, v.vendorReadings, now));
  out.push("");
  out.push(
    wrap(`API-equiv $ = ${v.apiEquivalentNote.replace(/^API-equivalent: /, "")}`, 100, "  ")
  );
  out.push(...renderSources(v.sources));
  out.push(
    "More: seatledger report --by project \xB7 seatledger rates \xB7 seatledger limits set --window 5h --tokens N"
  );
  return out.join("\n");
}
function renderLimits(limits, readings, now) {
  const out = [];
  if (limits.length === 0) {
    out.push("Limits: none set. `seatledger limits set --window 5h --tokens N` records your own;");
    out.push("  seatledger does not guess a vendor's plan limits.");
  } else {
    out.push("Your limits");
    for (const s of limits) out.push(`  ${limitLine(s, now)}`);
  }
  const current = readings.filter((r) => r.current);
  if (current.length > 0) {
    out.push("Vendor readings, as the client last wrote them to disk");
    for (const r of current) out.push(`  ${readingLine(r, now)}`);
  }
  return out;
}
var amountOf = (s, n) => s.unit === "tokens" ? `${tokens(n)} tokens` : usd(n);
function limitLine(s, now) {
  const scope = s.limit.client === "all" ? "all clients" : CLIENT_LABEL[s.limit.client];
  const name = s.limit.window === "5h" ? "5-hour window" : "last 7 days";
  const head = `${name}, ${scope}: ${amountOf(s, s.used)} of ${amountOf(s, s.amount)} (${percent(s.fraction)})`;
  if (s.limit.window === "5h" && s.windowStart === null) {
    const b = s.busiest ? `; busiest window in 30 days: ${amountOf(s, s.busiest.used)} (${clock(s.busiest.start, now)})` : "";
    return `${head} \u2014 no window open${b}`;
  }
  const burn = `burning ${amountOf(s, s.burnPerHour)}/h`;
  if (s.reached && s.reachedAt !== null) return `${head} \u2014 reached at ${clock(s.reachedAt, now)}`;
  if (s.reachedAt !== null)
    return `${head} \xB7 ${burn} \xB7 at this rate reached ${clock(s.reachedAt, now)} (in ${duration(s.reachedAt - now)})`;
  if (s.windowEnd !== null)
    return `${head} \xB7 ${burn} \xB7 window resets ${clock(s.windowEnd, now)} before you reach it`;
  return `${head} \xB7 ${burn}`;
}
function readingLine(r, now) {
  const name = r.windowMinutes === 300 ? "5-hour window" : r.windowMinutes === 10080 ? "weekly window" : r.windowMinutes ? `${duration(r.windowMinutes * 6e4)} window` : `${r.slot} window`;
  const resets = r.resetsAt ? `, resets ${clock(r.resetsAt, now)}` : "";
  const plan = r.planType ? `, plan ${r.planType}` : "";
  return `${CLIENT_LABEL[r.client]} ${name}: ${Math.round(r.usedPercent)}% used${resets}${plan} (read ${clock(r.readAt, now)})`;
}
function renderSources(sources) {
  const parts = sources.filter((s) => s.files > 0 || s.retained > 0).map((s) => {
    const kept = s.retained > 0 ? ` + ${int(s.retained)} kept after the client deleted them` : "";
    return `${int(s.files)} ${CLIENT_LABEL[s.client]} transcripts${kept}`;
  });
  if (parts.length === 0) {
    const where = sources.map((s) => s.roots.join(", ")).join("; ");
    return [`No transcripts found (looked in ${where}). Nothing was sent anywhere.`];
  }
  return [
    wrap(
      `Read ${parts.join(" and ")}, on this machine only. Nothing was sent anywhere.`,
      100,
      "  "
    )
  ];
}
function metricValue(m, v) {
  if (m === "cache_read_share" || m === "cache_1h_write_share") return percent(v);
  if (m === "cache_write_per_read") return v.toFixed(3);
  return tokens(v);
}
function renderRates(v) {
  const out = [];
  out.push("seatledger rates \u2014 has the same work started costing a different number of tokens?");
  out.push("");
  if (v.findings.length === 0) {
    out.push("  No step changes found.");
  } else {
    out.push(`  ${v.findings.length} step change${v.findings.length === 1 ? "" : "s"} found:`);
    for (const f of v.findings) {
      out.push("");
      out.push("  " + wrap(`\u2022 ${f.sentence}`, 96, "    "));
      for (const c of f.changes) {
        out.push(
          `      ${c.label}: ${metricValue(c.metric, c.before)} \u2192 ${metricValue(c.metric, c.after)}  (${shortDate(c.beforeDays[0])}\u2013${shortDate(c.beforeDays[1])} vs ${shortDate(c.afterDays[0])}\u2013${shortDate(c.afterDays[1])})`
        );
      }
    }
  }
  out.push("");
  out.push("Current baselines (median of the last 7 active days)");
  const metrics = METRICS.filter((m) => v.baselines.some((b) => b.current[m] !== void 0));
  const shortLabel = {
    tokens_per_request: "tok/req",
    cache_read_share: "cache-read",
    cache_write_per_read: "write/read",
    tokens_per_turn: "tok/turn",
    cache_1h_write_share: "1h writes",
    tokens_per_quota_percent: "tok/1% 5h"
  };
  out.push(
    table(
      ["", "days", "version", ...metrics.map((m) => shortLabel[m])],
      v.baselines.map((b) => [
        `${CLIENT_LABEL[b.client]} \xB7 ${b.model}`,
        String(b.activeDays),
        b.version || "\u2014",
        ...metrics.map((m) => b.current[m] === void 0 ? "\u2014" : metricValue(m, b.current[m]))
      ])
    )
  );
  out.push("");
  out.push(
    wrap(
      `${metrics.map((m) => `${shortLabel[m]} = ${METRIC_LABEL[m]}`).join("; ")}. Tokens count input, output, cache reads and cache writes.`,
      100,
      ""
    )
  );
  out.push(wrap(`Method: ${v.method}`, 100, ""));
  out.push(...renderSources(v.sources));
  return out.join("\n");
}
function wrap(text, width, indent) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = indent + w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// src/demo.ts
async function runDemo() {
  const dir = mkdtempSync(path7.join(tmpdir(), "seatledger-demo-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const home = path7.join(dir, "home");
    const loaded = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home
    });
    const summary = summaryView(loaded, synth.now, home);
    const rates = ratesView(loaded, synth.now, void 0);
    return {
      summary,
      rates,
      summaryText: renderSummary(summary, synth.now),
      ratesText: renderRates(rates),
      now: synth.now
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function screenshotText(demo) {
  const rates = demo.ratesText.split("\n");
  const end = rates.findIndex((l) => l.startsWith("Current baselines"));
  return [
    "$ npx seatledger",
    demo.summaryText,
    "",
    "$ npx seatledger rates",
    ...rates.slice(0, end > 0 ? end : rates.length)
  ].join("\n").trimEnd();
}
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function textToSvg(text) {
  const lines = text.split("\n");
  const charW = 7.9;
  const lineH = 17;
  const pad2 = 16;
  const width = Math.ceil(Math.max(...lines.map((l) => l.length)) * charW + pad2 * 2);
  const height = lines.length * lineH + pad2 * 2;
  const body = lines.map((l, i) => {
    const y = pad2 + (i + 1) * lineH - 4;
    const cls = l.startsWith("$ ") ? ' class="cmd"' : "";
    const fit2 = l.length > 0 ? ` textLength="${(l.length * charW).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : "";
    return `  <text x="${pad2}" y="${y}"${cls}${fit2} xml:space="preserve">${esc(l)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="seatledger output on synthetic history">
  <style>text{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#d4d4d4}.cmd{fill:#7ee787}</style>
  <rect width="100%" height="100%" rx="8" fill="#0d1117"/>
${body}
</svg>
`;
}
export {
  API_EQUIVALENT_NOTE,
  CLIENTS,
  CLIENT_LABEL,
  GROUP_BY,
  METHOD,
  METRICS,
  METRIC_LABEL,
  PRICE_SOURCES,
  PROTOCOL_VERSIONS,
  PUSH_SCHEMA_ID,
  TOOLS,
  apiEquivalentUsd,
  assignTurns,
  buildPushPayload,
  callTool,
  clearLimits,
  dailySeries,
  dayKey,
  detectSteps,
  groupRows,
  handleMessage,
  limitStatus,
  listSourceFiles,
  load,
  parseSince,
  priceFor,
  priceKey,
  pricedModels,
  rateReport,
  ratesView,
  readClaudeCodeFile,
  readCodexFile,
  readLimits,
  reportView,
  runDemo,
  screenshotText,
  seatledgerHome,
  setLimit,
  sourceDirs,
  splitPayload,
  summaryView,
  textToSvg,
  toPushFinding,
  totalTokens,
  totals,
  vendorReadings,
  writeSyntheticHistory
};
//# sourceMappingURL=index.js.map