import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatFallowProjectStateText } from "../project/text";
import { formatFallowPrSummaryText } from "../pr-summary/text";
import { commandDisplay, fallowExitLabel } from "../tool-render";
import type { FallowNavigatorResult, FallowNavigatorState, FallowPrSummary, FallowProjectState } from "../types";
import { FallowIssueNavigator } from "../ui";
import { fallowProjectIssues } from "./issues";
import { buildFallowExecutor, buildFallowFinalArgs, runFallowWithLoaderIfUi, type FallowCommandExecutor, type FallowCommandResult } from "./loader";
import { hasFallowNavigator, isFallowTuiMode } from "./mode";
import { FALLOW_NAVIGATOR_OVERLAY_OPTIONS, resolveFallowNavigatorMode, resolveFallowNavigatorVisibleRows } from "./navigator";
import { buildFallowTranscriptContent } from "./transcript";
import type { FallowCommandContext } from "./types";

export type FallowCommandCompleted = (result: FallowCommandResult, commandArgs: string[]) => void | Promise<void>;

export async function executeFallowResult(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	rawCommandArgs: string[],
	rememberLast: boolean,
	setLastFallowArgs: (args: string[] | null) => void,
	initialNavigatorState?: FallowNavigatorState,
	onCompleted?: FallowCommandCompleted,
): Promise<FallowNavigatorResult | null | undefined> {
	if (rawCommandArgs[0] === "issues") {
		return executeFallowProjectIssuesResult(
			pi, ctx, rawCommandArgs, rememberLast, setLastFallowArgs, initialNavigatorState, onCompleted,
		);
	}
	const finalArgs = buildFallowFinalArgs(rawCommandArgs);
	if (rememberLast) setLastFallowArgs([...finalArgs]);
	return runFallowResultFlow(
		pi, ctx, finalArgs, buildFallowExecutor(pi, ctx, finalArgs), initialNavigatorState, onCompleted,
	);
}

function executeFallowProjectIssuesResult(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandArgs: string[],
	rememberLast: boolean,
	setLastFallowArgs: (args: string[] | null) => void,
	initialNavigatorState?: FallowNavigatorState,
	onCompleted?: FallowCommandCompleted,
): Promise<FallowNavigatorResult | null | undefined> {
	if (rememberLast) setLastFallowArgs([...commandArgs]);
	return runFallowResultFlow(
		pi,
		ctx,
		commandArgs,
		fallowProjectIssues.buildExecutor(pi, ctx, commandArgs),
		initialNavigatorState,
		onCompleted,
	);
}

async function runFallowResultFlow(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	finalArgs: string[],
	executeCommand: FallowCommandExecutor,
	initialNavigatorState?: FallowNavigatorState,
	onCompleted?: FallowCommandCompleted,
): Promise<FallowNavigatorResult | null | undefined> {
	const commandResult = await runFallowWithLoaderIfUi(ctx, executeCommand, finalArgs);
	if (!commandResult) return handleMissingFallowResult(ctx);

	const { binary, args: executedArgs, execution, projectState, prSummary } = commandResult;
	const resultPrefix = buildFallowResultPrefix(projectState, prSummary);
	notifyFallowCompletion(ctx, execution, binary, executedArgs);
	renderFallowResultMessage(pi, ctx, commandResult, resultPrefix);
	await onCompleted?.(commandResult, finalArgs);
	return openFallowNavigator(
		ctx,
		commandResult,
		binary,
		executedArgs,
		finalArgs,
		projectState,
		prSummary,
		initialNavigatorState,
	);
}

function handleMissingFallowResult(ctx: FallowCommandContext): null {
	if (ctx.hasUI) ctx.ui.notify("fallow cancelled", "info");
	return null;
}

function buildFallowResultPrefix(projectState: FallowProjectState | undefined, prSummary: FallowPrSummary | undefined): string {
	const projectStateText = formatFallowProjectStateText(projectState);
	const prSummaryText = formatFallowPrSummaryText(prSummary);
	return [prSummaryText, projectStateText].filter(Boolean).join("\n");
}

function notifyFallowCompletion(ctx: FallowCommandContext, execution: FallowCommandResult["execution"], binary: string, args: string[]): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(buildFallowCompletionMessage(execution, binary, args), shouldNotifyAsError(execution) ? "error" : "info");
}

function buildFallowCompletionMessage(
	execution: FallowCommandResult["execution"],
	binary: string,
	args: string[],
): string {
	const display = commandDisplay(binary, args);
	if (execution.terminationReason === "timed-out") return `fallow timed out: ${display}`;
	if (execution.terminationReason === "cancelled") return `fallow cancelled: ${display}`;
	if (execution.code === 1) return `fallow found issues: ${display}`;
	return `fallow ${fallowExitLabel(execution.code, execution.killed)}: ${display}`;
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
	const hasNavigator = hasFallowNavigator(ctx.mode, formatted.overview);
	pi.sendMessage({
		customType: "fallow-result",
		content: buildFallowTranscriptContent(resultPrefix, formatted.summary, content, hasNavigator),
		display: true,
		details: {
			...commandDetails,
			compact: hasNavigator,
		},
	});
}

function openFallowNavigator(
	ctx: FallowCommandContext,
	result: FallowCommandResult,
	binary: string,
	executedArgs: string[],
	originCommandArgs: string[],
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
	initialState?: FallowNavigatorState,
): Promise<FallowNavigatorResult | null> {
	return openFallowOverviewNavigator(ctx, result.formatted.overview, {
		command: commandDisplay(binary, executedArgs),
		commandArgs: originCommandArgs,
		initialState,
		fullOutputPath: result.formatted.fullOutputPath,
		truncated: result.formatted.truncated,
		projectState,
		prSummary,
	});
}

interface FallowOverviewNavigatorOptions {
	command: string;
	commandArgs: string[];
	initialState?: FallowNavigatorState;
	fullOutputPath?: string;
	truncated?: boolean;
	projectState?: FallowProjectState;
	prSummary?: FallowPrSummary;
}

export function openFallowOverviewNavigator(
	ctx: FallowCommandContext,
	overview: FallowCommandResult["formatted"]["overview"],
	options: FallowOverviewNavigatorOptions,
): Promise<FallowNavigatorResult | null> {
	if (!isFallowTuiMode(ctx.mode) || !overview) return Promise.resolve(null);
	const navigatorMode = resolveFallowNavigatorMode(overview);
	if (navigatorMode === "none") return Promise.resolve(null);
	const informationalMode = navigatorMode === "informational";
	return ctx.ui.custom<FallowNavigatorResult | null>((tui, theme, _keybindings, done) => (
		new FallowIssueNavigator(overview, theme, done, () => tui.requestRender(), {
			...options,
			commandArgs: [...options.commandArgs],
			visibleRows: resolveFallowNavigatorVisibleRows(tui.terminal.rows, informationalMode),
			informationalMode,
		})
	), {
		overlay: true,
		overlayOptions: FALLOW_NAVIGATOR_OVERLAY_OPTIONS,
	});
}
