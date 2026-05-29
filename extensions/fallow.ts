import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { commandDisplay, execFallow, fallowExitLabel, runFallow, splitArgs } from "./fallow/cli";
import { formatToolOutput, parseJson } from "./fallow/output";
import { fallowRunParams } from "./fallow/schema";
import type { FallowDetails, FallowOverview } from "./fallow/types";
import { FallowOverviewComponent } from "./fallow/ui";

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
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim() ? splitArgs(rawArgs) : [];
			const hasFormat = args.some((arg) => arg === "--format" || arg === "-f" || arg.startsWith("--format="));
			const finalArgs = hasFormat ? args : [...args, "--format", "json", "--quiet"];
			const timeoutSecs = Number(process.env.FALLOW_TIMEOUT_SECS || 120);
			const { binary, args: executedArgs, result } = await execFallow(pi, finalArgs, ctx.cwd, ctx.signal, timeoutSecs);
			const parsed = parseJson(result.stdout, result.stderr);
			const formatted = await formatToolOutput(parsed, ctx.cwd, result.code);
			if (ctx.hasUI) {
				const label = fallowExitLabel(result.code, result.killed);
				const message = result.code === 1
					? `fallow found issues: ${commandDisplay(binary, executedArgs)}`
					: `fallow ${label}: ${commandDisplay(binary, executedArgs)}`;
				ctx.ui.notify(message, result.code >= 2 || result.killed ? "error" : "info");
			}
			pi.sendMessage({
				customType: "fallow-result",
				content: formatted.text,
				display: true,
				details: { command: binary, args: executedArgs, exitCode: result.code, overview: formatted.overview, fullOutputPath: formatted.fullOutputPath, truncated: formatted.truncated },
			});
		},
	});

	pi.registerMessageRenderer("fallow-result", (message, options, theme) => {
		const details = message.details as { command?: string; args?: string[]; overview?: FallowOverview; fullOutputPath?: string; truncated?: boolean } | undefined;
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
