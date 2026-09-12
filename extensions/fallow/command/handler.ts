import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { sendFallowCompatibilityMessage } from "../compatibility";
import { recordFallowHistory } from "../history";
import { detectFallowBaseRef } from "../project/git";
import type { FallowExecutionOptions, FallowNavigatorResult, FallowNavigatorState } from "../types";
import { sendFallowAboutMessage } from "../update-notice";
import { normalizeFallowArgs, resolveFallowRunArgs } from "./args";
import { resolveFallowCommandBaseRef } from "./base";
import { runFallowConfigAssistantCommand } from "./config-assistant";
import { executeFallowHistoryCommand } from "./history";
import { isFallowTuiMode } from "./mode";
import { runFallowNavigatorLoop } from "./navigator-loop";
import { executeFallowResult } from "./result-flow";
import type { FallowCommandContext, FallowCommandState } from "./types";

export async function runFallowCommandHandler(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	rawArgs: string,
): Promise<void> {
	const parsedArgs = parseFallowHandlerArgs(ctx, rawArgs);
	if (!parsedArgs) return;
	if (await runFallowExtensionCommand(pi, ctx, parsedArgs)) return;
	const args = await normalizeFallowHandlerArgs(ctx, commandState, parsedArgs);
	if (!args) return;
	const result = await executeFallowCommandLoop(pi, ctx, commandState, args);
	applyFallowPrompt(ctx, result);
}

function parseFallowHandlerArgs(ctx: FallowCommandContext, rawArgs: string): string[] | null {
	try {
		const explicitArgs = splitOptionalFallowArgs(rawArgs);
		const configuredArgs = splitOptionalFallowArgs(process.env.PI_FALLOW_DEFAULT_COMMAND ?? "");
		return resolveFallowRunArgs(explicitArgs, configuredArgs);
	} catch (error) {
		return reportFallowInputError(ctx, error);
	}
}

function splitOptionalFallowArgs(value: string): string[] {
	return value.trim() ? fallowCli.splitArgs(value) : [];
}

async function runFallowExtensionCommand(pi: ExtensionAPI, ctx: FallowCommandContext, args: string[]): Promise<boolean> {
	if (isFallowAboutCommand(args)) await sendFallowAboutMessage(pi, ctx);
	else if (isFallowCompatibilityCommand(args)) await sendFallowCompatibilityMessage(pi, ctx);
	else return runConfigAssistantIfRequested(pi, ctx, args);
	return true;
}

async function runConfigAssistantIfRequested(pi: ExtensionAPI, ctx: FallowCommandContext, args: string[]): Promise<boolean> {
	if (args[0] !== "config-assist") return false;
	try { await runFallowConfigAssistantCommand(pi, ctx, args); }
	catch (error) { reportFallowInputError(ctx, error); }
	return true;
}

function isFallowAboutCommand(args: string[]): boolean {
	return args.length === 1 && ["about", "version", "update"].includes(args[0]!);
}

function isFallowCompatibilityCommand(args: string[]): boolean {
	return args.length === 1 && args[0] === "compatibility";
}

async function normalizeFallowHandlerArgs(
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	parsedArgs: string[],
): Promise<string[] | null> {
	try {
		const baseRef = await resolveFallowCommandBaseRef(parsedArgs, ctx.cwd, commandState, detectFallowBaseRef);
		return normalizeFallowArgs(parsedArgs, baseRef, commandState.lastArgs, (message, level) => {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		});
	} catch (error) {
		return reportFallowInputError(ctx, error);
	}
}

function reportFallowInputError(ctx: FallowCommandContext, error: unknown): null {
	if (!ctx.hasUI) throw error;
	ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	return null;
}

async function executeFallowCommandLoop(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	initialArgs: string[],
): Promise<FallowNavigatorResult | null | undefined> {
	return runFallowNavigatorLoop(initialArgs, isFallowTuiMode(ctx.mode), (args, rememberLast, initialState, protectedHistoryIds, environment, runtimeCoverage) => (
		runFallowCommandOnce(pi, ctx, commandState, args, rememberLast, initialState, protectedHistoryIds, { environment, runtimeCoverage })
	));
}

function runFallowCommandOnce(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	args: string[],
	rememberLast: boolean,
	initialNavigatorState?: FallowNavigatorState,
	protectedHistoryIds?: string[],
	executionOptions?: FallowExecutionOptions,
): Promise<FallowNavigatorResult | null | undefined> {
	if (args[0] === "history") {
		return executeFallowHistoryCommand(pi, ctx, commandState.history, args, initialNavigatorState);
	}
	return executeFallowResult(pi, ctx, args, rememberLast, (updated) => {
		commandState.lastArgs = updated;
	}, initialNavigatorState, initialNavigatorState ? undefined : (result, commandArgs) => (
		recordFallowHistory(pi, commandState.history, ctx.cwd, result, protectedHistoryIds, commandArgs)
	), executionOptions);
}

function applyFallowPrompt(ctx: FallowCommandContext, result: FallowNavigatorResult | null | undefined): void {
	if (!isFallowTuiMode(ctx.mode) || result?.type !== "prompt") return;
	ctx.ui.setEditorText(result.prompt);
	ctx.ui.notify(`Loaded ${result.issueCount} Fallow finding(s) in ${result.detail} mode. Add comments, then submit when ready.`, "info");
}
