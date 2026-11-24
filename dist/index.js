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
  const usd3 = (r.input * input + r.output * output + r.cacheRead * cacheRead + write5m * cacheWrite + write1h * cacheWrite1h) / 1e6;
  return r.geoUs && p.provider === "Anthropic" ? usd3 * 1.1 : usd3;
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
    const usd3 = apiEquivalentUsd(r);
    if (usd3 === null) {
      this.unpriced += 1;
      this.unpricedModels.add(r.model);
    } else this.usd += usd3;
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

// src/plans.ts
var PLAN_IDS = [
  "anthropic-api",
  "claude-pro",
  "claude-max-5x",
  "claude-max-20x",
  "claude-team-standard",
  "claude-team-premium",
  "openai-api",
  "chatgpt-plus",
  "chatgpt-pro",
  "codex-credits",
  "copilot-pro",
  "copilot-pro-plus",
  "copilot-max"
];
var PLAN_GROUPS = {
  claude: [
    "anthropic-api",
    "claude-pro",
    "claude-max-5x",
    "claude-max-20x",
    "claude-team-standard",
    "claude-team-premium"
  ],
  codex: ["openai-api", "chatgpt-plus", "chatgpt-pro", "codex-credits"],
  copilot: ["copilot-pro", "copilot-pro-plus", "copilot-max"]
};
var SEEN = "2026-10-08";
var CLAUDE_PRICING = {
  label: "Claude plans and pricing",
  url: "https://claude.com/pricing",
  seen: SEEN
};
var CLAUDE_MAX = {
  label: "What is the Max plan?",
  url: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan",
  seen: SEEN
};
var CLAUDE_TEAM = {
  label: "What is the Team plan?",
  url: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan",
  seen: SEEN
};
var CLAUDE_TEAM_CODE = {
  label: "Claude Code on Team and Enterprise seats",
  url: "https://support.claude.com/en/articles/11845131",
  seen: SEEN
};
var CLAUDE_EXTRA = {
  label: "Manage usage credits for paid Claude plans",
  url: "https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans",
  seen: SEEN
};
var CLAUDE_FABLE = {
  label: "Claude Fable models on your plan",
  url: "https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan",
  seen: SEEN
};
var ANTHROPIC_API = {
  label: "Anthropic API model pricing",
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  seen: "2026-10-07"
};
var CODEX_PRICING = {
  label: "Codex pricing (developers.openai.com/codex/pricing redirects here)",
  url: "https://learn.chatgpt.com/docs/pricing",
  seen: SEEN
};
var CHATGPT_PRO_TIERS = {
  label: "About ChatGPT Pro tiers",
  url: "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers",
  seen: SEEN
};
var CODEX_RATE_CARD = {
  label: "ChatGPT rate card: credit-based pricing",
  url: "https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing",
  seen: SEEN
};
var OPENAI_API = {
  label: "OpenAI API pricing",
  url: "https://developers.openai.com/api/docs/pricing",
  seen: "2026-10-07"
};
var COPILOT_PLANS = {
  label: "GitHub Copilot plans",
  url: "https://github.com/features/copilot/plans",
  seen: SEEN
};
var COPILOT_BILLING = {
  label: "Copilot billing for individuals (1 AI credit = $0.01)",
  url: "https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals",
  seen: SEEN
};
var COPILOT_RATES = {
  label: "Copilot models and pricing (per-token rates)",
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  seen: SEEN
};
var CLAUDE_WINDOWS = "a 5-hour session allowance and a weekly limit, shared with Claude on the web and desktop; no message, hour or token count is published";
var PLANS = [
  {
    id: "anthropic-api",
    vendor: "Anthropic",
    name: "Anthropic API",
    carries: ["claude-code"],
    meter: "api",
    usdMonthly: null,
    allowance: "none: every token at list price",
    sources: [ANTHROPIC_API],
    seen: "2026-10-07"
  },
  {
    id: "claude-pro",
    vendor: "Anthropic",
    name: "Claude Pro",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 20,
    usdMonthlyAnnual: 17,
    overage: "api",
    timesPro: 1,
    overageOnlyModels: ["claude-fable"],
    allowance: `${CLAUDE_WINDOWS}; Fable models run on usage credits only`,
    sources: [CLAUDE_PRICING, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN
  },
  {
    id: "claude-max-5x",
    vendor: "Anthropic",
    name: "Claude Max 5x",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 100,
    priceNote: "monthly billing only",
    overage: "api",
    timesPro: 5,
    allowance: `5 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_MAX, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN
  },
  {
    id: "claude-max-20x",
    vendor: "Anthropic",
    name: "Claude Max 20x",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 200,
    priceNote: "monthly billing only",
    overage: "api",
    timesPro: 20,
    allowance: `20 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_MAX, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN
  },
  {
    id: "claude-team-standard",
    vendor: "Anthropic",
    name: "Claude Team standard",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 25,
    usdMonthlyAnnual: 20,
    minSeats: 2,
    overage: "api",
    timesPro: 1.25,
    overageOnlyModels: ["claude-fable"],
    allowance: `1.25 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable models run on usage credits only`,
    sources: [CLAUDE_PRICING, CLAUDE_TEAM, CLAUDE_TEAM_CODE, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN
  },
  {
    id: "claude-team-premium",
    vendor: "Anthropic",
    name: "Claude Team premium",
    carries: ["claude-code"],
    meter: "allowance",
    usdMonthly: 125,
    usdMonthlyAnnual: 100,
    minSeats: 2,
    overage: "api",
    timesPro: 6.25,
    allowance: `6.25 times Pro's per-session allowance; ${CLAUDE_WINDOWS}; Fable up to 50% of the weekly limit`,
    sources: [CLAUDE_PRICING, CLAUDE_TEAM, CLAUDE_TEAM_CODE, CLAUDE_EXTRA, CLAUDE_FABLE],
    seen: SEEN
  },
  {
    id: "openai-api",
    vendor: "OpenAI",
    name: "OpenAI API",
    carries: ["codex"],
    meter: "api",
    usdMonthly: null,
    allowance: "none: every token at list price",
    sources: [OPENAI_API],
    seen: "2026-10-07"
  },
  {
    id: "chatgpt-plus",
    vendor: "OpenAI",
    name: "ChatGPT Plus",
    carries: ["codex"],
    meter: "allowance",
    usdMonthly: 20,
    overage: "codex-credits",
    codexPlanType: "plus",
    allowance: "a five-hour window and a weekly limit; OpenAI publishes local-message estimates per five hours that it calls not fixed limits; extra credits can be bought past the limit",
    sources: [CODEX_PRICING],
    seen: SEEN
  },
  {
    id: "chatgpt-pro",
    vendor: "OpenAI",
    name: "ChatGPT Pro",
    carries: ["codex"],
    meter: "allowance",
    usdMonthly: 100,
    priceNote: "tiers at $100, $200 and $500 a month, billed monthly",
    overage: "codex-credits",
    codexPlanType: "pro",
    allowance: "no five-hour limit; weekly limits, not published in tokens or as a multiple of Plus; extra credits can be bought past the limit",
    sources: [CODEX_PRICING, CHATGPT_PRO_TIERS],
    seen: SEEN
  },
  {
    id: "codex-credits",
    vendor: "OpenAI",
    name: "Codex credits",
    carries: ["codex"],
    meter: "codex-credits",
    usdMonthly: null,
    allowance: "none: every token at the credit rate card",
    sources: [CODEX_RATE_CARD, CODEX_PRICING],
    seen: SEEN
  },
  {
    id: "copilot-pro",
    vendor: "GitHub",
    name: "Copilot Pro",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 10,
    includedUsd: 15,
    flexUsd: 5,
    overage: "copilot-credits",
    allowance: "$15 of AI credits a month ($10 base and a $5 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN
  },
  {
    id: "copilot-pro-plus",
    vendor: "GitHub",
    name: "Copilot Pro+",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 39,
    includedUsd: 70,
    flexUsd: 31,
    overage: "copilot-credits",
    allowance: "$70 of AI credits a month ($39 base and a $31 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN
  },
  {
    id: "copilot-max",
    vendor: "GitHub",
    name: "Copilot Max",
    carries: ["claude-code", "codex"],
    meter: "copilot-credits",
    usdMonthly: 100,
    includedUsd: 200,
    flexUsd: 100,
    overage: "copilot-credits",
    allowance: "$200 of AI credits a month ($100 base and a $100 flex allotment that may change)",
    sources: [COPILOT_PLANS, COPILOT_BILLING, COPILOT_RATES],
    seen: SEEN
  }
];
var CODEX_CREDIT = {
  usd: 0.04,
  derived: true,
  how: "OpenAI does not state a price per credit for Plus or Pro; $0.04 is derived from its own figures: $100 of workspace credits is 2,500 credits, and its Enterprise USD rate card is 25 credits to the dollar on every row",
  sources: [
    {
      label: "Premium seats in ChatGPT Business ($100 of credits = 2,500 credits)",
      url: "https://openai.com/index/premium-seats-chatgpt-business/",
      seen: SEEN
    },
    {
      label: "ChatGPT rate card: Enterprise token-based pricing (USD)",
      url: "https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing",
      seen: SEEN
    },
    {
      label: "Codex credit purchases (prices can vary)",
      url: "https://help.openai.com/en/articles/12642688",
      seen: SEEN
    }
  ]
};
var credits = (input, cachedInput, output) => ({
  input,
  cachedInput,
  cacheWrite: null,
  // "Codex credit billing has no separate cache-write charge."
  output
});
var CODEX_CREDIT_RATES = {
  "gpt-6-astra": credits(250, 25, 1250),
  "gpt-6.1-sol": credits(50, 2.5, 250),
  "gpt-6-sol": credits(50, 5, 250),
  "gpt-6-luna": credits(2.5, 0.25, 12.5),
  "gpt-5.6-sol": credits(100, 10, 500),
  "gpt-5.6-terra": credits(50, 5, 300),
  "gpt-5.6-luna": credits(5, 0.5, 30),
  "gpt-5.5": credits(125, 12.5, 750),
  "gpt-5.3-codex": credits(43.75, 4.375, 350),
  "gpt-5.2": credits(43.75, 4.375, 350)
};
var usd = (input, cachedInput, cacheWrite, output, long) => ({
  input,
  cachedInput,
  cacheWrite,
  output,
  ...long ? {
    long: {
      threshold: long[0],
      input: long[1],
      cachedInput: long[2],
      cacheWrite: long[3],
      output: long[4]
    }
  } : {}
});
var COPILOT_RATES_USD = {
  "claude-haiku-4-5": usd(1, 0.1, 1.25, 5),
  "claude-haiku-5-5": usd(0.1, 0.01, 0.125, 0.5, [1e5, 0.5, 0.05, 0.625, 2.5]),
  "claude-sonnet-4": usd(3, 0.3, 3.75, 15),
  "claude-sonnet-4-6": usd(3, 0.3, 3.75, 15),
  "claude-sonnet-5": usd(2, 0.2, 2.5, 10),
  "claude-sonnet-5-5": usd(2, 0.1, 2.5, 10),
  "claude-opus-4-8": usd(5, 0.5, 6.25, 25),
  "claude-opus-4-8-fast": usd(10, 1, 12.5, 50),
  "claude-opus-5": usd(5, 0.5, 6.25, 25),
  "claude-opus-5-5": usd(4, 0.2, 5, 20),
  "claude-fable-5": usd(10, 1, 12.5, 50),
  "claude-fable-5-1": usd(10, 0.25, 12.5, 50),
  "gpt-5-mini": usd(0.25, 0.025, null, 2),
  "gpt-5.3-codex": usd(1.75, 0.175, null, 14),
  "gpt-5.4": usd(2.5, 0.25, null, 15, [272e3, 5, 0.5, null, 22.5]),
  "gpt-5.4-mini": usd(0.75, 0.075, null, 4.5),
  "gpt-5.5": usd(5, 0.5, null, 30, [272e3, 10, 1, null, 45]),
  "gpt-5.6-luna": usd(0.2, 0.02, 0.25, 1.2, [2e5, 0.4, 0.04, 0.5, 1.8]),
  "gpt-5.6-sol": usd(4, 0.4, 5, 20, [272e3, 8, 0.8, 10, 30]),
  "gpt-5.6-terra": usd(2, 0.2, 2.5, 12, [272e3, 4, 0.4, 5, 18]),
  "gpt-6-astra": usd(10, 1, 12.5, 50, [272e3, 20, 2, 25, 75]),
  "gpt-6-luna": usd(0.1, 0.01, 0.125, 0.5, [272e3, 0.2, 0.02, 0.25, 0.75]),
  "gpt-6-sol": usd(2, 0.2, 2.5, 10, [272e3, 4, 0.4, 5, 15]),
  "gpt-6.1-sol": usd(2, 0.1, 2.5, 10, [272e3, 4, 0.2, 5, 15])
};
var PLAN_CHANGES = [
  {
    date: "2026-01-16",
    vendor: "Anthropic",
    plans: ["claude-team-standard"],
    introduced: ["claude-team-standard"],
    priced: true,
    what: "Claude Code access added to Team plan standard seats.",
    source: {
      label: "Claude release notes, 16 January 2026",
      url: "https://support.claude.com/en/articles/12138966-release-notes",
      seen: SEEN
    }
  },
  {
    date: "2026-04-02",
    vendor: "OpenAI",
    plans: ["chatgpt-plus", "chatgpt-pro", "codex-credits"],
    introduced: ["codex-credits"],
    priced: true,
    what: "Codex credits priced by token, aligned with API token usage, instead of per message, for Plus, Pro and Business (existing Enterprise plans followed on 23 April).",
    source: {
      label: "OpenAI help center, Codex rate card (article 20001106, as indexed; the live URL now redirects to the credit rate card, which no longer carries the date)",
      url: "https://help.openai.com/en/articles/20001106-codex-rate-card",
      seen: SEEN
    }
  },
  {
    date: "2026-05-13",
    vendor: "Anthropic",
    plans: [
      "claude-pro",
      "claude-max-5x",
      "claude-max-20x",
      "claude-team-standard",
      "claude-team-premium"
    ],
    priced: true,
    what: "Weekly usage limits in Claude Code 50% higher, as a promotion through 13 September 2026.",
    source: {
      label: "Claude Code May\u2013August 2026 weekly limits promotion",
      url: "https://support.claude.com/en/articles/15910845-claude-code-may-august-2026-weekly-limits-promotion",
      seen: SEEN
    }
  },
  {
    date: "2026-06-01",
    vendor: "GitHub",
    plans: ["copilot-pro", "copilot-pro-plus", "copilot-max"],
    introduced: ["copilot-pro", "copilot-pro-plus", "copilot-max"],
    priced: true,
    what: "Every Copilot plan billed in GitHub AI credits, each token priced by model, replacing premium requests (which remain only on legacy annual plans).",
    source: {
      label: "GitHub changelog, 1 June 2026: updates to Copilot billing and plans",
      url: "https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/",
      seen: SEEN
    }
  },
  {
    date: "2026-08-25",
    vendor: "OpenAI",
    plans: ["chatgpt-plus"],
    priced: true,
    what: "Five-hour limit back on Codex for Plus after a period without one, announced on X by OpenAI's engineering lead for Codex; Pro stays without one. OpenAI's pricing page lists Plus with a five-hour window and Pro without.",
    source: {
      label: "iThinkDifferent, 25 August 2026, on the announcement",
      url: "https://www.ithinkdiff.com/openai-codex-five-hour-limit/",
      seen: SEEN
    },
    reported: true
  },
  {
    date: "2026-09-14",
    vendor: "Anthropic",
    plans: [
      "claude-pro",
      "claude-max-5x",
      "claude-max-20x",
      "claude-team-standard",
      "claude-team-premium"
    ],
    priced: true,
    what: "The promotion ended: standard weekly limits in Claude Code are 25% higher than before it, which is one sixth (about 17%) less than during it.",
    source: {
      label: "Claude Code May\u2013August 2026 weekly limits promotion",
      url: "https://support.claude.com/en/articles/15910845-claude-code-may-august-2026-weekly-limits-promotion",
      seen: SEEN
    }
  },
  {
    date: "2026-10-07",
    vendor: "Anthropic",
    plans: ["claude-max-5x", "claude-max-20x", "claude-team-standard", "claude-team-premium"],
    priced: false,
    what: "Max and Team plans include monthly API credits for the Claude Platform ($100 on Max 5x, $200 on Max 20x, $20 and $100 per Team seat); they do not cover interactive Claude Code.",
    source: {
      label: "Monthly API credits for Max and Team plans",
      url: "https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans",
      seen: SEEN
    }
  },
  {
    date: "2026-10-14",
    vendor: "OpenAI",
    plans: ["chatgpt-plus", "chatgpt-pro", "codex-credits"],
    priced: false,
    what: "GPT-5.5 retires from Codex on all plans.",
    source: CODEX_PRICING
  }
];
var planById = (id) => PLANS.find((p) => p.id === id);

// src/plan-compare.ts
var DAY = 864e5;
var FIVE_HOURS2 = 5 * 36e5;
var WEEK2 = 7 * DAY;
var MONTH_DAYS = 30;
function resolvePlans(names) {
  if (!names || names.length === 0) return [...PLAN_IDS];
  const want = /* @__PURE__ */ new Set();
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const group = PLAN_GROUPS[n];
    if (group) group.forEach((id) => want.add(id));
    else if (PLAN_IDS.includes(n)) want.add(n);
    else
      throw new Error(
        `unknown plan "${raw}"; use ${Object.keys(PLAN_GROUPS).join(", ")} or one of: ${PLAN_IDS.join(", ")}`
      );
  }
  if (want.size === 0) throw new Error("no plans named");
  return PLAN_IDS.filter((id) => want.has(id));
}
function priceAt(r, rates) {
  const prompt = r.input + r.cacheRead + r.cacheWrite;
  const t = rates.long && prompt > rates.long.threshold ? rates.long : rates;
  const write = t.cacheWrite ?? t.input;
  return (r.input * t.input + r.cacheRead * t.cachedInput + r.cacheWrite * write + r.output * t.output) / 1e6;
}
function codexCredits(r) {
  const rates = CODEX_CREDIT_RATES[priceKey(r.model)];
  return rates ? priceAt(r, rates) : null;
}
function copilotUsd(r) {
  const key = priceKey(r.model);
  const rates = (r.fast ? COPILOT_RATES_USD[`${key}-fast`] : void 0) ?? COPILOT_RATES_USD[key];
  return rates ? priceAt(r, rates) : null;
}
function busiestFiveHours(rs) {
  let best = null;
  let start = -Infinity;
  let usd3 = 0;
  let n = 0;
  const close = () => {
    if (n > 0 && (!best || usd3 > best.usd))
      best = { start: new Date(start).toISOString(), usd: usd3, requests: n };
  };
  for (const r of rs) {
    if (r.ts >= start + FIVE_HOURS2) {
      close();
      start = r.ts;
      usd3 = 0;
      n = 0;
    }
    usd3 += apiEquivalentUsd(r) ?? 0;
    n += 1;
  }
  close();
  return best;
}
function busiestWeek(rs) {
  let best = null;
  let j = 0;
  let usd3 = 0;
  for (let i = 0; i < rs.length; i++) {
    while (j < rs.length && rs[j].ts < rs[i].ts + WEEK2) usd3 += apiEquivalentUsd(rs[j++]) ?? 0;
    if (!best || usd3 > best.usd)
      best = { start: new Date(rs[i].ts).toISOString(), usd: usd3, requests: j - i };
    usd3 -= apiEquivalentUsd(rs[i]) ?? 0;
  }
  return best;
}
function codexReadings(loaded, from, now) {
  const qs = loaded.quota.filter((q) => q.client === "codex" && q.ts >= from && q.ts <= now);
  if (qs.length === 0) return null;
  let five = null;
  let week = null;
  const atLimit = /* @__PURE__ */ new Set();
  for (const q of qs) {
    const isFive = q.slot === "primary" && (q.windowMinutes === null || q.windowMinutes <= 300);
    if (isFive) five = Math.max(five ?? 0, q.usedPercent);
    else week = Math.max(week ?? 0, q.usedPercent);
    if (q.usedPercent >= 100) atLimit.add(`${q.limitId}/${q.slot}@${q.resetsAt ?? q.ts}`);
  }
  const latest = qs.reduce((a, b) => b.ts >= a.ts ? b : a);
  return {
    planType: latest.planType,
    peakFiveHourPercent: five,
    peakWeeklyPercent: week,
    windowsAtLimit: atLimit.size,
    readings: qs.length
  };
}
function workload(client, rs, scale, readings) {
  const tokens2 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const unpriced = { requests: 0, tokens: 0, models: /* @__PURE__ */ new Set() };
  let usd3 = 0;
  for (const r of rs) {
    tokens2.input += r.input;
    tokens2.output += r.output;
    tokens2.cacheRead += r.cacheRead;
    tokens2.cacheWrite += r.cacheWrite;
    tokens2.total += totalTokens(r);
    const u = apiEquivalentUsd(r);
    if (u === null) {
      unpriced.requests += 1;
      unpriced.tokens += totalTokens(r);
      unpriced.models.add(r.model);
    } else usd3 += u;
  }
  return {
    client,
    label: CLIENT_LABEL[client],
    requests: rs.length,
    tokens: tokens2,
    apiUsd: usd3,
    monthApiUsd: usd3 * scale,
    unpriced: { ...unpriced, models: [...unpriced.models].sort() },
    busiestFiveHours: busiestFiveHours(rs),
    busiestWeek: busiestWeek(rs),
    firstRequest: rs.length ? new Date(rs[0].ts).toISOString() : null,
    codexReadings: client === "codex" ? readings : null
  };
}
var money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function windowCondition(w, what) {
  const five = w.busiestFiveHours ? money(w.busiestFiveHours.usd) : "$0.00";
  const week = w.busiestWeek ? money(w.busiestWeek.usd) : "$0.00";
  return `${what} holds this machine's busiest 5 hours (${five} at API list prices) and busiest week (${week})`;
}
function quote(plan, carries, byClient, works, scale) {
  const rs = carries.flatMap((c) => byClient.get(c) ?? []);
  const base = {
    plan: plan.id,
    name: plan.name,
    vendor: plan.vendor,
    carries,
    feeUsd: plan.usdMonthly
  };
  const w = works.get(carries[0]);
  if (plan.meter === "api") {
    return {
      ...base,
      costUsd: w.monthApiUsd,
      fromUsd: w.monthApiUsd,
      kind: "priced",
      basis: `every token at ${plan.vendor}'s API list prices`,
      condition: null,
      unpricedRequests: w.unpriced.requests,
      figures: {}
    };
  }
  if (plan.meter === "codex-credits") {
    let credits2 = 0;
    let missing = 0;
    for (const r of rs) {
      const c = codexCredits(r);
      if (c === null) missing += 1;
      else credits2 += c;
    }
    const cost = credits2 * scale * CODEX_CREDIT.usd;
    return {
      ...base,
      costUsd: cost,
      fromUsd: cost,
      kind: "priced",
      basis: `${Math.round(credits2 * scale).toLocaleString("en-US")} credits at OpenAI's Codex rate card (no separate cache-write charge), at $${CODEX_CREDIT.usd} a credit, derived from OpenAI's own figures`,
      condition: null,
      unpricedRequests: missing,
      figures: { codexCredits: credits2 * scale }
    };
  }
  if (plan.meter === "copilot-credits") {
    let usd3 = 0;
    let missing = 0;
    for (const r of rs) {
      const c = copilotUsd(r);
      if (c === null) missing += 1;
      else usd3 += c;
    }
    const used = usd3 * scale;
    const included = plan.includedUsd ?? 0;
    const cost = (plan.usdMonthly ?? 0) + Math.max(0, used - included);
    return {
      ...base,
      costUsd: cost,
      fromUsd: cost,
      kind: "estimate",
      basis: `the same tokens at GitHub's per-token rates: ${Math.round(used * 100).toLocaleString("en-US")} AI credits against ${Math.round(included * 100).toLocaleString("en-US")} included, the rest at $0.01 each; Copilot keeps no local logs, and its agent would not use exactly these tokens`,
      condition: null,
      unpricedRequests: missing,
      figures: { copilotUsedUsd: used, includedUsd: included }
    };
  }
  const fee = plan.usdMonthly ?? 0;
  let extra = 0;
  if (plan.overageOnlyModels?.length) {
    for (const r of rs)
      if (plan.overageOnlyModels.some((m) => priceKey(r.model).startsWith(m)))
        extra += (apiEquivalentUsd(r) ?? 0) * scale;
  }
  const from = fee + extra;
  const extraNote = extra > 0 ? ` ${money(extra)} of this month is on Fable models, which this plan bills at API rates from the first token.` : "";
  if (plan.vendor === "Anthropic") {
    const multiple = plan.timesPro === 1 ? "Anthropic publishes no number for it" : `Anthropic publishes it only as ${plan.timesPro} times Pro's per-session allowance`;
    return {
      ...base,
      costUsd: null,
      fromUsd: from,
      kind: "allowance-unpublished",
      basis: `${money(fee)} a seat${plan.minSeats ? ` (at least ${plan.minSeats} seats)` : ""}; past its allowance, extra usage at API rates; ${multiple}.${extraNote}`,
      condition: windowCondition(w, `the fee alone carries the month if its allowance`),
      unpricedRequests: w.unpriced.requests,
      figures: extra > 0 ? { apiRatesFromStartUsd: extra } : {}
    };
  }
  const rd = w.codexReadings;
  const mine = rd && rd.planType === plan.codexPlanType ? rd : null;
  const tiers = plan.priceNote ? ` (${plan.priceNote})` : "";
  if (mine && mine.windowsAtLimit === 0) {
    const five = mine.peakFiveHourPercent === null ? "" : `busiest 5-hour window ${Math.round(mine.peakFiveHourPercent)}%, `;
    const week = mine.peakWeeklyPercent === null ? "no weekly reading" : `busiest week ${Math.round(mine.peakWeeklyPercent)}%`;
    const single = plan.id === "chatgpt-plus";
    return {
      ...base,
      costUsd: single ? fee : null,
      fromUsd: fee,
      kind: "measured",
      basis: `Codex's own readings on this machine, on ${plan.name}: ${five}${week} of the limit, never 100%${single ? "" : `; ${plan.name} has tiers${tiers}, and the readings do not say which`}.`,
      condition: single ? null : `the fee alone carried the month on your ${plan.name} tier`,
      unpricedRequests: 0,
      figures: {}
    };
  }
  if (mine) {
    return {
      ...base,
      costUsd: null,
      fromUsd: fee,
      kind: "measured-at-limit",
      basis: `Codex's own readings on this machine, on ${plan.name}: ${mine.windowsAtLimit} window${mine.windowsAtLimit === 1 ? "" : "s"} reached 100% of the limit; past it, credits at the rate card${tiers}.`,
      condition: `the fee alone did not carry the month: work past the limit needs credits, which the readings do not size`,
      unpricedRequests: 0,
      figures: {}
    };
  }
  return {
    ...base,
    costUsd: null,
    fromUsd: fee,
    kind: "allowance-unpublished",
    basis: `${money(fee)} a month${tiers}; ${plan.allowance}.`,
    condition: windowCondition(w, `the fee alone carries the month if its limit`),
    unpricedRequests: 0,
    figures: {}
  };
}
var known = (q) => q.costUsd !== null;
function bestOptions(quotes, clients) {
  const single = (c) => quotes.filter((q) => known(q) && q.carries.length === 1 && q.carries[0] === c);
  const part = (q) => ({
    plan: q.plan,
    name: q.name,
    carries: q.carries,
    costUsd: q.costUsd,
    kind: q.kind
  });
  const out = [];
  if (clients.length === 1) {
    for (const q of single(clients[0]))
      out.push({ label: q.name, parts: [part(q)], costUsd: q.costUsd });
  } else {
    const [a, b] = clients;
    for (const qa of single(a))
      for (const qb of single(b)) {
        if (qa.vendor === "GitHub" && qb.vendor === "GitHub") continue;
        out.push({
          label: `${CLIENT_LABEL[a]} on ${qa.name} + ${CLIENT_LABEL[b]} on ${qb.name}`,
          parts: [part(qa), part(qb)],
          costUsd: qa.costUsd + qb.costUsd
        });
      }
    for (const q of quotes.filter((x) => known(x) && x.carries.length === 2))
      out.push({ label: `both on ${q.name}`, parts: [part(q)], costUsd: q.costUsd });
  }
  return out.sort((x, y) => x.costUsd - y.costUsd || x.label.localeCompare(y.label));
}
var cents = (n) => Math.round(n * 100);
function changeRef(c) {
  return {
    date: c.date,
    vendor: c.vendor,
    plans: c.plans,
    what: c.what,
    source: c.source,
    reported: c.reported === true
  };
}
function clientAnswer(quotes, client) {
  const options = bestOptions(quotes, [client]);
  const cheapest = options[0];
  if (!cheapest) return null;
  const vendorOf = (o) => planById(o.parts[0].plan).vendor;
  const runnerUp = options.slice(1).find((o) => vendorOf(o) !== vendorOf(cheapest)) ?? options[1] ?? null;
  const couldBeCheaper = quotes.filter(
    (q) => q.costUsd === null && q.condition !== null && q.kind !== "measured-at-limit" && q.carries.length === 1 && q.carries[0] === client && cents(q.fromUsd) < cents(cheapest.costUsd)
  ).map((q) => ({
    plan: q.plan,
    name: q.name,
    client,
    fromUsd: q.fromUsd,
    condition: q.condition
  })).sort((a, b) => a.fromUsd - b.fromUsd || a.name.localeCompare(b.name));
  return {
    client,
    cheapest,
    runnerUp,
    marginUsd: runnerUp ? runnerUp.costUsd - cheapest.costUsd : null,
    couldBeCheaper
  };
}
function fingerprint(quotes, clients) {
  const all = bestOptions(quotes, clients)[0];
  const per = clients.map((c) => {
    const o = bestOptions(quotes, [c]);
    return `${o[0]?.label ?? "-"}/${o[1]?.label ?? "-"}`;
  });
  return [all?.label ?? "-", cents(all?.costUsd ?? -1), ...per].join("|");
}
function answerFrom(quotes, clients, today) {
  const options = bestOptions(quotes, clients);
  const cheapest = options[0];
  if (!cheapest) return null;
  const runnerUp = options[1] ?? null;
  const byClient = clients.map((c) => clientAnswer(quotes, c)).filter((a) => a !== null);
  const inAnswer = /* @__PURE__ */ new Set([
    ...cheapest.parts.map((p) => p.plan),
    ...byClient.flatMap((a) => [
      ...a.cheapest.parts.map((p) => p.plan),
      ...a.runnerUp?.parts.map((p) => p.plan) ?? [],
      ...a.couldBeCheaper.map((c) => c.plan)
    ])
  ]);
  const past = PLAN_CHANGES.filter((c) => c.date <= today && c.priced).reverse();
  const current = fingerprint(quotes, clients);
  let lastMoved = null;
  for (const c of past) {
    if (!c.introduced?.length) continue;
    const before = quotes.filter((q) => !c.introduced.includes(q.plan));
    if (fingerprint(before, clients) !== current) {
      lastMoved = { ...changeRef(c), without: bestOptions(before, clients)[0] ?? null };
      break;
    }
  }
  const touched = past.find((c) => c.plans.some((p) => inAnswer.has(p)));
  return {
    cheapest,
    runnerUp,
    marginUsd: runnerUp ? runnerUp.costUsd - cheapest.costUsd : null,
    byClient,
    lastMoved,
    lastTouched: touched ? changeRef(touched) : null
  };
}
var isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);
function planCompare(loaded, opts) {
  const now = opts.now;
  const from = opts.since ?? now - MONTH_DAYS * DAY;
  const days = Math.max((now - from) / DAY, 1 / 24);
  const scale = MONTH_DAYS / days;
  const ids = resolvePlans(opts.plans);
  const plans = PLANS.filter((p) => ids.includes(p.id));
  const inRange = loaded.requests.filter((r) => r.ts >= from && r.ts <= now);
  const byClient = new Map(
    CLIENTS.map((c) => [c, inRange.filter((r) => r.client === c)])
  );
  const readings = codexReadings(loaded, from, now);
  const clients = CLIENTS.filter((c) => (byClient.get(c)?.length ?? 0) > 0);
  const works = new Map(
    clients.map((c) => [c, workload(c, byClient.get(c), scale, readings)])
  );
  const quotes = [];
  for (const plan of plans) {
    const mine = plan.carries.filter((c) => works.has(c));
    for (const c of mine) quotes.push(quote(plan, [c], byClient, works, scale));
    if (mine.length === 2) quotes.push(quote(plan, mine, byClient, works, scale));
  }
  const today = isoDay(now);
  const answer = answerFrom(quotes, clients, today);
  const upcoming = PLAN_CHANGES.filter(
    (c) => c.date > today && c.plans.some((p) => quotes.some((q) => q.plan === p))
  ).map(changeRef);
  const notes = [];
  if (Math.abs(scale - 1) > 0.02)
    notes.push(
      `Metered figures are scaled from ${days.toFixed(1)} days to a ${MONTH_DAYS}-day month; flat fees are not.`
    );
  for (const w of works.values()) {
    const first = w.firstRequest ? Date.parse(w.firstRequest) : from;
    if (first - from > 2 * DAY)
      notes.push(
        `${w.label} history on this machine starts ${isoDay(first)}, after the period starts; days before it count as no use.`
      );
    if (w.unpriced.requests > 0)
      notes.push(
        `${w.unpriced.requests.toLocaleString("en-US")} ${w.label} requests on models with no list price (${w.unpriced.models.join(", ")}) are left out of every dollar figure.`
      );
  }
  if (readings)
    notes.push(
      "Codex's readings are account-wide: Codex use on other machines and in the cloud counts in them."
    );
  return {
    view: "plan_compare",
    generatedAt: new Date(now).toISOString(),
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days, scale },
    plansCompared: ids,
    workloads: [...works.values()],
    quotes,
    answer,
    upcoming,
    notes,
    codexCredit: {
      usd: CODEX_CREDIT.usd,
      derived: CODEX_CREDIT.derived,
      how: CODEX_CREDIT.how,
      sources: CODEX_CREDIT.sources
    },
    sources: {
      plans: plans.map((p) => ({ plan: p.id, name: p.name, seen: p.seen, sources: p.sources }))
    },
    apiPrices: PRICE_SOURCES
  };
}

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
  const usd3 = apiEquivalentUsd(r);
  if (usd3 === null) g.unpriced = true;
  else g.row.api_equivalent_usd = (g.row.api_equivalent_usd ?? 0) + usd3;
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
      "run `npx seatledger team join <invite link> --as <name>` (the team owner has the link), or `npx seatledger team create` to start a team, or set SEATLEDGER_KEY",
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
    name: "seatledger_plan_compare",
    title: "This machine's month on every coding plan",
    description: "What this machine's last 30 days of Claude Code and Codex work would cost on each coding plan, read from the local transcripts: the Anthropic and OpenAI APIs at list prices; Claude Pro, Max 5x, Max 20x, Team standard and Team premium; ChatGPT Plus and Pro; Codex credits at OpenAI's rate card; and Copilot Pro, Pro+ and Max at GitHub's per-token AI-credit rates. Returns each client's tokens, API-equivalent dollars and busiest 5 hours and week; a quote per plan saying how it was reached (priced from published rates, measured from Codex's own window readings, or an estimate); per client, the cheapest priced plan, the runner-up and the margin; plans that could be cheaper if an allowance the vendor does not publish holds the busiest 5 hours and week; and the newest dated vendor change that moved the answer. Allowances Anthropic and OpenAI do not publish as numbers are never invented: those plans get their fee and that condition. Copilot figures are estimates, since Copilot keeps no local logs and its agent would not use exactly these tokens. The dollar price of a Codex credit is derived from OpenAI's own figures and marked so. Every plan carries its source URLs and the date they were read. Costs are stated for a 30-day month.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          pattern: SINCE_PATTERN,
          description: "Start of the range: a local date (`2026-09-01`) or a span back from today (`30d`, `12w`). Metered figures are scaled to a 30-day month either way. Omitted: the last 30 days."
        },
        plans: {
          type: "array",
          items: { type: "string", enum: [...PLAN_IDS, ...Object.keys(PLAN_GROUPS)] },
          minItems: 1,
          uniqueItems: true,
          description: "Only these plans: plan ids such as `claude-max-5x`, `chatgpt-plus` or `copilot-max`, or a vendor group (`claude`, `codex`, `copilot`). Omitted: every plan."
        }
      },
      additionalProperties: false
    },
    annotations: annotations("This machine's month on every coding plan")
  },
  {
    name: "seatledger_team_summary",
    title: "Team coding-agent ledger",
    description: "The hosted seatledger team ledger this machine created or joined (`seatledger team create` or `seatledger team join`): what the team's coding-agent seats and tokens bought, from every developer's pushed daily aggregates. Returns team totals; tables by day, month, developer, model and client; and the rate-change findings feed, each with its date, the developer, the client version and whether that was its first day, and what the step is consistent with. A developer's key sees every team total and only their own row in `by_developer`; the owner key sees every developer. Dollars are API-equivalent (the same tokens at API list prices), not what anyone was billed. History is as long as the team's plan keeps (Free 30 days, Team and Business 13 months). Needs the key `seatledger team create` or `team join` saved in ~/.seatledger/team.json, or SEATLEDGER_KEY; without one it returns NO_TEAM_KEY. This tool makes one HTTPS request to that ledger and changes nothing.",
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
    if (spec.type === "array") {
      const items = spec.items ?? {};
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string"))
        throw new InvalidInput(
          `\`${k}\` must be a non-empty array of strings`,
          `Pass \`${k}\` as e.g. ["claude-max-5x"], or omit it.`
        );
      const bad = v.find((x) => items.enum && !items.enum.includes(x));
      if (bad !== void 0)
        throw new InvalidInput(
          `\`${k}\` has "${bad}"`,
          `Use any of: ${(items.enum ?? []).join(", ")}.`
        );
      continue;
    }
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
    if (spec.minLength && typeof v === "string" && v.length < Number(spec.minLength))
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
    if (name === "seatledger_plan_compare") {
      const from2 = since ?? now - MONTH_DAYS * 864e5;
      const loaded2 = await load({ ...ctx.loadOptions, home, since: from2 });
      const plans = Array.isArray(args.plans) ? args.plans : void 0;
      return {
        structured: { ...planCompare(loaded2, { now, since: from2, ...plans ? { plans } : {} }) },
        isError: false
      };
    }
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
var INSTRUCTIONS = "seatledger reads this machine's Claude Code and Codex transcripts locally and reports tokens, API-equivalent dollars, the user's own limits, step changes in token rates, and what the month would cost on each coding plan. Read-only. seatledger_usage_summary, seatledger_rate_changes and seatledger_plan_compare make no network calls; seatledger_team_summary reads the hosted team ledger this machine created or joined, with its saved key.";
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
var DAY2 = 864e5;
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
    const dayStart = start + d * DAY2;
    const weekend = new Date(dayStart).getUTCDay() % 6 === 0;
    const after = step !== void 0 && dayStart >= step;
    const version2 = after ? "2.1.230" : dayStart >= start + 12 * DAY2 ? "2.1.229" : "2.1.226";
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
                // Plus: on 7 Oct 2026 OpenAI listed a five-hour limit for Plus and none for Pro
                plan_type: "plus"
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
    now: start + (days - 1) * DAY2 + 16 * 36e5,
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
function usd2(n) {
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
    t.requests === 0 ? "\u2014" : usd2(t.apiEquivalentUsd) + (t.unpricedRequests > 0 ? "*" : "")
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
var amountOf = (s, n) => s.unit === "tokens" ? `${tokens(n)} tokens` : usd2(n);
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
  CODEX_CREDIT,
  CODEX_CREDIT_RATES,
  COPILOT_RATES_USD,
  GROUP_BY,
  METHOD,
  METRICS,
  METRIC_LABEL,
  MONTH_DAYS,
  PLANS,
  PLAN_CHANGES,
  PLAN_GROUPS,
  PLAN_IDS,
  PRICE_SOURCES,
  PROTOCOL_VERSIONS,
  PUSH_SCHEMA_ID,
  TOOLS,
  apiEquivalentUsd,
  assignTurns,
  buildPushPayload,
  callTool,
  clearLimits,
  codexCredits,
  copilotUsd,
  dailySeries,
  dayKey,
  detectSteps,
  groupRows,
  handleMessage,
  limitStatus,
  listSourceFiles,
  load,
  parseSince,
  planById,
  planCompare,
  priceFor,
  priceKey,
  pricedModels,
  rateReport,
  ratesView,
  readClaudeCodeFile,
  readCodexFile,
  readLimits,
  reportView,
  resolvePlans,
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