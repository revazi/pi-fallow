import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { createReadinessCheck, resolveReadinessRoot } from "../readiness";
import type { ReadinessCheck } from "../readiness-report";
import type { SimilarCodeRunRequest } from "../similar-code-options";
import { formatFallowProjectStateText } from "../project/text";
import { formatFallowPrSummaryText } from "../pr-summary/text";
import { commandDisplay, fallowExitLabel } from "../tool-render";
import type { FallowNavigatorResult, FallowNavigatorState, FallowPrSummary, FallowProjectState } from "../types";
import { FallowIssueNavigator } from "../ui";
import { FallowOverlayShell } from "../ui/overlay-shell";
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
	executionEnvironment?: NodeJS.ProcessEnv,
): Promise<FallowNavigatorResult | null | undefined> {
	if (rawCommandArgs[0] === "issues") {
		return executeFallowProjectIssuesResult(
			pi, ctx, rawCommandArgs, rememberLast, setLastFallowArgs, initialNavigatorState, onCompleted,
		);
	}
	const finalArgs = buildFallowFinalArgs(rawCommandArgs);
	if (rememberLast) setLastFallowArgs([...finalArgs]);
	return runFallowResultFlow(
		pi, ctx, finalArgs, buildFallowExecutor(pi, ctx, finalArgs, fallowCli.execFallow, executionEnvironment), initialNavigatorState, onCompleted,
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
		pi,
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
	const hasNavigator = hasFallowNavigator(ctx.mode, formatted.overview, true);
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
	pi: ExtensionAPI,
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
		optionalAnalysis: true,
		checkReadiness: createReadinessCheck(pi, resolveReadinessRoot(ctx.cwd, originCommandArgs)),
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
	optionalAnalysis?: boolean;
	checkReadiness?: ReadinessCheck;
}

export function openFallowOverviewNavigator(
	ctx: FallowCommandContext,
	overview: FallowCommandResult["formatted"]["overview"],
	options: FallowOverviewNavigatorOptions,
): Promise<FallowNavigatorResult | null> {
	if (!isFallowTuiMode(ctx.mode) || !overview) return Promise.resolve(null);
	const navigatorMode = resolveFallowNavigatorMode(overview, options.optionalAnalysis);
	if (navigatorMode === "none") return Promise.resolve(null);
	const informationalMode = navigatorMode === "informational";
	let shell: FallowOverlayShell | undefined;
	return ctx.ui.custom<FallowNavigatorResult | null>((tui, theme, _keybindings, done) => {
		const finish = (result: FallowNavigatorResult | null) => {
			const completed = withOverlayState(result, shell);
			shell?.dispose();
			done(completed);
		};
		const navigator = new FallowIssueNavigator(overview, theme, finish, () => tui.requestRender(), {
			...options,
			commandArgs: [...options.commandArgs],
			visibleRows: resolveFallowNavigatorVisibleRows(tui.terminal.rows - (options.optionalAnalysis ? 4 : 0), informationalMode),
			informationalMode,
			optionalAnalysis: options.optionalAnalysis,
		});
		if (!options.optionalAnalysis) return navigator;
		shell = new FallowOverlayShell(navigator, theme, () => tui.requestRender(), () => tui.terminal.rows, options.checkReadiness, {
			projectRoot: resolveReadinessRoot(ctx.cwd, options.commandArgs), initialState: options.initialState?.overlay,
			onSimilarCodeRun: similarCodeRunCallback(options.commandArgs, navigator, finish),
		});
		return shell;
	}, {
		overlay: true,
		overlayOptions: FALLOW_NAVIGATOR_OVERLAY_OPTIONS,
	}).finally(() => shell?.dispose());
}

function similarCodeRunCallback(
	commandArgs: string[], navigator: FallowIssueNavigator, finish: (result: FallowNavigatorResult | null) => void,
): ((request: SimilarCodeRunRequest) => void) | undefined {
	if (!commandArgs.length) return undefined;
	return (request) => finish({
		type: "action", label: "Run Similar Code", commandArgs: [...request.commandArgs],
		returnTo: { commandArgs: [...commandArgs], state: navigator.snapshotState() },
	});
}

function withOverlayState(result: FallowNavigatorResult | null, shell: FallowOverlayShell | undefined): FallowNavigatorResult | null {
	if (!shell || result?.type !== "action") return result;
	return { ...result, returnTo: { ...result.returnTo, state: { ...result.returnTo.state, overlay: shell.snapshotState() } } };
}
