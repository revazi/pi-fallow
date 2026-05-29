import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getFallowArgumentCompletions } from "./fallow/autocomplete";
import { commandDisplay, execFallow, fallowExitLabel, runFallow, splitArgs } from "./fallow/cli";
import { formatToolOutput, parseJson } from "./fallow/output";
import { fallowRunParams } from "./fallow/schema";
import type { FallowDetails, FallowOverview } from "./fallow/types";
import { FallowIssueNavigator, FallowOverviewComponent, type FallowNavigatorResult } from "./fallow/ui";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fallow_run",
		label: "Fallow",
		description: `Run Fallow codebase intelligence for TypeScript/JavaScript: dead code, changed-file checks, duplication, health, audit, auto-fix preview/apply, project info, traces, feature flags, and runtime coverage. JSON output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated. Uses FALLOW_BIN if set, otherwise fallow from PATH, falling back to npx -y fallow.`,
		promptSnippet: "Run Fallow static/runtime codebase intelligence and return JSON summaries.",
		promptGuidelines: [
			"Use fallow_run after making TypeScript/JavaScript changes when the user asks for cleanup, quality, dead-code, duplication, architecture, complexity, or PR-readiness checks.",
			"Use fallow_run with command=\"audit\" for PR/change gates; command=\"all\" for full-repo context; command=\"fix-preview\" before command=\"fix-apply\" unless the user explicitly requested automatic cleanup.",
			"Use fallow_run trace commands before deleting exports, files, dependencies, or clone groups when confidence is low.",
		],
		parameters: fallowRunParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Running fallow ${params.command}...` }] });
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled." }], details: {} };
			return runFallow(pi, params, ctx);
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("fallow "));
			text += theme.fg("accent", args.command ?? "run");
			if (args.root) text += theme.fg("muted", ` in ${args.root}`);
			if (args.changedSince || args.base) text += theme.fg("dim", ` since ${args.changedSince ?? args.base}`);
			return new Text(text, 0, 0);
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
				});
			}
			let text = theme.fg(details.exitCode === 0 ? "success" : "warning", `Fallow ${fallowExitLabel(details.exitCode)} (exit ${details.exitCode})`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			text += theme.fg("dim", ` · ${details.elapsedMs}ms`);
			if (expanded) {
				text += `\n${theme.fg("muted", commandDisplay(details.command, details.args))}`;
				text += `\n${theme.fg("dim", details.summary)}`;
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("fallow", {
		description: "Run fallow with raw CLI args. JSON/quiet are added if no --format is supplied.",
		argumentHint: "[dead-code|dupes|health|audit|fix|list|flags|coverage analyze] [options]",
		getArgumentCompletions: getFallowArgumentCompletions,
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim() ? splitArgs(rawArgs) : [];
			const hasFormat = args.some((arg) => arg === "--format" || arg === "-f" || arg.startsWith("--format="));
			const finalArgs = hasFormat ? args : [...args, "--format", "json", "--quiet"];
			const timeoutSecs = Number(process.env.FALLOW_TIMEOUT_SECS || 120);
			const runCommand = async (signal?: AbortSignal) => {
				const { binary, args: executedArgs, result } = await execFallow(pi, finalArgs, ctx.cwd, signal ?? ctx.signal, timeoutSecs);
				const parsed = parseJson(result.stdout, result.stderr);
				const formatted = await formatToolOutput(parsed, ctx.cwd, result.code);
				return { binary, executedArgs, result, formatted };
			};

			let commandResult: Awaited<ReturnType<typeof runCommand>> | null;
			if (ctx.hasUI) {
				ctx.ui.setStatus("fallow", "fallow running…");
				try {
					commandResult = await ctx.ui.custom<Awaited<ReturnType<typeof runCommand>> | null>((tui, theme, _keybindings, done) => {
						const displayArgs = finalArgs.length ? finalArgs.join(" ") : "all";
						const loader = new BorderedLoader(tui, theme, `Running fallow ${displayArgs}...`);
						let settled = false;
						const finish = (value: Awaited<ReturnType<typeof runCommand>> | null) => {
							if (settled) return;
							settled = true;
							done(value);
						};
						loader.onAbort = () => finish(null);
						runCommand(loader.signal).then(finish, (error) => {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							finish(null);
						});
						return loader;
					});
				} finally {
					ctx.ui.setStatus("fallow", "fallow ready");
				}
				if (!commandResult) {
					ctx.ui.notify("fallow cancelled", "info");
					return;
				}
			} else {
				commandResult = await runCommand();
			}

			const { binary, executedArgs, result, formatted } = commandResult;
			if (ctx.hasUI) {
				const label = fallowExitLabel(result.code, result.killed);
				const message = result.code === 1
					? `fallow found issues: ${commandDisplay(binary, executedArgs)}`
					: `fallow ${label}: ${commandDisplay(binary, executedArgs)}`;
				ctx.ui.notify(message, result.code >= 2 || result.killed ? "error" : "info");
			}
			const hasNavigator = ctx.hasUI && formatted.overview?.sections.some((section) => section.items.length > 0);
			pi.sendMessage({
				customType: "fallow-result",
				content: hasNavigator ? `Opened Fallow issue navigator.\n${formatted.summary}` : formatted.text,
				display: true,
				details: { command: binary, args: executedArgs, exitCode: result.code, overview: formatted.overview, compact: hasNavigator, fullOutputPath: formatted.fullOutputPath, truncated: formatted.truncated },
			});

			if (hasNavigator) {
				const navigatorResult = await ctx.ui.custom<FallowNavigatorResult | null>((tui, theme, _keybindings, done) => {
					return new FallowIssueNavigator(
						formatted.overview!,
						theme,
						done,
						() => tui.requestRender(),
						{
							command: commandDisplay(binary, executedArgs),
							fullOutputPath: formatted.fullOutputPath,
							truncated: formatted.truncated,
						},
					);
				}, {
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
				});

				if (navigatorResult) {
					ctx.ui.setEditorText(navigatorResult.prompt);
					ctx.ui.notify(`Loaded ${navigatorResult.issueCount} Fallow finding(s) into the editor. Add comments, then submit when ready.`, "info");
				}
			}
		},
	});

	pi.registerMessageRenderer("fallow-result", (message, options, theme) => {
		const details = message.details as { command?: string; args?: string[]; overview?: FallowOverview; compact?: boolean; fullOutputPath?: string; truncated?: boolean } | undefined;
		if (details?.compact) {
			const title = details.overview?.title ?? "Fallow result";
			const stats = details.overview?.stats.slice(0, 5).map((stat) => `${stat.label}: ${stat.value}`).join(" · ");
			return new Text(theme.fg("toolTitle", theme.bold(title)) + (stats ? `\n${theme.fg("dim", stats)}` : "") + "\n" + theme.fg("muted", "Detailed findings were shown in the navigator window."), 0, 0);
		}
		if (details?.overview) {
			return new FallowOverviewComponent(details.overview, theme, {
				expanded: options.expanded,
				command: details.command && details.args ? commandDisplay(details.command, details.args) : undefined,
				fullOutputPath: details.fullOutputPath,
				truncated: details.truncated,
			});
		}
		return new Text(theme.fg("toolTitle", theme.bold("Fallow result")) + "\n" + message.content, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("fallow", "fallow ready");
	});
}
