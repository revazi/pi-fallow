import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { fallowCompletions } from "./fallow/autocomplete";
import { fallowCli } from "./fallow/cli";
import { runFallowCommandHandler } from "./fallow/command/handler";
import type { FallowCommandState } from "./fallow/command/types";
import { fallowRunParams } from "./fallow/schema";
import { registerFallowSessionStart } from "./fallow/session";
import { renderFallowMessageRenderer, renderFallowToolCall, renderFallowToolResult } from "./fallow/tool-render";

export default function (pi: ExtensionAPI) {
	const commandState: FallowCommandState = { lastArgs: null };
	registerFallowTool(pi);
	registerFallowCommand(pi, commandState);
	registerFallowResultRenderer(pi);
	registerFallowSessionStart(pi);
}

function registerFallowTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fallow_run",
		label: "Fallow",
		description: buildFallowToolDescription(),
		promptSnippet: "Run Fallow static/runtime codebase intelligence and return JSON summaries.",
		promptGuidelines: fallowToolPromptGuidelines,
		parameters: fallowRunParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Running fallow ${params.command}...` }] });
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled." }], details: {} };
			return fallowCli.runFallow(pi, params, ctx);
		},
		renderCall(args, theme) {
			return renderFallowToolCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderFallowToolResult(result, options, theme);
		},
	});
}

function buildFallowToolDescription(): string {
	return `Run Fallow codebase intelligence for TypeScript/JavaScript: PR/new-issue audits (audit --base ... --gate new-only), changed-file checks, dead code, duplication, health, inspect/trace evidence, security candidates, decision surfaces, project/config/schema info, feature flags, impact, auto-fix preview/apply, and runtime coverage. JSON output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated. Uses FALLOW_BIN if set, otherwise fallow from PATH, falling back to npx -y fallow.`;
}

const fallowToolPromptGuidelines = [
	"Use fallow_run after making TypeScript/JavaScript changes when the user asks for cleanup, quality, dead-code, duplication, architecture, complexity, or PR-readiness checks.",
	"Use fallow_run with command=\"audit\", base=\"main\" or \"origin/main\", and gate=\"new-only\" for PR/new-issue checks; use command=\"check-changed\" with changedSince for changed-file checks.",
	"Use command=\"all\" for full-repo context; command=\"fix-preview\" before command=\"fix-apply\" unless the user explicitly requested automatic cleanup.",
	"Use fallow_run command=\"inspect\" with file or symbol before editing unfamiliar code when bundled evidence would reduce risk.",
	"Use fallow_run trace commands, especially command=\"trace-file\" with file or command=\"trace-symbol\" with symbol/file+exportName, before deleting exports, files, dependencies, or clone groups when confidence is low.",
];

function registerFallowCommand(pi: ExtensionAPI, commandState: FallowCommandState): void {
	pi.registerCommand("fallow", {
		description: "Run fallow with raw CLI args. JSON/quiet are added if no --format is supplied.",
		argumentHint: "[all|pr|rerun|dead-code|dupes|health|audit|inspect|trace|security|decision-surface|workspaces|config|schema|impact|fix|project-info|list|flags|coverage analyze|explain] [options]",
		getArgumentCompletions: fallowCompletions.getFallowArgumentCompletions,
		handler: (rawArgs, ctx) => runFallowCommandHandler(pi, ctx, commandState, rawArgs),
	});
}

function registerFallowResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("fallow-result", (message, options, theme) =>
		renderFallowMessageRenderer(message, options, theme),
	);
}
