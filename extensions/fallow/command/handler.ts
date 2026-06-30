import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { detectFallowGitState } from "../project/git";
import type { FallowNavigatorResult } from "../types";
import { sendFallowAboutMessage } from "../update-notice";
import { normalizeFallowArgs } from "./args";
import { executeFallowResult } from "./result-flow";
import type { FallowCommandContext, FallowCommandState } from "./types";

export async function runFallowCommandHandler(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	rawArgs: string,
): Promise<void> {
	const parsedArgs = rawArgs.trim() ? fallowCli.splitArgs(rawArgs) : [];
	if (isFallowAboutCommand(parsedArgs)) {
		await sendFallowAboutMessage(pi, ctx);
		return;
	}
	const args = await normalizeFallowHandlerArgs(ctx, commandState, parsedArgs);
	if (!args) return;
	const result = await executeFallowCommandLoop(pi, ctx, commandState, args);
	applyFallowPrompt(ctx, result);
}

function isFallowAboutCommand(args: string[]): boolean {
	return args.length === 1 && ["about", "version", "update"].includes(args[0]!);
}

async function normalizeFallowHandlerArgs(
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	parsedArgs: string[],
): Promise<string[] | null> {
	const baseRef = (await detectFallowGitState(ctx.cwd)).baseRef ?? "main";
	return normalizeFallowArgs(parsedArgs, baseRef, commandState.lastArgs, (message, level) => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	});
}

async function executeFallowCommandLoop(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandState: FallowCommandState,
	initialArgs: string[],
): Promise<FallowNavigatorResult | null | undefined> {
	let result = await runFallowCommandOnce(pi, ctx, commandState, initialArgs, true);
	while (ctx.hasUI && result?.type === "trace") {
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
	if (!ctx.hasUI || result?.type !== "prompt") return;
	ctx.ui.setEditorText(result.prompt);
	ctx.ui.notify(`Loaded ${result.issueCount} Fallow finding(s) into the editor. Add comments, then submit when ready.`, "info");
}
