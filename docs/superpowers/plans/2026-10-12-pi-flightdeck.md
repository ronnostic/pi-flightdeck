# Pi Flightdeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a Pi package that ports Flightdeck's live session dashboard into a compact Pi widget and interactive `/flightdeck` overlay.

**Architecture:** Keep all state transitions, redaction, bucketing, usage math, subagent-task extraction, and formatting helpers in a dependency-free `src/core.ts` module. Keep Pi event wiring and TUI rendering in `src/extension.ts`; both the persistent widget and the command overlay read the same in-memory state and invalidate on event changes. Use Pi's host packages as peer dependencies and no runtime child process or network code.

**Tech Stack:** TypeScript, Pi ExtensionAPI, `@earendil-works/pi-tui`, Bun's built-in test runner, npm package metadata.

**Spec:** `docs/superpowers/specs/2026-10-12-pi-flightdeck.md`

## Global Constraints

- Package name is `pi-flightdeck` and extension entry point is `src/extension.ts`.
- Pi host packages stay in `peerDependencies`, never runtime `dependencies`.
- No network requests, subprocesses, external state files, or LLM-callable tools.
- Permission display must say it shows Pi tool outcomes, because Pi exposes no separate permission verdict event.
- Production code follows red-green-refactor: each pure behavior test is written and observed failing before its implementation.
- Terminal lines are width-safe through `truncateToWidth`/`visibleWidth`; no raw unbounded widget lines.

---

### Task 1: Create package scaffold and failing core tests

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/core.ts`
- Create: `test/core.test.ts`
- Create: `README.md`
- Create: `LICENSE`

**Interfaces:**
- `src/core.ts` exports the state types and pure functions tested below.
- `src/extension.ts` will consume `createState`, `recordToolStart`, `finishTool`, `recordAssistantUsage`, `extractSubagentTasks`, `updateSubagentResult`, `resetLiveState`, and formatting helpers.

- [ ] **Step 1: Initialize the standalone repository and package metadata**

Run:

```bash
mkdir -p /home/ubuntu/Projects/pi-flightdeck/src /home/ubuntu/Projects/pi-flightdeck/test
cd /home/ubuntu/Projects/pi-flightdeck
git init -b main
```

Create `package.json` with:

```json
{
  "name": "pi-flightdeck",
  "version": "0.1.0",
  "description": "Live agent dashboard extension for Pi",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "flightdeck"],
  "license": "MIT",
  "files": ["src", "README.md", "LICENSE"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "pi": {
    "extensions": ["./src/extension.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^1.1.0",
    "@earendil-works/pi-tui": "^0.1.0",
    "typescript": "^5.9.0"
  }
}
```

Create strict `tsconfig.json` targeting ES2022, using bundler resolution, allowing `.ts` imports, and including `src/**/*.ts` only. Ignore `node_modules`, `dist`, and test files for typechecking.

- [ ] **Step 2: Write failing pure-core tests before implementation**

`test/core.test.ts` must cover these exact behaviors:

```ts
import { expect, test } from "bun:test";
import {
  DEFAULT_GATE,
  createState,
  extractSubagentTasks,
  finishTool,
  formatDuration,
  gateSummary,
  recordAssistantUsage,
  recordToolStart,
  redact,
  resetLiveState,
  updateSubagentResult,
} from "../src/core.ts";

test("redacts secrets and keeps useful tool descriptions", () => {
  expect(redact('curl -H "Authorization: Bearer abcdefgh12345" api')).toBe(
    "curl -H \"Authorization: Bearer •••\" api",
  );
  expect(redact("export OPENAI_API_KEY=sk-proj-1234567890abcdef")).not.toContain("1234567890");
});

test("tool checks move from pending to success or failure and tally by family", () => {
  let state = createState();
  state = recordToolStart(state, "one", "read", { file_path: "/src/a.ts" }, false, 100);
  state = recordToolStart(state, "two", "bash", { command: "npm test" }, false, 101);
  state = finishTool(state, "one", false, 120);
  state = finishTool(state, "two", true, 130);
  expect(gateSummary(state.gate)).toEqual({ total: 2, pending: 0, success: 1, failed: 1 });
  expect(state.gate.recent[0]?.status).toBe("success");
  expect(state.gate.recent[1]?.status).toBe("failed");
});

test("assistant usage updates session totals and current context", () => {
  const state = recordAssistantUsage(createState(), {
    input: 100,
    output: 25,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 140,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  }, { tokens: 140, contextWindow: 1000, percent: 14 });
  expect(state.usage).toMatchObject({ input: 100, output: 25, cacheRead: 10, cacheWrite: 5, costUsd: 0.03, tokens: 140, percent: 14 });
});

test("subagent args create cards for single, parallel, and chain work", () => {
  expect(extractSubagentTasks({ agent: "Explore", task: "Map call sites" }, "tool-1")).toEqual([
    { id: "tool-1:0", type: "Explore", task: "Map call sites" },
  ]);
  expect(extractSubagentTasks({ tasks: [{ agent: "a", task: "one" }, { agent: "b", task: "two" }] }, "tool-2")).toHaveLength(2);
  expect(extractSubagentTasks({ chain: [{ agent: "review", task: "review" }] }, "tool-3")).toHaveLength(1);
});

test("subagent result updates status and usage", () => {
  let state = recordToolStart(createState(), "sub", "subagent", { agent: "Explore", task: "find" }, false, 100);
  state = updateSubagentResult(state, "sub", { results: [{ exitCode: -1, usage: { input: 10, output: 3, contextTokens: 10 }, model: "m" }] }, 110);
  expect(state.agents[0]).toMatchObject({ status: "running", inputTokens: 10, outputTokens: 3, model: "m" });
  state = finishTool(state, "sub", false, 120);
  expect(state.agents[0]?.status).toBe("done");
});

test("reset preserves model and thinking but clears live telemetry", () => {
  const state = { ...createState(), main: { ...createState().main, model: "x", thinking: "high" }, gate: DEFAULT_GATE };
  const reset = resetLiveState(state);
  expect(reset.main).toMatchObject({ model: "x", thinking: "high", requestCount: 0, running: false });
  expect(reset.agents).toHaveLength(0);
  expect(reset.gate.recent).toHaveLength(0);
});

test("durations clamp negative and format short and long runs", () => {
  expect(formatDuration(-1)).toBe("0s");
  expect(formatDuration(5_000)).toBe("5s");
  expect(formatDuration(65_000)).toBe("1m05s");
});
```

- [ ] **Step 3: Run tests and confirm expected missing-function failures**

Run: `bun test test/core.test.ts`

Expected: FAIL because `src/core.ts` does not yet export the named functions. Fix only test syntax or import errors if needed; do not implement production behavior before this failure is observed.

- [ ] **Step 4: Implement the minimum pure core**

Implement state types and functions named by the tests. Use immutable state replacement, 80 recent gate entries, 24 agent cards, 60 log lines, bucket names `file|shell|other`, and status values `pending|success|failed|done|stopped`. Make `recordToolStart` idempotent for duplicate tool IDs and make `finishTool` leave unknown IDs unchanged. Redaction must cover bearer/API-key/token/password patterns and credential-bearing URLs before state storage.

- [ ] **Step 5: Run core tests and typecheck**

Run:

```bash
bun test test/core.test.ts
npm run typecheck
```

Expected: all core tests pass and TypeScript reports no errors.

- [ ] **Step 6: Add minimal project docs and commit scaffold**

Write README installation/development placeholders only after implementation exists in later tasks; for this task include package identity, license text, and `.gitignore` entries for `node_modules`, `dist`, `.DS_Store`, and `.env*`. Commit:

```bash
git add package.json tsconfig.json .gitignore src/core.ts test/core.test.ts LICENSE README.md docs
 git commit -m "chore: scaffold pi flightdeck package"
```

---

### Task 2: Implement Pi event wiring and dashboard UI

**Files:**
- Create: `src/extension.ts`
- Modify: `src/core.ts`
- Modify: `test/core.test.ts` only if a newly discovered pure behavior needs a regression test

**Interfaces:**
- `src/extension.ts` exports the default `ExtensionFactory`.
- Registers `/flightdeck` with `open|close|reset|layout mini|compact|wide` arguments.
- Uses `pi.on` for `session_start`, `session_shutdown`, `session_tree`, `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_end`, `tool_call`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_result`, `model_select`, `thinking_level_select`, `session_compact`, and `ui_prompt_start`/`ui_prompt_end`.
- Uses `ctx.ui.setWidget` for a live above-editor widget and `ctx.ui.custom` for the focused overlay.

- [ ] **Step 1: Add any event-to-core failing tests needed for extraction edge cases**

Before changing core, add one test for each missing case. At minimum verify malformed subagent result details do not throw and redact `url` credentials. Run `bun test test/core.test.ts` and observe failures.

- [ ] **Step 2: Implement event state updates**

Keep one module-local `FlightdeckState`. On session start, reset live state, record current model/thinking/context usage, and install the widget when UI exists. On `agent_start` and `agent_end`, set the running flag and produce a receipt. On assistant `message_end`, add usage/cost and refresh context usage. On tool call/execution events, record pending outcomes, edits (`edit`/`write`), errors, nested-call markers, log lines, and subagent cards. Parse the `subagent` tool's `agent`/`task`, `tasks`, and `chain` forms; merge partial `details.results` usage/status; classify names containing `advisor`, `architect`, or `review` as architect consults. Count compactions and prompt UI events without pretending they are permission verdicts. On tree/session replacement, clear live state.

- [ ] **Step 3: Implement width-safe dashboard rendering**

Create a `DashboardComponent` implementing `Component`, with shared state reference, `render(width)`, `invalidate()`, `handleInput()`, and `dispose()`. Render mini mode in at most 8 rows; compact mode with main/gate/agents/receipt/log sections; wide overlay with boxed main, architect, gate, agents, loops/unknown nested calls, receipt, and log sections. Use theme semantic colors and `truncateToWidth`/`visibleWidth`. Show `GATE · tool outcomes` and an in-dashboard note in wide mode that Pi has no separate permission verdict event. Keep empty panels hidden.

- [ ] **Step 4: Implement commands and UI lifecycle**

`/flightdeck` opens the overlay and leaves the compact widget active; overlay `Esc`/`Ctrl-C` closes it. `/flightdeck close` removes widget and closes overlay. `/flightdeck reset` uses `resetLiveState`, retains current model/thinking, and notifies. `/flightdeck layout ...` changes state and invalidates. Number keys select agents; `f`, `s`, `o` set gate filters. Set a short status line with context/running agents/architect/failures. Clear widget/status during shutdown.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test
npm run typecheck
```

Expected: all tests pass with no TypeScript errors.

- [ ] **Step 6: Commit the working extension**

```bash
git add src test
 git commit -m "feat: add live flightdeck dashboard extension"
```

---

### Task 3: Document and validate the package locally

**Files:**
- Modify: `README.md`
- Modify: `package.json` only if package metadata needs correction

**Interfaces:**
- README must give copy-paste commands for local install, reload, `/flightdeck`, layout/reset/close commands, tests, typecheck, and known Pi API limitations.

- [ ] **Step 1: Write complete user documentation**

Document:

```text
pi install /home/ubuntu/Projects/pi-flightdeck
/reload
/flightdeck
```

Also document `pi install git:github.com/ronnostic/pi-flightdeck`, `pi list`, `pi remove`, and direct development `pi --extension ./src/extension.ts`. State explicitly that the gate is tool outcome telemetry in Pi, not Claude Code permission verdicts, and that subagent visibility depends on a `subagent` tool exposing task details.

- [ ] **Step 2: Run package checks**

Run:

```bash
npm install
bun test
npm run typecheck
pi --extension ./src/extension.ts --help
```

Expected: tests/typecheck pass and Pi help starts without extension-load errors.

- [ ] **Step 3: Install local package and verify resource discovery**

Run:

```bash
pi install /home/ubuntu/Projects/pi-flightdeck
pi list
```

Confirm the local package is listed and its extension path resolves. Start an interactive `pi`, run `/flightdeck`, `/flightdeck layout wide`, `/flightdeck reset`, and `/flightdeck close`, then `/reload` and `/flightdeck` again. Confirm no errors and that widget/overlay appears.

- [ ] **Step 4: Commit docs and local-install verification**

```bash
git add README.md package.json package-lock.json
 git commit -m "docs: document pi flightdeck installation"
```

---

### Task 4: Create GitHub repository and publish

**Files:**
- No source changes expected.

**Interfaces:**
- Remote `origin` is `git@github.com:ronnostic/pi-flightdeck.git`.
- Main branch is pushed and GitHub URL is recorded in README.

- [ ] **Step 1: Create GitHub repository with gh**

Run from the repository:

```bash
gh repo create ronnostic/pi-flightdeck --public --source=. --remote=origin --push --description "Live agent dashboard extension for Pi"
```

If GitHub rejects an already-created remote, inspect `git remote -v` and push the existing `main` branch without deleting data.

- [ ] **Step 2: Verify published repository**

Run:

```bash
git status --short --branch
git remote -v
gh repo view ronnostic/pi-flightdeck --json nameWithOwner,url,defaultBranchRef
```

Expected: clean `main`, origin points to GitHub, default branch is `main`, and README install commands include the Git source.

- [ ] **Step 3: Reconcile local package after publishing**

Run `pi update /home/ubuntu/Projects/pi-flightdeck` or reinstall the local source if needed, then run `pi list` and one final interactive `/reload` + `/flightdeck` check. Do not claim live TUI verification if the terminal session cannot be driven non-interactively; report that limitation.

- [ ] **Step 4: Final commit if README gained the remote URL**

```bash
git add README.md
git commit -m "docs: add published repository URL"
git push origin main
```

---

## Self-review checklist

- [ ] Spec coverage: widget, overlay, commands, telemetry, redaction, subagent cards, receipts, installation, GitHub publication, and limitations each map to a task.
- [ ] No task asks for an unspecified helper or vague edge-case handling.
- [ ] All names used by later tasks are defined in Task 1 or Task 2.
- [ ] Every production behavior has a test or is a thin Pi event/UI adapter over tested core functions.
