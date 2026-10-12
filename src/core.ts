export type Layout = "mini" | "compact" | "wide";
export type ToolBucket = "file" | "shell" | "other";
export type ToolStatus = "pending" | "success" | "failed";
export type AgentStatus = "running" | "done" | "failed" | "stopped";
export type LogKind = "info" | "error" | "consult" | "done";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	compactions: number;
}

export interface MainState {
	model: string;
	thinking: string;
	running: boolean;
	requestCount: number;
}

export interface GateCheck {
	id: string;
	tool: string;
	bucket: ToolBucket;
	status: ToolStatus;
	inSubagent: boolean;
	detail: string;
	startedAt: number;
	endedAt: number | null;
}

export interface GateState {
	recent: GateCheck[];
}

export interface ToolNote {
	tool: string;
	text: string;
	isError: boolean;
}

export interface AgentCard {
	id: string;
	type: string;
	task: string;
	status: AgentStatus;
	spawnedAt: number;
	endedAt: number | null;
	model: string;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	steps: number;
	tools: ToolNote[];
	answer: string;
	isArchitect: boolean;
}

export interface Consult {
	id: string;
	type: string;
	startedAt: number;
	endedAt: number | null;
}

export interface ArchitectState {
	consults: Consult[];
	lastAdvice: string;
}

export interface TurnState {
	startedAt: number;
	edited: number;
	errors: number;
	errorStreak: number;
	agentsAtStart: number;
	costAtStart: number;
}

export interface Receipt {
	durationMs: number;
	agents: number;
	edits: number;
	errors: number;
	costDelta: number | null;
	reason: string;
}

export interface LogLine {
	at: number;
	who: string;
	text: string;
	kind: LogKind;
	agentId: string | null;
}

export interface FlightdeckState {
	main: MainState;
	usage: UsageTotals;
	gate: GateState;
	agents: AgentCard[];
	architect: ArchitectState;
	loops: number;
	nestedCalls: number;
	turn: TurnState;
	receipt: Receipt | null;
	log: LogLine[];
	layout: Layout;
	selectedAgentId: string | null;
	gateFilter: ToolBucket | null;
	pendingUiPrompts: number;
}

export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface SubagentTask {
	id: string;
	type: string;
	task: string;
}

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const ARCHITECT_PATTERN = /advisor|architect|review/i;

export const DEFAULT_GATE: GateState = { recent: [] };

export function createState(): FlightdeckState {
	return {
		main: { model: "", thinking: "", running: false, requestCount: 0 },
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
			tokens: null,
			contextWindow: 0,
			percent: null,
			compactions: 0,
		},
		gate: cloneGate(DEFAULT_GATE),
		agents: [],
		architect: { consults: [], lastAdvice: "" },
		loops: 0,
		nestedCalls: 0,
		turn: { startedAt: 0, edited: 0, errors: 0, errorStreak: 0, agentsAtStart: 0, costAtStart: 0 },
		receipt: null,
		log: [],
		layout: "mini",
		selectedAgentId: null,
		gateFilter: null,
		pendingUiPrompts: 0,
	};
}

function cloneGate(gate: GateState): GateState {
	return { recent: gate.recent.map((check) => ({ ...check })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function shorten(value: string, limit: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : oneLine;
}

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
	[/((?:authorization\s*[:=]\s*)(?:bearer|basic)\s+)([^"'\s]+)/gi, "$1•••"],
	[/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)(["']?)([^"'\s]+)(["']?)/gi, "$1$2•••$4"],
	[/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "•••"],
	[/((?:--token|--password|--api-key|--secret)[= ])\S+/gi, "$1•••"],
	[/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, "$1•••"],
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, "$1•••@"],
];

export function redact(value: string): string {
	return REDACTION_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function bucketOf(tool: string): ToolBucket {
	const normalized = tool.toLowerCase();
	return FILE_TOOLS.has(normalized) ? "file" : SHELL_TOOLS.has(normalized) ? "shell" : "other";
}

export function describeInput(tool: string, input: unknown): string {
	const args = isRecord(input) ? input : {};
	const filePath = stringValue(args.file_path || args.path);
	const pathTail = filePath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
	const detail =
		stringValue(args.command) ||
		pathTail ||
		stringValue(args.pattern) ||
		stringValue(args.url) ||
		stringValue(args.task) ||
		stringValue(args.description);
	return redact(detail ? `${tool} → ${detail}` : tool);
}

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTimer(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function formatClock(milliseconds: number): string {
	return milliseconds > 0 ? new Date(milliseconds).toTimeString().slice(0, 8) : "--:--:--";
}

export function formatUsd(value: number): string {
	return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

export function prettyModel(id: string): string {
	if (!id) return "—";
	const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
	const oneMillion = /\[1m\]|-1m\b/i.test(id) ? " 1M" : "";
	const current = /(?:^|[/.:])claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?![\d])/i.exec(id);
	if (current?.[1]) return `${cap(current[1].toLowerCase())} ${current[2]}${current[3] ? `.${current[3]}` : ""}${oneMillion}`;
	const legacy = /claude-(\d+)(?:-(\d))?-([a-z]+)/i.exec(id);
	if (legacy?.[3]) return `${cap(legacy[3].toLowerCase())} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}${oneMillion}`;
	return shorten(id, 22);
}

export function gauge(percent: number | null, width: number): { on: string; off: string } | null {
	if (percent === null) return null;
	const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return { on: "▰".repeat(full), off: "▱".repeat(width - full) };
}

export function gateSummary(gate: GateState) {
	return gate.recent.reduce(
		(summary, check) => {
			summary[check.status] += 1;
			summary.total += 1;
			return summary;
		},
		{ total: 0, pending: 0, success: 0, failed: 0 },
	);
}

export function extractSubagentTasks(input: unknown, toolCallId: string): SubagentTask[] {
	if (!isRecord(input)) return [];
	const tasks: SubagentTask[] = [];
	const add = (value: unknown, index: number) => {
		if (!isRecord(value)) return;
		const type = stringValue(value.agent) || stringValue(value.name) || "subagent";
		const task = stringValue(value.task) || stringValue(value.prompt);
		if (task) tasks.push({ id: `${toolCallId}:${index}`, type, task });
	};
	if (stringValue(input.agent) && (stringValue(input.task) || stringValue(input.prompt))) add(input, tasks.length);
	if (Array.isArray(input.tasks)) input.tasks.forEach((task, index) => add(task, index));
	if (Array.isArray(input.chain)) input.chain.forEach((task, index) => add(task, index));
	return tasks;
}

function isArchitectType(type: string): boolean {
	return ARCHITECT_PATTERN.test(type);
}

function newAgent(task: SubagentTask, at: number): AgentCard {
	return {
		id: task.id,
		type: task.type,
		task: task.task,
		status: "running",
		spawnedAt: at,
		endedAt: null,
		model: "",
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		steps: 0,
		tools: [],
		answer: "",
		isArchitect: isArchitectType(task.type),
	};
}

function addAgents(state: FlightdeckState, tasks: SubagentTask[], at: number): FlightdeckState {
	if (tasks.length === 0) return state;
	const existing = new Set(state.agents.map((agent) => agent.id));
	const added = tasks.filter((task) => !existing.has(task.id)).map((task) => newAgent(task, at));
	if (added.length === 0) return state;
	const architects = added.filter((agent) => agent.isArchitect).map((agent) => ({
		id: agent.id,
		type: agent.type,
		startedAt: agent.spawnedAt,
		endedAt: null,
	}));
	return {
		...state,
		agents: [...state.agents, ...added].slice(-24),
		architect: architects.length
			? { ...state.architect, consults: [...state.architect.consults, ...architects].slice(-40) }
			: state.architect,
	};
}

export function recordToolStart(
	state: FlightdeckState,
	id: string,
	tool: string,
	input: unknown,
	inSubagent: boolean,
	at: number,
): FlightdeckState {
	if (state.gate.recent.some((check) => check.id === id)) return state;
	const check: GateCheck = {
		id,
		tool,
		bucket: bucketOf(tool),
		status: "pending",
		inSubagent,
		detail: describeInput(tool, input),
		startedAt: at,
		endedAt: null,
	};
	const next = {
		...state,
		gate: { recent: [...state.gate.recent, check].slice(-80) },
	};
	return tool.toLowerCase() === "subagent" ? addAgents(next, extractSubagentTasks(input, id), at) : next;
}

function updateArchitectEnd(state: ArchitectState, agent: AgentCard, at: number): ArchitectState {
	return {
		...state,
		consults: state.consults.map((consult) =>
			consult.id === agent.id && consult.endedAt === null ? { ...consult, endedAt: at } : consult,
		),
	};
}

export function finishTool(state: FlightdeckState, id: string, failed: boolean, at: number): FlightdeckState {
	const check = state.gate.recent.find((candidate) => candidate.id === id);
	if (!check || check.status !== "pending") return state;
	const status: ToolStatus = failed ? "failed" : "success";
	const recent = state.gate.recent.map((candidate) =>
		candidate.id === id ? { ...candidate, status, endedAt: at } : candidate,
	);
	const agents = state.agents.map((agent): AgentCard =>
		agent.id.startsWith(`${id}:`)
			? { ...agent, status: failed ? "failed" : "done", endedAt: at }
			: agent,
	);
	const next = { ...state, gate: { recent }, agents };
	return {
		...next,
		architect: agents
			.filter((agent) => agent.id.startsWith(`${id}:`) && agent.isArchitect)
			.reduce((result, agent) => updateArchitectEnd(result, agent, at), next.architect),
	};
}

export function updateSubagentResult(state: FlightdeckState, toolCallId: string, details: unknown, at: number): FlightdeckState {
	if (!isRecord(details) || !Array.isArray(details.results)) return state;
	const results = details.results;
	const agents = state.agents.map((agent, index) => {
		if (!agent.id.startsWith(`${toolCallId}:`)) return agent;
		const result = results[index];
		if (!isRecord(result)) return agent;
		const usage = isRecord(result.usage) ? result.usage : {};
		const exitCode = numberValue(result.exitCode, -1);
		const stopReason = stringValue(result.stopReason);
		const status: AgentStatus =
			exitCode === -1 ? "running" : stopReason === "aborted" ? "stopped" : exitCode === 0 ? "done" : "failed";
		return {
			...agent,
			status,
			endedAt: status === "running" ? agent.endedAt : agent.endedAt ?? at,
			model: stringValue(result.model) || agent.model,
			inputTokens: numberValue(usage.input, agent.inputTokens),
			outputTokens: numberValue(usage.output, agent.outputTokens),
			contextTokens: numberValue(usage.contextTokens, agent.contextTokens),
			steps: numberValue(usage.turns, agent.steps),
			answer: shorten(stringValue(result.output) || stringValue(result.answer), 400),
		};
	});
	return { ...state, agents };
}

export function addAgentToolNote(state: FlightdeckState, toolCallId: string, tool: string, input: unknown, failed: boolean): FlightdeckState {
	const text = describeInput(tool, input);
	const target = state.agents.find((agent) => agent.id === toolCallId || agent.id.startsWith(`${toolCallId}:`))?.id;
	if (!target) return state;
	return {
		...state,
		agents: state.agents.map((agent) =>
			agent.id === target ? { ...agent, tools: [...agent.tools, { tool, text, isError: failed }].slice(-3) } : agent,
		),
	};
}

export function recordAssistantUsage(state: FlightdeckState, usage: AssistantUsage, context: ContextUsage | undefined): FlightdeckState {
	return {
		...state,
		usage: {
			...state.usage,
			input: state.usage.input + numberValue(usage.input),
			output: state.usage.output + numberValue(usage.output),
			cacheRead: state.usage.cacheRead + numberValue(usage.cacheRead),
			cacheWrite: state.usage.cacheWrite + numberValue(usage.cacheWrite),
			costUsd: state.usage.costUsd + numberValue(usage.cost?.total),
			tokens: context?.tokens ?? state.usage.tokens,
			contextWindow: context?.contextWindow ?? state.usage.contextWindow,
			percent: context?.percent ?? state.usage.percent,
		},
	};
}

export function setContextUsage(state: FlightdeckState, context: ContextUsage | undefined): FlightdeckState {
	if (!context) return state;
	return {
		...state,
		usage: { ...state.usage, tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent },
	};
}

export function appendLog(state: FlightdeckState, line: Omit<LogLine, "agentId"> & { agentId?: string | null }): FlightdeckState {
	return {
		...state,
		log: [...state.log, { ...line, agentId: line.agentId ?? null }].slice(-60),
	};
}

export function markToolCall(state: FlightdeckState, tool: string, failed: boolean, inSubagent: boolean): FlightdeckState {
	if (EDIT_TOOLS.has(tool.toLowerCase())) {
		return {
			...state,
			turn: {
				...state.turn,
				edited: state.turn.edited + (failed ? 0 : 1),
				errors: state.turn.errors + (failed && !inSubagent ? 1 : 0),
				errorStreak: failed && !inSubagent ? state.turn.errorStreak + 1 : inSubagent ? state.turn.errorStreak : 0,
			},
		};
	}
	return {
		...state,
		turn: {
			...state.turn,
			errors: state.turn.errors + (failed && !inSubagent ? 1 : 0),
			errorStreak: failed && !inSubagent ? state.turn.errorStreak + 1 : inSubagent ? state.turn.errorStreak : 0,
		},
	};
}

export function resetLiveState(state: FlightdeckState): FlightdeckState {
	const fresh = createState();
	return {
		...fresh,
		main: { ...fresh.main, model: state.main.model, thinking: state.main.thinking },
		usage: { ...state.usage, tokens: null, percent: null },
		layout: state.layout,
	};
}

export function startTurn(state: FlightdeckState, at: number): FlightdeckState {
	return {
		...state,
		main: { ...state.main, running: true, requestCount: state.main.requestCount + 1 },
		turn: { ...state.turn, startedAt: state.turn.startedAt || at, agentsAtStart: state.agents.length, costAtStart: state.usage.costUsd },
	};
}

export function startAgentRun(state: FlightdeckState, at: number): FlightdeckState {
	return {
		...state,
		main: { ...state.main, running: true },
		turn: { startedAt: at, edited: 0, errors: 0, errorStreak: 0, agentsAtStart: state.agents.length, costAtStart: state.usage.costUsd },
		receipt: null,
	};
}

export function endAgentRun(state: FlightdeckState, at: number, reason: string): FlightdeckState {
	const durationMs = state.turn.startedAt > 0 ? Math.max(0, at - state.turn.startedAt) : 0;
	return {
		...state,
		main: { ...state.main, running: false },
		receipt: {
			durationMs,
			agents: Math.max(0, state.agents.length - state.turn.agentsAtStart),
			edits: state.turn.edited,
			errors: state.turn.errors,
			costDelta: state.usage.costUsd - state.turn.costAtStart >= 0.005 ? state.usage.costUsd - state.turn.costAtStart : null,
			reason,
		},
	};
}

export function markCompaction(state: FlightdeckState): FlightdeckState {
	return { ...state, usage: { ...state.usage, compactions: state.usage.compactions + 1 } };
}

export function currentArchitectCount(state: FlightdeckState): number {
	return state.architect.consults.length;
}

export function isArchitectActive(state: FlightdeckState): boolean {
	return state.architect.consults.some((consult) => consult.endedAt === null);
}

export function kTokens(value: number): string {
	return formatTokens(value);
}

export function plural(value: number, word: string): string {
	return `${value} ${word}${value === 1 ? "" : "s"}`;
}
