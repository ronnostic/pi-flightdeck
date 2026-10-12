# Pi Flightdeck Specification

## Goal

Port the useful Flightdeck experience from `scasella/claude-flightdeck` to Pi as a local-installable Pi package named `pi-flightdeck`.

## User-visible behavior

- Pi loads a persistent compact Flightdeck widget above the editor.
- `/flightdeck` opens an interactive dashboard overlay.
- `/flightdeck close` hides the widget and closes an open overlay.
- `/flightdeck reset` clears live session counters while preserving current model and thinking level.
- `/flightdeck layout mini|compact|wide` changes dashboard density.
- Dashboard shows:
  - model, thinking level, working/idle state, request count;
  - context gauge, context tokens/window, session token totals, and session cost;
  - tool-call gate strip with pending/succeeded/failed outcomes and redacted call details;
  - subagent tasks exposed through Pi's `subagent` tool, with status, elapsed time, model, steps, context/output usage when available;
  - architect/reviewer consults inferred from matching subagent task names;
  - current/last-turn receipt with duration, agents, edits, errors, and cost delta;
  - short session log.
- Overlay keyboard controls:
  - `Esc`/`Ctrl-C`: close;
  - `1`–`6`: select/expand an agent;
  - `f`, `s`, `o`: filter gate details by file, shell, or other tool family.
- State remains in memory for the active Pi session and resets on session replacement/clear. No network requests, child processes, or external state files are used by the extension.

## Pi-specific limits

Pi exposes tool lifecycle events, not Claude Code's `tool.check` permission verdict event. Flightdeck therefore records tool-call execution outcomes rather than claiming to know whether a call was allowed by rule, user, or classifier. Pi also has no generic subagent lifecycle event; the extension recognizes the built-in/typical `subagent` tool arguments and partial result details when present.

## Package/install contract

- New standalone Git repository: `/home/ubuntu/Projects/pi-flightdeck`.
- Package manifest declares `pi.extensions: ["./src/extension.ts"]`.
- Local installation uses `pi install /home/ubuntu/Projects/pi-flightdeck`.
- GitHub repository is created and pushed with `gh repo create` under authenticated account `ronnostic`.
- README documents local install, `/reload`, `/flightdeck`, limitations, tests, and development commands.

## Non-goals

- Reproducing Claude Code's docked side pane, desktop/mobile SVG surface, encrypted server advisor events, rate-limit windows, or permission classifier verdicts.
- Adding an LLM tool, MCP server, provider, dependency, or persistent database.
- Reimplementing Pi's transcript renderer or editor.
