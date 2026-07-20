import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCompletions } from "./fallow/autocomplete";
import { fallowCli } from "./fallow/cli";
import { fallowToolContract } from "./fallow/contract";
import { runFallowCommandHandler } from "./fallow/command/handler";
import type { FallowCommandState } from "./fallow/command/types";
import { registerFallowSessionStart } from "./fallow/session";
import { renderFallowMessageRenderer, renderFallowToolCall, renderFallowToolResult } from "./fallow/tool-render";
import { renderFallowAboutMessage } from "./fallow/update-notice";

export default function (pi: ExtensionAPI) {
	const commandState: FallowCommandState = { lastArgs: null, baseRefs: new Map() };
	registerFallowTool(pi);
	registerFallowCommand(pi, commandState);
	registerFallowResultRenderer(pi);
	registerFallowSessionStart(pi);
}

function registerFallowTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...fallowToolContract,
		prepareArguments: fallowCli.prepareFallowRunParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Running fallow ${params.command}...` }] });
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled." }], details: {} };
			return fallowCli.runFallow(pi, params, ctx, signal);
		},
		renderCall(args, theme) {
			return renderFallowToolCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderFallowToolResult(result, options, theme);
		},
	});
}

function registerFallowCommand(pi: ExtensionAPI, commandState: FallowCommandState): void {
	pi.registerCommand("fallow", {
		description: "Run fallow with raw CLI args. JSON/quiet are added if no --format is supplied.",
		argumentHint: "[about|all|pr|rerun|dead-code|dupes|health|audit|inspect|trace|security|decision-surface|workspaces|config|schema|impact|fix|project-info|list|flags|coverage analyze|explain] [options]",
		getArgumentCompletions: fallowCompletions.getFallowArgumentCompletions,
		handler: (rawArgs, ctx) => runFallowCommandHandler(pi, ctx, commandState, rawArgs),
	});
}

function registerFallowResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("fallow-result", (message, options, theme) =>
		renderFallowMessageRenderer(message, options, theme),
	);
	pi.registerMessageRenderer("fallow-about", (message, options, theme) =>
		renderFallowAboutMessage(message, options, theme),
	);
}
