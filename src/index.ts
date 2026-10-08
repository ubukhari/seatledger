/**
 * seatledger as a library: the readers, the ledger, the rate detector and the limits, for tools
 * that want the same numbers the CLI prints. Everything is local; nothing here makes a request
 * (`buildPushPayload` only shapes what `seatledger push` would send).
 */
export type { Client, FileExtract, PromptMark, QuotaSample, UsageRecord } from "./types.js";
export { CLIENTS, CLIENT_LABEL, totalTokens } from "./types.js";
export { readClaudeCodeFile } from "./readers/claude-code.js";
export { readCodexFile } from "./readers/codex.js";
export { load, assignTurns, type Loaded, type LoadOptions, type SourceSummary } from "./load.js";
export { sourceDirs, seatledgerHome, listSourceFiles, type SourceDirs } from "./paths.js";
export {
  apiEquivalentUsd,
  priceFor,
  priceKey,
  pricedModels,
  PRICE_SOURCES,
  type ModelPrice,
  type PriceSource,
} from "./prices.js";
export {
  dayKey,
  groupRows,
  totals,
  GROUP_BY,
  type GroupBy,
  type LedgerRow,
  type Totals,
} from "./ledger.js";
export {
  dailySeries,
  detectSteps,
  rateReport,
  METRICS,
  METRIC_LABEL,
  METHOD,
  type Metric,
  type RateChange,
  type RateFinding,
  type RateReport,
  type Series,
} from "./rates.js";
export {
  limitStatus,
  readLimits,
  setLimit,
  clearLimits,
  vendorReadings,
  type Limit,
  type LimitStatus,
  type VendorReading,
} from "./limits.js";
export { summaryView, reportView, ratesView, parseSince, API_EQUIVALENT_NOTE } from "./views.js";
export { TOOLS, callTool, handleMessage, PROTOCOL_VERSIONS } from "./mcp.js";
export { writeSyntheticHistory, type SyntheticOptions } from "./synthetic.js";
export {
  buildPushPayload,
  splitPayload,
  toPushFinding,
  PUSH_SCHEMA_ID,
  type PushPayload,
  type PushRow,
  type PushFinding,
} from "./push.js";
export { runDemo, screenshotText, textToSvg, type Demo } from "./demo.js";
