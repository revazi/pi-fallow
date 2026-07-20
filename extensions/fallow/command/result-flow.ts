import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatFallowProjectStateText } from "../project/text";
import { formatFallowPrSummaryText } from "../pr-summary/text";
import { commandDisplay, fallowExitLabel } from "../tool-render";
import type { FallowNavigatorResult, FallowPrSummary, FallowProjectState } from "../types";
import { FallowIssueNavigator } from "../ui";
import { buildFallowExecutor, buildFallowFinalArgs, runFallowWithLoaderIfUi, type FallowCommandExecutor, type FallowCommandResult } from "./loader";
import { hasFallowNavigator, isFallowTuiMode } from "./mode";
import { isInformationalNavigatorCommand, resolveFallowNavigatorVisibleRows } from "./navigator";
import { buildFallowTranscriptContent } from "./transcript";
import type { FallowCommandContext } from "./types";

const FALLOW_NAVIGATOR_MAX_WIDTH_RATIO = 0.9;
const FALLBACK_FALLOW_NAVIGATOR_MAX_WIDTH = 100;
const FALLOW_NAVIGATOR_MIN_WIDTH = 50;

export async function executeFallowResult(
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
	if (!commandResult) return handleMissingFallowResult(ctx);

	const { binary, args: executedArgs, execution, projectState, prSummary } = commandResult;
	const resultPrefix = buildFallowResultPrefix(projectState, prSummary);
	notifyFallowCompletion(ctx, execution, binary, executedArgs);
	renderFallowResultMessage(pi, ctx, commandResult, resultPrefix);
	return openFallowNavigator(ctx, commandResult, binary, executedArgs, projectState, prSummary);
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
	ctx.ui.notify(buildFallowCompletionMessage(execution.code, execution.killed, binary, args), shouldNotifyAsError(execution) ? "error" : "info");
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
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
): Promise<FallowNavigatorResult | null> {
	const { formatted } = result;
	if (!isFallowTuiMode(ctx.mode) || !formatted.overview) return Promise.resolve(null);
	let navigator: FallowIssueNavigator | undefined;
	const informationalMode = isInformationalNavigatorCommand(executedArgs);
	return ctx.ui.custom<FallowNavigatorResult | null>((tui, theme, _keybindings, done) => {
		navigator = new FallowIssueNavigator(
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
				visibleRows: resolveFallowNavigatorVisibleRows(tui.terminal.rows, informationalMode),
				informationalMode,
			},
		);
		return navigator;
	}, {
		overlay: true,
		overlayOptions: () => ({
			width: resolveFallowNavigatorOverlayWidth(navigator),
			minWidth: FALLOW_NAVIGATOR_MIN_WIDTH,
			maxHeight: "90%",
			anchor: "top-center",
			row: "5%",
		}),
	});
}

function resolveFallowNavigatorOverlayWidth(navigator: FallowIssueNavigator | undefined): number {
	const maxWidth = resolveFallowNavigatorMaxWidth();
	return navigator?.preferredWidth(maxWidth) ?? maxWidth;
}

function resolveFallowNavigatorMaxWidth(): number {
	const terminalWidth = process.stdout.columns;
	if (!terminalWidth || terminalWidth < 1) return FALLBACK_FALLOW_NAVIGATOR_MAX_WIDTH;
	return Math.max(1, Math.floor(terminalWidth * FALLOW_NAVIGATOR_MAX_WIDTH_RATIO));
}
