# Pi Flightdeck

Live agent dashboard extension for [Pi](https://github.com/earendil-works/pi), ported from [Claude Flightdeck](https://github.com/scasella/claude-flightdeck).

Flightdeck stays local. It watches Pi lifecycle/tool events and renders context/cost telemetry, tool outcomes, subagent tasks, architect-style consults, turn receipts, and a short log.

## Install

From this checkout:

```sh
pi install /home/ubuntu/Projects/pi-flightdeck
```

From GitHub:

```sh
pi install git:github.com/ronnostic/pi-flightdeck
```

Reload Pi, then open dashboard:

```text
/reload
/flightdeck
```

The compact widget loads above editor on session start. `/flightdeck` opens focused dashboard overlay.

## Commands

| Command | Action |
| --- | --- |
| `/flightdeck` | Open focused dashboard overlay |
| `/flightdeck close` | Hide widget and close dashboard |
| `/flightdeck reset` | Clear live agents, checks, log, and receipt; preserve model/thinking and session totals |
| `/flightdeck layout mini` | Compact widget, at most eight rows |
| `/flightdeck layout compact` | Multi-panel widget |
| `/flightdeck layout wide` | Full multi-panel widget |

Overlay keys: `Esc`/`Ctrl-C` close, `1`–`6` expand an agent, `f`/`s`/`o` filter file/shell/other tool outcomes, `r` reset.

## What it shows

- **Main:** model, thinking level, request count, context gauge, token totals, cost, and compaction count.
- **Gate:** pending, successful, and failed tool executions with credentials redacted before storage.
- **Agents:** tasks exposed through Pi's `subagent` tool, status, model, elapsed time, steps, usage, nested tool notes, and answer preview.
- **Architect:** inferred advisor/architect/reviewer subagent tasks and first advice line when the subagent result exposes it.
- **Receipt:** duration, agents, edits, errors, and cost added by last run.
- **Log:** prompts, edits, failures, compactions, and consult notes.

## Pi API limits

Pi currently exposes tool lifecycle events, not Claude Code's separate permission verdict event. Flightdeck's gate therefore reports tool execution outcomes, not whether a call was allowed by rule, user, or classifier. Pi also has no generic subagent lifecycle event; agent cards appear when a `subagent` tool exposes single/parallel/chain task arguments and result details.

No network requests, subprocesses, model calls, or external state files are used.

## Development

```sh
npm install
bun test
npm run typecheck
```

Load source directly during development:

```sh
pi --extension ./src/extension.ts
```

After editing a loaded extension, run `/reload`.

## License

MIT
