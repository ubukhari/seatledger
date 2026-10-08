/**
 * `seatledger demo`: the summary and the rate report on synthetic history, written to a temporary
 * directory and removed afterwards. The README screenshot is this output, rendered by
 * `textToSvg`, and a test keeps the two identical.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "./load.js";
import { renderRates, renderSummary } from "./render.js";
import { writeSyntheticHistory } from "./synthetic.js";
import { ratesView, summaryView, type RatesView, type SummaryView } from "./views.js";

export interface Demo {
  summary: SummaryView;
  rates: RatesView;
  summaryText: string;
  ratesText: string;
  now: number;
}

export async function runDemo(): Promise<Demo> {
  const dir = mkdtempSync(path.join(tmpdir(), "seatledger-demo-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const home = path.join(dir, "home");
    const loaded = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home,
    });
    const summary = summaryView(loaded, synth.now, home);
    const rates = ratesView(loaded, synth.now, undefined);
    return {
      summary,
      rates,
      summaryText: renderSummary(summary, synth.now),
      ratesText: renderRates(rates),
      now: synth.now,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The README screenshot: `seatledger`, then the findings of `seatledger rates`. */
export function screenshotText(demo: Demo): string {
  const rates = demo.ratesText.split("\n");
  const end = rates.findIndex((l) => l.startsWith("Current baselines"));
  return [
    "$ npx seatledger",
    demo.summaryText,
    "",
    "$ npx seatledger rates",
    ...rates.slice(0, end > 0 ? end : rates.length),
  ]
    .join("\n")
    .trimEnd();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Terminal-style SVG of plain text: one <text> per line, monospace, dark background. */
export function textToSvg(text: string): string {
  const lines = text.split("\n");
  // Every line is stretched to exactly its length in cells, so the columns line up whatever
  // monospace font the viewer substitutes.
  const charW = 7.9;
  const lineH = 17;
  const pad = 16;
  const width = Math.ceil(Math.max(...lines.map((l) => l.length)) * charW + pad * 2);
  const height = lines.length * lineH + pad * 2;
  const body = lines
    .map((l, i) => {
      const y = pad + (i + 1) * lineH - 4;
      const cls = l.startsWith("$ ") ? ' class="cmd"' : "";
      const fit =
        l.length > 0
          ? ` textLength="${(l.length * charW).toFixed(1)}" lengthAdjust="spacingAndGlyphs"`
          : "";
      return `  <text x="${pad}" y="${y}"${cls}${fit} xml:space="preserve">${esc(l)}</text>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="seatledger output on synthetic history">
  <style>text{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#d4d4d4}.cmd{fill:#7ee787}</style>
  <rect width="100%" height="100%" rx="8" fill="#0d1117"/>
${body}
</svg>
`;
}
