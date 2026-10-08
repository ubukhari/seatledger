---
name: rates
description: Explain whether the same coding-agent work started costing a different number of tokens - step changes in tokens per request, cache-read share, cache writes per read, tokens per user turn, the 1-hour versus 5-minute cache split, and Codex tokens per 1% of its 5-hour window - with the date and client version where each starts, by running seatledger rates on local transcripts. Use when the user suspects their usage limits or costs changed, or asks whether an update made things more expensive.
argument-hint: "[--since 90d] [--client claude-code|codex] [--model <id>]"
---

# Explain step changes in token rates

seatledger (`seatledger` on npm, MIT) reads this machine's Claude Code and Codex transcripts and
looks, per client and model, for days where the way requests use tokens stepped up or down and
stayed there. It makes no network calls and sends nothing anywhere.

Run it with the Bash tool (Claude Code asks the user to approve the command; this skill pre-approves
nothing):

```sh
npx -y seatledger@latest rates $ARGUMENTS
```

Then explain it in plain words:

1. **Each finding**, newest first: what moved, from when, by how much, on which model, and the
   client version in use from that day. Say whether that day was the first on a new version.
   Quote the before and after values and the day ranges they come from.
2. **What it is consistent with**, using the finding's own wording. seatledger sees requests on
   this machine, not the vendor's servers, so it never states a cause, and neither should you.
   Two exceptions are observations, not inferences: a change in the share of cache writes at the
   1-hour lifetime is recorded in the transcript itself, and Codex's window percentages are what
   Codex reported.
3. **Whether the user's own work could explain it.** If no version change coincides, a new
   repository, a bigger task, more subagents or a different model setting moves these numbers
   too. Ask what changed on their side around that date.
4. **No findings** means no step of at least 30% (10 points for shares) that held for several
   days; it does not mean nothing changed. Read the "Current baselines" table back briefly.

If a finding coincides with a version change and the user wants to act on it, useful next steps
are: read that version's changelog, compare against the previous version, and attach the
finding's numbers (they contain no prompt or code) to a report to the vendor. Do not file
anything on the user's behalf.
