import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { fallowPurple } from "../colors";
import { fallowEngine } from "../engine";
import { settleCancellableTask } from "../process";
import { isSimilarCodeCommand, SIMILAR_CODE_DEFAULT_TIMEOUT_SECS } from "../similar-code";
import { isFallowTuiMode } from "./mode";
import type { FallowCommandContext } from "./types";

export type FallowCommandResult = Awaited<ReturnType<typeof fallowEngine.runFallowWithExecutor>>;
export type NullableFallowCommandResult = FallowCommandResult | null;
export type FallowCommandExecutor = (signal?: AbortSignal) => Promise<NullableFallowCommandResult>;

export function buildFallowFinalArgs(rawCommandArgs: string[]): string[] {
	const hasFormat = rawCommandArgs.some((arg) => arg === "--format" || arg === "-f" || arg.startsWith("--format="));
	return hasFormat ? [...rawCommandArgs] : [...rawCommandArgs, "--format", "json", "--quiet"];
}

function resolveFallowCommandTimeout(args: readonly string[]): number {
	if (process.env.FALLOW_TIMEOUT_SECS) return Number(process.env.FALLOW_TIMEOUT_SECS);
	return isSimilarCodeCommand(args) ? SIMILAR_CODE_DEFAULT_TIMEOUT_SECS : 120;
}

export function buildFallowExecutor(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	args: string[],
	executor = fallowCli.execFallow,
	environment?: NodeJS.ProcessEnv,
): FallowCommandExecutor {
	const timeoutSecs = resolveFallowCommandTimeout(args);
	return (signal?: AbortSignal) => fallowEngine.runFallowWithExecutor({
		pi,
		cwd: ctx.cwd,
		args,
		signal: signal ?? ctx.signal,
		timeoutSecs,
		executor: (host, commandArgs, cwd, signal, commandTimeout) => executor(host, commandArgs, cwd, signal, commandTimeout, environment),
		throwOnExecutionError: false,
		preserveNavigatorDetails: true,
	});
}

export async function runFallowWithLoaderIfUi(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	finalArgs: string[],
): Promise<NullableFallowCommandResult> {
	if (isFallowTuiMode(ctx.mode)) return runFallowWithLoader(ctx, executeCommand, finalArgs);
	if (!ctx.hasUI) return executeCommand();
	ctx.ui.setStatus("fallow", "fallow running…");
	return executeCommand(ctx.signal).finally(() => clearFallowStatus(ctx));
}

function clearFallowStatus(ctx: FallowCommandContext): void {
	ctx.ui.setStatus("fallow", undefined);
}

function runFallowWithLoader(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	args: string[],
): Promise<NullableFallowCommandResult> {
	const displayArgs = args.length ? args.join(" ") : "all";
	return runFallowTaskWithLoader(ctx, `Running fallow ${displayArgs}...`, executeCommand);
}

export function runFallowTaskWithLoader<T>(
	ctx: FallowCommandContext,
	label: string,
	execute: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
	ctx.ui.setStatus("fallow", "fallow running…");
	return ctx.ui.custom<T | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, buildFallowLoaderTheme(theme), label);
		const finish = once(done);
		let aborted = false;
		loader.onAbort = () => { aborted = true; };
		settleCancellableTask(execute, loader.signal, () => aborted).then(finish, (error) => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			finish(null);
		});
		return loader;
	}).finally(() => clearFallowStatus(ctx));
}

function buildFallowLoaderTheme(theme: any): any {
	const loaderTheme = Object.create(theme) as typeof theme;
	const originalFg = theme.fg.bind(theme);
	loaderTheme.fg = ((color: Parameters<typeof theme.fg>[0], text: string) => color === "border" ? fallowPurple(text) : originalFg(color, text)) as typeof theme.fg;
	return loaderTheme;
}

function once<T>(done: (value: T) => void): (value: T) => void {
	let settled = false;
	return (value) => {
		if (settled) return;
		settled = true;
		done(value);
	};
}
