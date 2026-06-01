import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fallowCompletions } from "./fallow/autocomplete";
import { fallowCli } from "./fallow/cli";
import { fallowEngine } from "./fallow/engine";
import { detectFallowGitState, formatFallowProjectState, formatFallowStatus } from "./fallow/project";
import { formatFallowPrSummary } from "./fallow/pr-summary";
import { formatSummaryLines, renderSummaryLines } from "./fallow/summary";
import { fallowRunParams } from "./fallow/schema";
import type { FallowDetails, FallowOverview, FallowPrSummary, FallowProjectState } from "./fallow/types";
import { fallowPurple, FallowIssueNavigator, FallowOverviewComponent, type FallowNavigatorResult } from "./fallow/ui";

async function setFallowReadyStatus(ctx: { cwd: string; ui: { setStatus(key: string, text: string): void } }) {
	try {
		ctx.ui.setStatus("fallow", formatFallowStatus(await detectFallowGitState(ctx.cwd)));
	} catch {
		ctx.ui.setStatus("fallow", "fallow ready");
	}
}

function hasFlag(args: string[], flag: string): boolean {
	for (const arg of args) {
		if (arg === flag || arg.startsWith(`${flag}=`)) return true;
	}
	return false;
}

function withBaseAndGateFallback(args: string[], baseRef: string): string[] {
	const normalized = [...args];
	if (!hasFlag(normalized, "--base")) normalized.push("--base", baseRef);
	if (!hasFlag(normalized, "--gate")) normalized.push("--gate", "new-only");
	return normalized;
}

function commandDisplay(binary: string, args: string[]): string {
	return [binary, ...args].map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
}

function fallowExitLabel(code: number, killed = false): string {
	if (killed) return "killed";
	if (code === 0) return "ok";
	if (code === 1) return "findings";
	return "error";
}

function parseTraceCloneArgs(args: string[]): string[] {
	const { fileOrPath, line } = getTraceCloneInput(args);
	if (line) return buildTraceCloneFromLine(fileOrPath, line, args);
	const parsed = parseTraceCloneFromPath(fileOrPath);
	return buildTraceCloneFromParsed(parsed, args);
}

function getTraceCloneInput(args: string[]): { fileOrPath: string; line?: string } {
	if (!args[1]) throw new Error("trace-clone requires file and line.");
	return { fileOrPath: args[1], line: args[2] };
}

function parseTraceCloneFromPath(fileOrPath: string): RegExpMatchArray {
	const match = /^(.*):(\d+)$/.exec(fileOrPath);
	if (!match) throw new Error("trace-clone requires file and line.");
	return match;
}

function buildTraceCloneFromLine(fileOrPath: string, line: string, args: string[]): string[] {
	if (!/^\d+$/.test(line)) throw new Error("trace-clone requires file and numeric line.");
	return ["dupes", "--trace", `${fileOrPath}:${line}`, ...args.slice(3)];
}

function buildTraceCloneFromParsed(match: RegExpMatchArray, args: string[]): string[] {
	return ["dupes", "--trace", `${match[1]}:${match[2]}`, ...args.slice(2)];
}

const traceCommandMap: Record<string, (args: string[]) => string[]> = {
	"trace-file": (args) => {
		if (!args[1]) throw new Error("trace-file requires file.");
		return ["dead-code", "--trace-file", ...args.slice(1)];
	},
	"trace-export": (args) => {
		if (!args[1] || !args[2]) throw new Error("trace-export requires file and exportName.");
		return ["dead-code", "--trace", `${args[1]}:${args[2]}`, ...args.slice(3)];
	},
	"trace-dependency": (args) => {
		if (!args[1]) throw new Error("trace-dependency requires packageName.");
		return ["dead-code", "--trace-dependency", ...args.slice(1)];
	},
	"trace-clone": (args) => parseTraceCloneArgs(args),
};

function normalizeFallowArgs(
	rawArgs: string[],
	baseRef: string,
	lastFallowArgs: string[] | null,
	notify: (message: string, level: "info" | "warning") => void,
): string[] | null {
	const firstArg = rawArgs[0];
	if (firstArg === "rerun") return buildRerunFallowArgs(rawArgs, lastFallowArgs, notify);
	if (firstArg === "pr") return buildPrFallowArgs(rawArgs.slice(1), baseRef);
	return resolveFallbackArgs(rawArgs);
}

function resolveFallbackArgs(rawArgs: string[]): string[] {
	const normalized = [...rawArgs];
	const command = normalized[0] ?? "";
	const translator = traceCommandMap[command];
	return translator ? translator(normalized) : normalized;
}

function buildRerunFallowArgs(
	rawArgs: string[],
	lastFallowArgs: string[] | null,
	notify: (message: string, level: "info" | "warning") => void,
): string[] | null {
	if (!lastFallowArgs) {
		notify("No previous /fallow command to rerun.", "warning");
		return null;
	}
	if (rawArgs.length > 1) notify("/fallow rerun uses the last command and ignores extra arguments.", "info");
	return [...lastFallowArgs];
}

function buildPrFallowArgs(prArgs: string[], baseRef: string): string[] {
	const skipDefaults = prArgs.some((arg) => arg === "--help" || arg === "-h");
	const fallbackArgs = skipDefaults ? prArgs : withBaseAndGateFallback(prArgs, baseRef);
	return ["audit", ...fallbackArgs];
}

type FallowCommandContext = {
	cwd: string;
	hasUI: boolean;
	signal?: AbortSignal | undefined;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string): void;
		custom<T>(_: any, __: any, ___: any, done: (value: T) => void): any;
		setEditorText(text: string): void;
	};
};

type FallowCommandResult = Awaited<ReturnType<typeof fallowEngine.runFallowWithExecutor>>;
type NullableFallowCommandResult = FallowCommandResult | null;
type FallowCommandExecutor = (signal?: AbortSignal) => Promise<NullableFallowCommandResult>;

function buildFallowFinalArgs(rawCommandArgs: string[]): string[] {
	const hasFormat = rawCommandArgs.some((arg) => arg === "--format" || arg === "-f" || arg.startsWith("--format="));
	return hasFormat ? [...rawCommandArgs] : [...rawCommandArgs, "--format", "json", "--quiet"];
}

function buildFallowExecutor(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	args: string[],
): FallowCommandExecutor {
	const timeoutSecs = Number(process.env.FALLOW_TIMEOUT_SECS || 120);
	return (signal?: AbortSignal) => fallowEngine.runFallowWithExecutor({
		pi,
		cwd: ctx.cwd,
		args,
		signal: signal ?? ctx.signal,
		timeoutSecs,
		executor: fallowCli.execFallow,
		throwOnExecutionError: false,
	});
}

function runFallowWithLoader(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	args: string[],
): Promise<NullableFallowCommandResult> {
	ctx.ui.setStatus("fallow", "fallow running…");
	return ctx.ui.custom<NullableFallowCommandResult>((_tui, theme, _keybindings, done) => {
		const displayArgs = args.length ? args.join(" ") : "all";
		const loaderTheme = Object.create(theme) as typeof theme;
		const originalFg = theme.fg.bind(theme);
		loaderTheme.fg = ((color: Parameters<typeof theme.fg>[0], text: string) => color === "border" ? fallowPurple(text) : originalFg(color, text)) as typeof theme.fg;
		const loader = new BorderedLoader(_tui, loaderTheme, `Running fallow ${displayArgs}...`);
		let settled = false;
		const finish = (value: NullableFallowCommandResult) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => finish(null);
		executeCommand(loader.signal).then(finish, (error) => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			finish(null);
		});
		return loader;
	});
}

function buildFallowResultPrefix(projectState: FallowProjectState | undefined, prSummary: FallowPrSummary | undefined): string {
	const projectStateText = formatSummaryLines(formatFallowProjectState(projectState));
	const prSummaryText = formatSummaryLines(formatFallowPrSummary(prSummary));
	return [prSummaryText, projectStateText].filter(Boolean).join("\n");
}

function notifyFallowCompletion(ctx: FallowCommandContext, result: FallowCommandResult["result"], binary: string, args: string[]): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(buildFallowCompletionMessage(result.code, result.killed, binary, args), shouldNotifyAsError(result) ? "error" : "info");
}

function buildFallowCompletionMessage(code: number, killed: boolean, binary: string, args: string[]): string {
	const display = commandDisplay(binary, args);
	if (code === 1) return `fallow found issues: ${display}`;
	return `fallow ${fallowExitLabel(code, killed)}: ${display}`;
}

function shouldNotifyAsError(result: { code: number; killed: boolean }): boolean {
	return result.code >= 2 || result.killed;
}

function renderFallowResultMessage(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	result: FallowCommandResult,
	resultPrefix: string,
): void {
	const { details: commandDetails, formatted, content } = result;
	const hasNavigator = formatted.overview?.sections.some((section) => section.items.length > 0);
	pi.sendMessage({
		customType: "fallow-result",
		content: hasNavigator ? `Opened Fallow issue navigator.\n${resultPrefix ? `${resultPrefix}\n` : ""}${formatted.summary}` : content,
		display: true,
		details: {
			...commandDetails,
			compact: !!(ctx.hasUI && hasNavigator),
		},
	});
}

function openFallowNavigator(
	ctx: FallowCommandContext,
	result: FallowCommandResult,
	binary: string,
	executedArgs: string[],
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
): Promise<FallowNavigatorResult | null> {
	const { formatted } = result;
	if (!ctx.hasUI || !formatted.overview) return Promise.resolve(null);
	return ctx.ui.custom<FallowNavigatorResult | null>((tui, theme, _keybindings, done) => {
		return new FallowIssueNavigator(
			formatted.overview!,
			theme,
			done,
			() => tui.requestRender(),
			{
				command: commandDisplay(binary, executedArgs),
				fullOutputPath: formatted.fullOutputPath,
				truncated: formatted.truncated,
				projectState,
				prSummary,
			},
		);
	}, {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
	});
}

async function executeFallowResult(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	rawCommandArgs: string[],
	rememberLast: boolean,
	setLastFallowArgs: (args: string[] | null) => void,
): Promise<FallowNavigatorResult | null | undefined> {
	const finalArgs = buildFallowFinalArgs(rawCommandArgs);
	if (rememberLast) setLastFallowArgs([...finalArgs]);
	return runFallowResultFlow(pi, ctx, finalArgs, buildFallowExecutor(pi, ctx, finalArgs));
}

async function runFallowResultFlow(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	finalArgs: string[],
	executeCommand: FallowCommandExecutor,
): Promise<FallowNavigatorResult | null | undefined> {
	const commandResult = await runFallowWithLoaderIfUi(ctx, executeCommand, finalArgs);
	if (!commandResult) {
		if (ctx.hasUI) ctx.ui.notify("fallow cancelled", "info");
		return null;
	}
	const { binary, args: executedArgs, result, formatted, projectState, prSummary } = commandResult;
	const resultPrefix = buildFallowResultPrefix(projectState, prSummary);
	notifyFallowCompletion(ctx, result, binary, executedArgs);
	renderFallowResultMessage(pi, ctx, commandResult, resultPrefix);
	return openFallowNavigator(ctx, commandResult, binary, executedArgs, projectState, prSummary);
}

async function runFallowWithLoaderIfUi(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	finalArgs: string[],
): Promise<NullableFallowCommandResult> {
	if (!ctx.hasUI) return executeCommand();
	return runFallowWithLoader(ctx, executeCommand, finalArgs).finally(() => void setFallowReadyStatus(ctx));
}

async function normalizeFallowHandlerArgs(
	ctx: FallowCommandContext,
	commandState: { lastArgs: string[] | null },
	rawArgs: string,
): Promise<string[] | null> {
	const parsedArgs = rawArgs.trim() ? fallowCli.splitArgs(rawArgs) : [];
	const baseRef = (await detectFallowGitState(ctx.cwd)).baseRef ?? "main";
	return normalizeFallowArgs(parsedArgs, baseRef, commandState.lastArgs, (message, level) => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	});
}

async function executeFallowCommandLoop(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: { lastArgs: string[] | null },
	initialArgs: string[],
): Promise<FallowNavigatorResult | null | undefined> {
	let result = await executeFallowResult(pi, ctx, initialArgs, true, (updated) => {
		commandState.lastArgs = updated;
	});
	while (ctx.hasUI && result?.type === "trace") {
		result = await executeFallowResult(pi, ctx, result.commandArgs, false, (updated) => {
			commandState.lastArgs = updated;
		});
	}
	return result;
}

function formatToolCallTitle(args: { command?: string; root?: string; changedSince?: string; base?: string }, theme: any): string {
	return [
		theme.fg("toolTitle", theme.bold("fallow ")),
		theme.fg("accent", args.command ?? "run"),
		...formatToolCallRootParts(args, theme),
		...formatToolCallChangeParts(args, theme),
	].join("");
}

function formatToolCallRootParts(args: { root?: string }, theme: any): string[] {
	if (!args.root) return [];
	return [theme.fg("muted", ` in ${args.root}`)];
}

function formatToolCallChangeParts(args: { changedSince?: string; base?: string }, theme: any): string[] {
	const changeReference = args.changedSince ?? args.base;
	if (!changeReference) return [];
	return [theme.fg("dim", ` since ${changeReference}`)];
}

function applyFallowPrompt(ctx: FallowCommandContext, result: FallowNavigatorResult | null | undefined): void {
	if (!ctx.hasUI || result?.type !== "prompt") return;
	ctx.ui.setEditorText(result.prompt);
	ctx.ui.notify(`Loaded ${result.issueCount} Fallow finding(s) into the editor. Add comments, then submit when ready.`, "info");
}

async function runFallowCommandHandler(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: { lastArgs: string[] | null },
	rawArgs: string,
): Promise<void> {
	const args = await normalizeFallowHandlerArgs(ctx, commandState, rawArgs);
	if (!args) return;
	const result = await executeFallowCommandLoop(pi, ctx, commandState, args);
	applyFallowPrompt(ctx, result);
}

export default function (pi: ExtensionAPI) {
	const commandState: { lastArgs: string[] | null } = { lastArgs: null };
	pi.registerTool({
		name: "fallow_run",
		label: "Fallow",
		description: `Run Fallow codebase intelligence for TypeScript/JavaScript: PR/new-issue audits (audit --base ... --gate new-only), changed-file checks, dead code, duplication, health, auto-fix preview/apply, project info, file traces, feature flags, and runtime coverage. JSON output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated. Uses FALLOW_BIN if set, otherwise fallow from PATH, falling back to npx -y fallow.`,
		promptSnippet: "Run Fallow static/runtime codebase intelligence and return JSON summaries.",
		promptGuidelines: [
			"Use fallow_run after making TypeScript/JavaScript changes when the user asks for cleanup, quality, dead-code, duplication, architecture, complexity, or PR-readiness checks.",
			"Use fallow_run with command=\"audit\", base=\"main\" or \"origin/main\", and gate=\"new-only\" for PR/new-issue checks; use command=\"check-changed\" with changedSince for changed-file checks.",
			"Use command=\"all\" for full-repo context; command=\"fix-preview\" before command=\"fix-apply\" unless the user explicitly requested automatic cleanup.",
			"Use fallow_run trace commands, especially command=\"trace-file\" with file, before deleting exports, files, dependencies, or clone groups when confidence is low.",
		],
		parameters: fallowRunParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Running fallow ${params.command}...` }] });
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled." }], details: {} };
			return fallowCli.runFallow(pi, params, ctx);
		},
		renderCall(args, theme) {
			return new Text(formatToolCallTitle(args, theme), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running Fallow..."), 0, 0);
			const details = result.details as FallowDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No Fallow details"), 0, 0);
			if (details.overview) {
				return new FallowOverviewComponent(details.overview, theme, {
					expanded,
					command: commandDisplay(details.command, details.args),
					fullOutputPath: details.fullOutputPath,
					truncated: details.truncated,
					projectState: details.projectState,
					prSummary: details.prSummary,
				});
			}
			return new Text(buildFallowCompactMessage(details, expanded, theme), 0, 0);
		},
	});

	pi.registerCommand("fallow", {
		description: "Run fallow with raw CLI args. JSON/quiet are added if no --format is supplied.",
		argumentHint: "[all|pr|rerun|dead-code|dupes|health|audit|fix|project-info|list|flags|coverage analyze|explain|trace-file|trace-export|trace-dependency|trace-clone] [options]",
		getArgumentCompletions: fallowCompletions.getFallowArgumentCompletions,
		handler: (rawArgs, ctx) => runFallowCommandHandler(pi, ctx, commandState, rawArgs),
	});

	pi.registerMessageRenderer("fallow-result", (message, options, theme) =>
		renderFallowMessageRenderer(message, options, theme),
	);


	function buildFallowCompactMessage(
		details: FallowDetails,
		expanded: boolean,
		theme: any,
	): string {
		const base = formatBaseCompactMessage(details, theme);
		if (!expanded) return base;
		return [
			base,
			theme.fg("muted", commandDisplay(details.command, details.args)),
			theme.fg("dim", details.summary),
			...buildCompactMessageSummary(details, theme),
			details.fullOutputPath ? theme.fg("dim", `Full output: ${details.fullOutputPath}`) : undefined,
		].filter(Boolean).join("\n");
	}

	function formatBaseCompactMessage(details: FallowDetails, theme: any): string {
		const statusColor = details.exitCode === 0 ? "success" : "warning";
		const parts = [
			theme.fg(statusColor, `Fallow ${fallowExitLabel(details.exitCode)} (exit ${details.exitCode})`),
			details.truncated ? theme.fg("warning", " (truncated)") : undefined,
			theme.fg("dim", ` · ${details.elapsedMs}ms`),
		];
		return parts.filter(Boolean).join("");
	}

	function buildCompactMessageSummary(details: FallowDetails, theme: any): string[] {
		return [
			renderSummaryLines(formatFallowPrSummary(details.prSummary), theme),
			renderSummaryLines(formatFallowProjectState(details.projectState), theme),
		].filter(Boolean);
	}

	function renderFallowMessageRenderer(message: any, options: any, theme: any): Text {
		const details = message.details as { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } | undefined;
		const compactMessage = renderFallowCompactResultMessage(details, theme);
		if (compactMessage) return compactMessage;
		const overviewMessage = renderFallowOverviewResultMessage(details, options, theme);
		if (overviewMessage) return overviewMessage;
		return new Text(theme.fg("toolTitle", theme.bold("Fallow result")) + "\n" + message.content, 0, 0);
	}

	function renderFallowCompactResultMessage(
		details: { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } | undefined,
		theme: any,
	): Text | null {
		if (!details || !details.compact) return null;
		return new Text(buildCompactFallowMessage(details, theme), 0, 0);
	}

	function buildCompactFallowMessage(
		details: { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary },
		theme: any,
	): string {
		const title = details.overview ? details.overview.title : "Fallow result";
		const summary = buildCompactSummary(details, theme);
		const stats = buildCompactStats(details.overview);
		const lines = [
			theme.fg("toolTitle", theme.bold(title)),
			theme.fg("muted", "Detailed findings were shown in the navigator window."),
		];
		return [
			...lines.slice(0, 1),
			...includeCompactLine(stats, (line) => theme.fg("dim", line)),
			...includeCompactLine(summary, (line) => line),
			...lines.slice(1),
		].join("\n");
	}

	function includeCompactLine<T>(value: T | undefined, render: (value: T) => string): string[] {
		if (value === undefined) return [];
		return [render(value)];
	}

	function buildCompactStats(overview: FallowOverview | undefined): string {
		const stats = overview?.stats ?? [];
		if (!stats.length) return "";
		return stats.slice(0, 5).map((stat) => `${stat.label}: ${stat.value}`).join(" · ");
	}

	function buildCompactSummary(
		details: { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary },
		theme: any,
	): string {
		const prSummaryLines = renderSummaryLines(formatFallowPrSummary(details.prSummary), theme);
		const projectStateLines = renderSummaryLines(formatFallowProjectState(details.projectState), theme);
		return [prSummaryLines, projectStateLines].filter(Boolean).join("\n");
	}

	function renderFallowOverviewResultMessage(
		details: { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } | undefined,
		options: { expanded?: boolean },
		theme: any,
	): Text | null {
		if (!details || !details.overview) return null;
		const overview = details.overview;
		return new FallowOverviewComponent(overview, theme, {
			expanded: options.expanded,
			command: resolveOverviewCommand(details),
			fullOutputPath: details.fullOutputPath,
			truncated: details.truncated,
			projectState: details.projectState,
			prSummary: details.prSummary,
		});
	}

	function resolveOverviewCommand(
		details: { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } | undefined,
	): string | undefined {
		if (!details?.command || !details.args) return undefined;
		return commandDisplay(details.command, details.args);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void setFallowReadyStatus(ctx);
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const slashPrefix = getFallowSlashPrefix(lines, cursorLine, cursorCol);
				// After Pi completes `/fal` to `/fallow `, Tab uses the file-completion path.
				// Intercept that exact command-with-space context and show Fallow subcommands.
				// Requiring whitespace avoids replacing the normal `/fal` -> `/fallow` flow.
				if (isFallowCommandPrefix(slashPrefix)) {
					return { prefix: slashPrefix, items: fallowCompletions.getFallowRootCommandCompletions() };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const slashPrefix = getFallowSlashPrefix(lines, cursorLine, cursorCol);
				if (isFallowCommandPrefix(slashPrefix)) return true;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}

function getFallowSlashPrefix(lines: string[], cursorLine: number, cursorCol: number): string {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const slashIndex = beforeCursor.lastIndexOf("/");
	return slashIndex >= 0 ? beforeCursor.slice(slashIndex) : "";
}

function isFallowCommandPrefix(prefix: string): boolean {
	// After Pi completes `/fal` to `/fallow `, Tab uses the file-completion path.
	// Intercept that exact command-with-space context and show Fallow subcommands.
	// Requiring whitespace avoids replacing the normal `/fal` -> `/fallow` flow.
	return /^\/fallow\s+$/.test(prefix);
}
