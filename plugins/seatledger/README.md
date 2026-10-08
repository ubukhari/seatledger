# seatledger

What this machine's Claude Code and Codex seats and tokens bought, explained inside Claude Code.

- `/seatledger:usage` runs `npx -y seatledger@latest` (or `report` with your arguments) and
  explains today and the last 7 days: tokens and API-equivalent dollars by client and model, the
  limits you set, and the window readings Codex writes to disk.
- `/seatledger:rates` runs `npx -y seatledger@latest rates` and explains any step change in tokens
  per request, cache use, tokens per turn or Codex's tokens per 1% of its 5-hour window, with the
  date and client version where it starts.

## What it runs, reads and sends

- **Runs** one command per skill, through the Bash tool. The skills pre-approve nothing, so
  Claude Code asks you before each command.
- **Fetches** the `seatledger` package from the npm registry, which is what `npx` does.
- **Reads** this machine's Claude Code transcripts (`~/.claude/projects`) and Codex rollouts
  (`~/.codex/sessions`), and keeps counts, never text, in `~/.seatledger`.
- **Sends nothing.** The commands these skills run make no network request. seatledger's optional
  team ledger is a separate, explicit step (`seatledger team create`, `team join`, `push`) that
  these skills never run.
- **No LLM calls** of its own, no telemetry, no account.

Dollars are API-equivalent: the same tokens at the vendor's API list prices, not your bill.

Source, the full CLI and its documentation: [github.com/agentwares/seatledger](https://github.com/agentwares/seatledger).
MIT licensed, by agentwares.
