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
    'curl -H "Authorization: Bearer •••" api',
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
  const state = recordAssistantUsage(
    createState(),
    {
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 140,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    { tokens: 140, contextWindow: 1000, percent: 14 },
  );
  expect(state.usage).toMatchObject({
    input: 100,
    output: 25,
    cacheRead: 10,
    cacheWrite: 5,
    costUsd: 0.03,
    tokens: 140,
    percent: 14,
  });
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
  state = updateSubagentResult(
    state,
    "sub",
    { results: [{ exitCode: -1, usage: { input: 10, output: 3, contextTokens: 10 }, model: "m" }] },
    110,
  );
  expect(state.agents[0]).toMatchObject({ status: "running", inputTokens: 10, outputTokens: 3, model: "m" });
  state = finishTool(state, "sub", false, 120);
  expect(state.agents[0]?.status).toBe("done");
});

test("reset preserves model and thinking but clears live telemetry", () => {
  const original = createState();
  const state = { ...original, main: { ...original.main, model: "x", thinking: "high" }, gate: DEFAULT_GATE };
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
