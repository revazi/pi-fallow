import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { fallowPurple } from "../colors";
import { fallowEngine } from "../engine";
import type { FallowCommandContext } from "./types";

export type FallowCommandResult = Awaited<ReturnType<typeof fallowEngine.runFallowWithExecutor>>;
export type NullableFallowCommandResult = FallowCommandResult | null;
export type FallowCommandExecutor = (signal?: AbortSignal) => Promise<NullableFallowCommandResult>;

export function buildFallowFinalArgs(rawCommandArgs: string[]): string[] {
	const hasFormat = rawCommandArgs.some((arg) => arg === "--format" || arg === "-f" || arg.startsWith("--format="));
	return hasFormat ? [...rawCommandArgs] : [...rawCommandArgs, "--format", "json", "--quiet"];
}

export function buildFallowExecutor(
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

export async function runFallowWithLoaderIfUi(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	finalArgs: string[],
): Promise<NullableFallowCommandResult> {
	if (!ctx.hasUI) return executeCommand();
	return runFallowWithLoader(ctx, executeCommand, finalArgs).finally(() => clearFallowStatus(ctx));
}

function clearFallowStatus(ctx: FallowCommandContext): void {
	ctx.ui.setStatus("fallow", undefined);
}

function runFallowWithLoader(
	ctx: FallowCommandContext,
	executeCommand: FallowCommandExecutor,
	args: string[],
): Promise<NullableFallowCommandResult> {
	ctx.ui.setStatus("fallow", "fallow running…");
	return ctx.ui.custom<NullableFallowCommandResult>((_tui, theme, _keybindings, done) => {
		const displayArgs = args.length ? args.join(" ") : "all";
		const loaderTheme = buildFallowLoaderTheme(theme);
		const loader = new BorderedLoader(_tui, loaderTheme, `Running fallow ${displayArgs}...`);
		const finish = once(done);
		loader.onAbort = () => finish(null);
		executeCommand(loader.signal).then(finish, (error) => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			finish(null);
		});
		return loader;
	});
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
