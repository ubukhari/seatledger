/** Plain-text output: compact numbers, local dates and fixed-width tables. No colours, no deps. */

export function tokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function usd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 7 Oct" for a YYYY-MM-DD key. */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return `${DAYS[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** "14:05", or "Fri 10 Oct 14:05" when not on the day of `now`. */
export function clock(ts: number, now: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hm;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.round(h / 24)}d`;
}

export type Align = "left" | "right";

/** A table with a header row; numeric columns right-aligned. */
export function table(head: string[], rows: string[][], align: Align[] = []): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) =>
        (align[i] ?? (i === 0 ? "left" : "right")) === "right"
          ? c.padStart(widths[i]!)
          : c.padEnd(widths[i]!),
      )
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)].map((l) => `  ${l}`).join("\n");
}
