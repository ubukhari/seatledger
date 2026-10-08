---
name: usage
description: Explain what this machine's Claude Code and Codex usage bought - tokens and API-equivalent dollars today and over the last 7 days, by client and model, progress against limits the user set, and the rate-limit readings Codex wrote locally - by running seatledger, which reads local transcripts only. Use when the user asks what their coding agents cost, how much they used, where their tokens went, or how close they are to a limit.
argument-hint: "[--since 30d] [--by day|project|model|client] [--client claude-code|codex]"
allowed-tools:
  - Bash(npx -y seatledger@latest)
  - Bash(npx -y seatledger@latest *)
---

# Explain what this machine's coding-agent usage bought

seatledger (`seatledger` on npm, MIT) reads Claude Code transcripts (`~/.claude/projects`) and
Codex rollouts (`~/.codex/sessions`) on this machine and prints counts. It makes no network calls
and sends nothing anywhere. The first run reads every transcript and can take a little while;
later runs reuse the counts it keeps in `~/.seatledger`.

Run, with no arguments for the summary:

```sh
npx -y seatledger@latest
```

If the user passed arguments (`$ARGUMENTS`), run the range report instead:

```sh
npx -y seatledger@latest report $ARGUMENTS
```

Then explain the output in plain words, in this order:

1. **Today and the week.** Total tokens and API-equivalent dollars, and which client and model
   carry most of it. Name the busiest day and how it compares with the others.
2. **What "API-equivalent" means.** Say it once: the same tokens at the vendor's API list prices,
   not what the user paid. On a Pro, Max, Plus or Team seat the user pays a flat fee; this number
   is what that seat's usage would have cost on the API. Never call it the bill.
3. **Where the tokens went.** Cache reads are usually most of the tokens and the cheapest per
   token; cache writes and output are where dollars concentrate. If one project or model
   dominates, say so (`npx -y seatledger@latest report --by project` breaks it down).
4. **Limits.** If limits are set, read back each line: how much of the window is used, the burn
   rate, and when the limit is reached at that rate (or that the window resets first). If none
   are set, say that seatledger does not guess a vendor's plan limits, and that
   `npx -y seatledger@latest limits set --window 5h --tokens <N>` records the user's own; the
   "busiest window" figure is a good starting point for N.
5. **Vendor readings.** Codex writes its own 5-hour and weekly window percentages to disk; repeat
   them as Codex reported them, with when they were read.

A line with `*` excludes requests on models with no API list price; their tokens are still
counted. If it found no transcripts, say where it looked (the last lines of the output) and that
`--claude-dir` or `--codex-dir` point it elsewhere.

Do not change limits or delete anything unless the user asks.
