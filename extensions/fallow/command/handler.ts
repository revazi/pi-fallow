import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { detectFallowBaseRef } from "../project/git";
import type { FallowNavigatorResult } from "../types";
import { sendFallowAboutMessage } from "../update-notice";
import { normalizeFallowArgs, resolveFallowRunArgs } from "./args";
import { resolveFallowCommandBaseRef } from "./base";
import { isFallowTuiMode } from "./mode";
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
	if (isFallowAboutCommand(parsedArgs)) {
		await sendFallowAboutMessage(pi, ctx);
		return;
	}
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

function isFallowAboutCommand(args: string[]): boolean {
	return args.length === 1 && ["about", "version", "update"].includes(args[0]!);
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
	let result = await runFallowCommandOnce(pi, ctx, commandState, initialArgs, true);
	while (isFallowTuiMode(ctx.mode) && result?.type === "trace") {
		result = await runFallowCommandOnce(pi, ctx, commandState, result.commandArgs, false);
	}
	return result;
}

function runFallowCommandOnce(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	args: string[],
	rememberLast: boolean,
): Promise<FallowNavigatorResult | null | undefined> {
	return executeFallowResult(pi, ctx, args, rememberLast, (updated) => {
		commandState.lastArgs = updated;
	});
}

function applyFallowPrompt(ctx: FallowCommandContext, result: FallowNavigatorResult | null | undefined): void {
	if (!isFallowTuiMode(ctx.mode) || result?.type !== "prompt") return;
	ctx.ui.setEditorText(result.prompt);
	ctx.ui.notify(`Loaded ${result.issueCount} Fallow finding(s) in ${result.detail} mode. Add comments, then submit when ready.`, "info");
}
