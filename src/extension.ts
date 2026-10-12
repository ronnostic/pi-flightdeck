import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	addAgentToolNote,
	appendLog,
	currentArchitectCount,
	createState,
	endAgentRun,
	finishTool,
	formatClock,
	formatDuration,
	formatTimer,
	formatTokens,
	formatUsd,
	gauge,
	gateSummary,
	isArchitectActive,
	kTokens,
	markCompaction,
	markToolCall,
	prettyModel,
	recordAssistantUsage,
	recordToolStart,
	resetLiveState,
	setContextUsage,
	shorten,
	startAgentRun,
	startTurn,
	updateSubagentResult,
} from "./core.ts";
import type { AgentCard, FlightdeckState, Layout, ToolBucket } from "./core.ts";

const WIDGET_KEY = "pi-flightdeck";

type DashboardMode = "widget" | "overlay";
type DashboardAction = "close" | "reset";
type ToolDetails = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDetails(value: unknown): ToolDetails | undefined {
	if (!isRecord(value) || !isRecord(value.details)) return undefined;
	return value.details;
}

function getAssistantText(value: unknown): string {
	if (!isRecord(value)) return "";
	if (typeof value.output === "string") return value.output;
	if (typeof value.answer === "string") return value.answer;
	if (!Array.isArray(value.messages)) return "";
	for (let index = value.messages.length - 1; index >= 0; index -= 1) {
		const message = value.messages[index];
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content.find((part) => isRecord(part) && part.type === "text");
		if (isRecord(text) && typeof text.text === "string") return text.text;
	}
	return "";
}

function modelId(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "";
}

function statusGlyph(agent: AgentCard): string {
	return agent.status === "running" ? "◐" : agent.status === "done" ? "✓" : agent.status === "failed" ? "✗" : "■";
}

function statusColor(agent: AgentCard): "accent" | "success" | "error" | "muted" {
	return agent.status === "running" ? "accent" : agent.status === "done" ? "success" : agent.status === "failed" ? "error" : "muted";
}

function gateGlyph(status: "pending" | "success" | "failed"): string {
	return status === "pending" ? "●" : status === "success" ? "■" : "✗";
}

function gateColor(status: "pending" | "success" | "failed"): "warning" | "success" | "error" {
	return status === "pending" ? "warning" : status === "success" ? "success" : "error";
}

class DashboardComponent implements Component {
	private readonly getState: () => FlightdeckState;
	private readonly theme: Theme;
	private readonly mode: DashboardMode;
	private readonly onAction: (action: DashboardAction) => void;
	private readonly requestRender: () => void;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		getState: () => FlightdeckState,
		theme: Theme,
		mode: DashboardMode,
		requestRender: () => void,
		subscribe: (listener: () => void) => () => void,
		onAction: (action: DashboardAction) => void,
	) {
		this.getState = getState;
		this.theme = theme;
		this.mode = mode;
		this.requestRender = requestRender;
		this.onAction = onAction;
		this.unsubscribe = subscribe(() => {
			this.invalidate();
			this.requestRender();
		});
		this.timer = setInterval(() => this.requestRender(), 1000);
	}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode !== "overlay") return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction("close");
			return;
		}
		if (data === "r") {
			this.onAction("reset");
			return;
		}
		if (/^[1-6]$/.test(data)) {
			const index = Number(data) - 1;
			const agent = this.getState().agents.slice(-6)[index];
			if (agent) {
				const state = this.getState();
				Object.assign(state, { selectedAgentId: state.selectedAgentId === agent.id ? null : agent.id });
				this.requestRender();
			}
			return;
		}
		if (data === "f" || data === "s" || data === "o") {
			const bucket: ToolBucket = data === "f" ? "file" : data === "s" ? "shell" : "other";
			const state = this.getState();
			Object.assign(state, { gateFilter: state.gateFilter === bucket ? null : bucket });
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const state = this.getState();
		const lines = this.mode === "widget" ? this.renderWidget(state, width) : this.renderOverlay(state, width);
		return lines.map((line) => truncateToWidth(line, width, "…", true));
	}

	private renderWidget(state: FlightdeckState, width: number): string[] {
		return state.layout === "mini" ? this.renderMini(state, width) : this.renderCompact(state, width, false);
	}

	private renderMini(state: FlightdeckState, width: number): string[] {
		const th = this.theme;
		const model = prettyModel(state.main.model);
		const working = state.main.running ? th.fg("accent", "● working") : th.fg("muted", "○ idle");
		const lines = [
			th.fg("toolTitle", th.bold(`FLIGHTDECK · ${model}`)) + ` ${working}`,
			this.mainSummary(state),
		];
		const gate = gateSummary(state.gate);
		if (gate.total > 0 || state.pendingUiPrompts > 0) {
			const strip = state.gate.recent.slice(-Math.max(4, width - 36)).map((check) => th.fg(gateColor(check.status), gateGlyph(check.status))).join("");
			lines.push(`${th.fg("muted", "gate ")}${strip} ${th.fg("dim", `${gate.total} tools · ${gate.failed} failed`)}`);
		}
		if (currentArchitectCount(state) > 0) {
			lines.push(`${th.fg("accent", "architect ")}${isArchitectActive(state) ? "advising" : currentArchitectCount(state)} · ${shorten(state.architect.lastAdvice, Math.max(12, width - 20))}`);
		}
		const visibleAgents = [...state.agents.filter((agent) => agent.status === "running"), ...state.agents.filter((agent) => agent.status !== "running").reverse()].slice(0, 3);
		for (const agent of visibleAgents) lines.push(this.agentSummary(agent, width));
		if (state.agents.length > visibleAgents.length) lines.push(th.fg("dim", `+${state.agents.length - visibleAgents.length} more agents · /flightdeck for all`));
		if (!state.main.running && state.receipt) lines.push(this.receiptSummary(state));
		return lines.slice(0, 8);
	}

	private renderCompact(state: FlightdeckState, width: number, includeLog: boolean): string[] {
		const lines: string[] = [];
		lines.push(...this.box("MAIN", [this.mainSummary(state), this.usageSummary(state)], width, "accent"));
		if (state.gate.recent.length > 0) lines.push(...this.box("GATE · tool outcomes", this.gateRows(state, width), width, "success"));
		if (state.agents.length > 0) lines.push(...this.box("AGENTS", this.agentRows(state, width), width, "accent"));
		if (currentArchitectCount(state) > 0) lines.push(...this.box("ARCHITECT", this.architectRows(state, width), width, "accent"));
		if (state.receipt || state.main.running) lines.push(...this.box("RECEIPT", [this.receiptSummary(state)], width, "accent"));
		if (includeLog && state.log.length > 0) lines.push(...this.box("LOG", this.logRows(state, width), width, "muted"));
		return lines;
	}

	private renderOverlay(state: FlightdeckState, width: number): string[] {
		const header = [
			this.theme.fg("toolTitle", this.theme.bold("FLIGHTDECK")),
			this.theme.fg("dim", ` ${prettyModel(state.main.model)} · ${state.main.running ? "WORKING" : "IDLE"}`),
			this.theme.fg("dim", " · Pi session telemetry"),
		].join("");
		const lines = [header, this.theme.fg("dim", "Esc close · 1-6 expand agent · f/s/o gate filter · r reset"), ""];
		lines.push(...this.renderCompact(state, Math.max(40, width), true));
		if (state.gate.recent.length > 0) {
			lines.push(this.theme.fg("warning", "Pi exposes tool outcomes, not separate permission verdicts; gate cells are execution telemetry."));
		}
		const selected = state.agents.find((agent) => agent.id === state.selectedAgentId);
		if (selected) lines.push(...this.box(`AGENT ${selected.type}`, this.expandedAgentRows(selected, width), width, statusColor(selected)));
		return lines;
	}

	private box(title: string, rows: string[], width: number, color: "accent" | "success" | "muted" | "warning" | "error"): string[] {
		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const border = (value: string) => th.fg(color, value);
		const lines = [border(`╭${"─".repeat(inner)}╮`), border("│") + truncateToWidth(` ${th.fg(color, th.bold(title))}`, inner, "…", true) + border("│")];
		for (const row of rows) lines.push(border("│") + truncateToWidth(` ${row}`, inner, "…", true) + border("│"));
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}

	private mainSummary(state: FlightdeckState): string {
		const th = this.theme;
		const parts = [
			th.fg("muted", "ctx "),
			state.usage.percent === null ? th.fg("dim", "—") : this.contextGauge(state),
			state.main.thinking ? th.fg("dim", ` · ${state.main.thinking}`) : "",
			th.fg("dim", ` · ${state.main.requestCount} req`),
			state.usage.costUsd > 0 ? th.fg("text", ` · ${formatUsd(state.usage.costUsd)}`) : "",
		];
		return parts.join("");
	}

	private contextGauge(state: FlightdeckState): string {
		const th = this.theme;
		const value = state.usage.percent ?? 0;
		const bars = gauge(value, 8);
		return `${th.fg(value >= 80 ? "error" : "accent", bars?.on ?? "")}${th.fg("muted", bars?.off ?? "")} ${Math.round(value)}%${state.usage.tokens !== null ? ` ${kTokens(state.usage.tokens)}/${kTokens(state.usage.contextWindow)}` : ""}`;
	}

	private usageSummary(state: FlightdeckState): string {
		return `${this.theme.fg("dim", "tokens ")}${formatTokens(state.usage.input)} in · ${formatTokens(state.usage.output)} out · ${formatTokens(state.usage.cacheRead)} cache-read${state.usage.compactions ? ` · ⟲${state.usage.compactions}` : ""}`;
	}

	private agentSummary(agent: AgentCard, width: number): string {
		const th = this.theme;
		const elapsed = formatTimer((agent.endedAt ?? Date.now()) - agent.spawnedAt);
		const usage = agent.steps > 0 ? `ctx ${kTokens(agent.contextTokens)} · out ${kTokens(agent.outputTokens)}` : "starting…";
		return `${th.fg(statusColor(agent), statusGlyph(agent))} ${shorten(agent.task || agent.type, Math.max(12, width - usage.length - 10))} ${th.fg("dim", `${usage} · ${elapsed}`)}`;
	}

	private agentRows(state: FlightdeckState, width: number): string[] {
		return state.agents.slice(-6).map((agent, index) => `${this.theme.fg(statusColor(agent), `${index + 1} ${statusGlyph(agent)}`)} ${shorten(agent.task || agent.type, Math.max(12, width - 35))} ${this.theme.fg("dim", `${agent.type} · ${agent.model ? prettyModel(agent.model) : "starting"} · ${formatTimer((agent.endedAt ?? Date.now()) - agent.spawnedAt)}`)}`);
	}

	private expandedAgentRows(agent: AgentCard, width: number): string[] {
		const rows = [
			`${this.theme.fg(statusColor(agent), `${statusGlyph(agent)} ${agent.status}`)} · ${agent.type} · ${agent.model ? prettyModel(agent.model) : "starting"}`,
			shorten(agent.task, Math.max(20, width - 4)),
			`ctx ${kTokens(agent.contextTokens)} · out ${kTokens(agent.outputTokens)} · ${agent.steps} steps · ${formatTimer((agent.endedAt ?? Date.now()) - agent.spawnedAt)}`,
		];
		rows.push(...(agent.tools.length ? agent.tools.map((tool) => `${this.theme.fg(tool.isError ? "error" : "text", tool.isError ? "✗" : "·")} ${tool.text}`) : [this.theme.fg("muted", "no nested tool calls recorded")]));
		if (agent.answer) rows.push(`» ${shorten(agent.answer, Math.max(20, width - 4))}`);
		return rows;
	}

	private gateRows(state: FlightdeckState, width: number): string[] {
		const summary = gateSummary(state.gate);
		const filter = state.gateFilter;
		const recent = state.gate.recent.filter((check) => !filter || check.bucket === filter).slice(-5);
		const rows = [
			`${this.theme.fg("success", "■")} ${summary.success} done · ${this.theme.fg("warning", "●")} ${summary.pending} pending · ${this.theme.fg("error", "✗")} ${summary.failed} failed`,
			...recent.map((check) => `${this.theme.fg(gateColor(check.status), gateGlyph(check.status))} ${check.status.padEnd(7)} ${this.theme.fg("dim", check.detail)}${check.inSubagent ? this.theme.fg("muted", " · nested") : ""}`),
		];
		if (state.pendingUiPrompts > 0) rows.push(this.theme.fg("warning", `${state.pendingUiPrompts} UI prompt pending`));
		if (!recent.length) rows.push(this.theme.fg("muted", `no ${filter ?? "recent"} checks`));
		return rows.map((row) => truncateToWidth(row, Math.max(1, width - 4), "…", true));
	}

	private architectRows(state: FlightdeckState, width: number): string[] {
		const last = state.architect.consults[state.architect.consults.length - 1];
		return [
			`${isArchitectActive(state) ? this.theme.fg("accent", "● advising") : this.theme.fg("muted", "○ on call")} · ${currentArchitectCount(state)} consults`,
			last ? `last ${formatDuration(Date.now() - (last.endedAt ?? last.startedAt))} ago · ${last.type}` : "not consulted yet",
			state.architect.lastAdvice ? `» ${shorten(state.architect.lastAdvice, Math.max(20, width - 4))}` : "",
		].filter(Boolean);
	}

	private receiptSummary(state: FlightdeckState): string {
		if (state.main.running) return `${this.theme.fg("accent", "◐ running")} · ${formatTimer(Date.now() - state.turn.startedAt)} · ${state.turn.edited} edits · ${state.turn.errors} errors`;
		if (!state.receipt) return this.theme.fg("muted", "no turn finished yet");
		const receipt = state.receipt;
		return `${receipt.reason === "stop" ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓")} last turn ${formatDuration(receipt.durationMs)} · ${receipt.agents} agents · ${receipt.edits} edits · ${receipt.errors} errors${receipt.costDelta !== null ? ` · +${formatUsd(receipt.costDelta)}` : ""}`;
	}

	private logRows(state: FlightdeckState, width: number): string[] {
		return state.log.slice(-Math.max(4, Math.min(8, Math.floor(width / 12)))).map((line) => `${this.theme.fg("dim", formatClock(line.at))} ${this.theme.fg(line.kind === "error" ? "error" : line.kind === "consult" ? "accent" : "text", line.who)} ${shorten(line.text, Math.max(12, width - 18))}`);
	}
}

export default function piFlightdeck(pi: ExtensionAPI): void {
	let state = createState();
	let widgetVisible = true;
	let widgetInstalled = false;
	let overlayDone: (() => void) | null = null;
	const listeners = new Set<() => void>();

	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	const notify = () => {
		for (const listener of listeners) listener();
	};

	const statusText = () => {
		const parts = [
			state.usage.percent === null ? null : `ctx ${Math.round(state.usage.percent)}%`,
			state.agents.length ? `agents ${state.agents.filter((agent) => agent.status === "running").length}/${state.agents.length}` : null,
			currentArchitectCount(state) ? `architect ${isArchitectActive(state) ? "advising" : currentArchitectCount(state)}` : null,
			gateSummary(state.gate).failed ? `failed ${gateSummary(state.gate).failed}` : null,
		];
		return parts.filter(Boolean).join(" · ");
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(WIDGET_KEY, statusText() || undefined);
	};

	const commit = (ctx: ExtensionContext, next: FlightdeckState) => {
		state = setContextUsage(next, ctx.getContextUsage());
		refreshStatus(ctx);
		notify();
	};

	const log = (ctx: ExtensionContext, who: string, text: string, kind: "info" | "error" | "consult" | "done" = "info", agentId: string | null = null) => {
		commit(ctx, appendLog(state, { at: Date.now(), who, text, kind, agentId }));
	};

	const installWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui" || widgetInstalled || !widgetVisible) return;
		widgetInstalled = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => new DashboardComponent(() => state, theme, "widget", () => tui.requestRender(), subscribe, () => undefined),
			{ placement: "aboveEditor" },
		);
	};

	const removeWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		widgetVisible = false;
		widgetInstalled = false;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(WIDGET_KEY, undefined);
	};

	const openOverlay = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/flightdeck requires TUI mode", "error");
			return;
		}
		widgetVisible = true;
		installWidget(ctx);
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				overlayDone = done;
				return new DashboardComponent(() => state, theme, "overlay", () => tui.requestRender(), subscribe, (action) => {
					if (action === "reset") {
						commit(ctx, resetLiveState(state));
						ctx.ui.notify("Flightdeck reset", "info");
					} else {
						done();
					}
				});
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "92%", minWidth: 56, maxHeight: "90%" },
			},
		);
		overlayDone = null;
	};

	const restoreSessionTelemetry = (ctx: ExtensionContext) => {
		let next = createState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") next = markCompaction(next);
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message as AssistantMessage;
			next = recordAssistantUsage(next, message.usage, undefined);
		}
		state = next;
	};

	pi.registerCommand("flightdeck", {
		description: "Open or control the live Flightdeck dashboard",
		getArgumentCompletions: (prefix) => {
			const values = ["open", "close", "reset", "layout mini", "layout compact", "layout wide"];
			return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0] ?? "open";
			if (verb === "close") {
				if (overlayDone) overlayDone();
				removeWidget(ctx);
				return;
			}
			if (verb === "reset") {
				commit(ctx, resetLiveState(state));
				ctx.ui.notify("Flightdeck reset", "info");
				return;
			}
			if (verb === "layout") {
				const layout = parts[1];
				if (layout !== "mini" && layout !== "compact" && layout !== "wide") {
					ctx.ui.notify("Usage: /flightdeck layout mini|compact|wide", "error");
					return;
				}
				widgetVisible = true;
				commit(ctx, { ...state, layout: layout as Layout });
				installWidget(ctx);
				return;
			}
			await openOverlay(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreSessionTelemetry(ctx);
		state = {
			...state,
			main: { ...state.main, model: modelId(ctx.model), thinking: ctx.thinkingLevel ?? pi.getThinkingLevel() },
		};
		commit(ctx, state);
		installWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(WIDGET_KEY, undefined);
		}
		widgetInstalled = false;
		if (overlayDone) overlayDone();
	});

	pi.on("session_tree", async (_event, ctx) => {
		commit(ctx, resetLiveState(state));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		commit(ctx, appendLog(state, { at: Date.now(), who: "you", text: shorten(event.prompt, 70), kind: "info" }));
	});

	pi.on("agent_start", async (_event, ctx) => {
		commit(ctx, startAgentRun(state, Date.now()));
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
		const reason = last?.stopReason === "aborted" ? "stop" : last?.stopReason === "error" ? "error" : "answer";
		commit(ctx, endAgentRun(state, Date.now(), reason));
	});

	pi.on("turn_start", async (_event, ctx) => {
		commit(ctx, startTurn(state, Date.now()));
	});

	pi.on("turn_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			commit(ctx, { ...state, main: { ...state.main, model: `${message.provider}/${message.model}` } });
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as AssistantMessage;
		let next = recordAssistantUsage(state, message.usage, ctx.getContextUsage());
		next = { ...next, main: { ...next.main, model: `${message.provider}/${message.model}` } };
		if (message.stopReason === "error") {
			next = { ...next, turn: { ...next.turn, errors: next.turn.errors + 1, errorStreak: next.turn.errorStreak + 1 } };
		}
		commit(ctx, next);
	});

	pi.on("model_select", async (event, ctx) => {
		commit(ctx, { ...state, main: { ...state.main, model: `${event.model.provider}/${event.model.id}` } });
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		commit(ctx, { ...state, main: { ...state.main, thinking: event.level } });
	});

	pi.on("session_compact", async (_event, ctx) => {
		commit(ctx, markCompaction(state));
		log(ctx, "main", `context compacted`, "info");
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		commit(ctx, { ...state, pendingUiPrompts: state.pendingUiPrompts + 1 });
		if (event.title?.toLowerCase().includes("permission")) log(ctx, "gate", "permission UI opened", "info");
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		commit(ctx, { ...state, pendingUiPrompts: Math.max(0, state.pendingUiPrompts - 1) });
	});

	pi.on("tool_call", async (event, ctx) => {
		commit(ctx, recordToolStart(state, event.toolCallId, event.toolName, event.input, Boolean(event.parentToolCallId), Date.now()));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		let next = recordToolStart(state, event.toolCallId, event.toolName, event.args, Boolean(event.parentToolCallId), Date.now());
		if (event.parentToolCallId) next = addAgentToolNote(next, event.parentToolCallId, event.toolName, event.args, false);
		commit(ctx, next);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		let next = updateSubagentResult(state, event.toolCallId, getDetails(event.partialResult), Date.now());
		const details = getDetails(event.partialResult);
		if (isRecord(details) && Array.isArray(details.results)) {
			const advice = details.results.map((result) => getAssistantText(result)).find(Boolean);
			if (advice) next = { ...next, architect: { ...next.architect, lastAdvice: shorten(advice.split("\n").find((line) => line.trim()) ?? advice, 160) } };
		}
		commit(ctx, next);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const failed = event.isError || (isRecord(event.result) && event.result.isError === true);
		let next = state;
		if (event.toolName === "subagent") next = updateSubagentResult(next, event.toolCallId, getDetails(event.result), Date.now());
		next = finishTool(next, event.toolCallId, failed, Date.now());
		next = markToolCall(next, event.toolName, failed, Boolean(event.parentToolCallId));
		commit(ctx, next);
		const detail = next.gate.recent.find((check) => check.id === event.toolCallId)?.detail ?? event.toolName;
		if (failed) log(ctx, event.parentToolCallId ? "agent" : event.toolName, `${detail} · failed`, "error", event.parentToolCallId ?? null);
		else if (event.toolName === "edit" || event.toolName === "write") log(ctx, event.parentToolCallId ? "agent" : "main", detail, "info", event.parentToolCallId ?? null);
	});

	pi.on("tool_result", async (event, ctx) => {
		let next = state;
		if (event.toolName === "subagent") next = updateSubagentResult(next, event.toolCallId, event.details, Date.now());
		next = finishTool(next, event.toolCallId, event.isError, Date.now());
		commit(ctx, next);
	});
}
