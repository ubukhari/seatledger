# Changelog

## 0.2.0 (2026-10-07)

The team ledger, optional and opt-in.

- `seatledger team join <invite link> --as <name>`: join a hosted team ledger; your own key is
  saved to `~/.seatledger/team.json`, readable by you only (or set `SEATLEDGER_KEY`).
- `seatledger push`: this machine's daily aggregates to that ledger — per day, client, client
  version and model, the request count, four token counts and API-equivalent dollars, plus the
  `rates` findings as numbers. Never prompt, response, tool or file content, file paths, or
  project folder names unless `--project-names`. `--dry-run` prints exactly what would be sent.
  Re-pushing a day replaces it.
- `seatledger team`: the team's plan and your seat.
- MCP: `seatledger_team_summary` reads the team ledger with the saved key (read-only; the one tool
  that makes a network request).
- Every other command is unchanged and still makes no network calls.

## 0.1.0 (2026-10-07)

The free local ledger.

- `seatledger`: today and the last 7 days from this machine's Claude Code transcripts and Codex
  rollouts — requests, input, output, cache writes, cache reads, tokens and API-equivalent dollars
  by client and model and by day; your limits; Codex's own rate-limit readings.
- `seatledger report`: any range by day, project folder, model or client.
- `seatledger rates`: step changes per client and model in tokens per request, cache-read share,
  cache writes per read, tokens per user turn, the 1-hour share of Claude Code cache writes, and
  Codex tokens per 1% of its 5-hour window, with the date and client version where each starts and
  what it is consistent with.
- `seatledger limits set|clear`: your own 5-hour and weekly limits in tokens or API-equivalent
  dollars, with burn rate and projected time to each. No vendor plan limits are hard-coded.
- `seatledger mcp`: read-only stdio MCP server with `seatledger_usage_summary` and
  `seatledger_rate_changes`.
- `seatledger demo`: everything above on synthetic history.
- Counts are kept in `~/.seatledger/cache-v1` so history survives Claude Code's 30-day transcript
  cleanup and later runs read only what changed.
- Price table read 7 Oct 2026 from Anthropic's and OpenAI's pricing pages.
- Claude Code plugin (`/seatledger:usage`, `/seatledger:rates`) and Gemini CLI extension.
