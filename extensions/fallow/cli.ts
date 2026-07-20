import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fallowEngine } from "./engine";
import { stripAtPrefix } from "./path";
import { execFallowProcess } from "./process";
import { createFallowRunner } from "./runner";
import type { FallowRunParams } from "./schema";

function addValue(args: string[], flag: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	args.push(flag, String(value));
}

function addBool(args: string[], flag: string, value: boolean | undefined): void {
	if (value) args.push(flag);
}

function addWorkspace(args: string[], workspace: FallowRunParams["workspace"]): void {
	if (!workspace) return;
	args.push("--workspace", Array.isArray(workspace) ? workspace.join(",") : workspace);
}

function rejectFormatOverride(extraArgs?: string[]): void {
	if (!extraArgs) return;
	if (extraArgs.some((arg) => arg === "--format" || arg.startsWith("--format=") || arg === "-f")) {
		throw new Error("extraArgs must not include --format/-f; the Pi extension always requests JSON output.");
	}
}

function addCoverageOptions(args: string[], params: FallowRunParams): void {
	addValue(args, "--coverage", params.coverage);
	addValue(args, "--coverage-root", params.coverageRoot);
	addValue(args, "--runtime-coverage", params.runtimeCoverage);
	addValue(args, "--max-crap", params.maxCrap);
}

function addDupesOptions(args: string[], params: FallowRunParams): void {
	addValue(args, "--min-tokens", params.minTokens);
	addValue(args, "--min-lines", params.minLines);
	addValue(args, "--threshold", params.threshold);
	addValue(args, "--min-occurrences", params.minOccurrences);
	addBool(args, "--skip-local", params.skipLocal);
	addBool(args, "--cross-language", params.crossLanguage);
	addBool(args, "--ignore-imports", params.ignoreImports);
}

type CommandArgsBuilder = (args: string[], params: FallowRunParams) => void;

function addCommonArgs(args: string[], params: FallowRunParams): void {
	args.push("--format", "json", "--quiet");
	addValue(args, "--config", params.config);
	addWorkspace(args, params.workspace);
	addBool(args, "--production", params.production);
	addBool(args, "--no-cache", params.noCache);
	addValue(args, "--threads", params.threads);
}

function buildAllArgs(args: string[], params: FallowRunParams): void {
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince);
	addBool(args, "--score", params.score);
}

function buildDeadCodeArgs(args: string[], params: FallowRunParams): void {
	args.push("dead-code");
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince);
	addBool(args, "--include-entry-exports", params.includeEntryExports);
	addValue(args, "--group-by", params.groupBy);
}

function buildCheckChangedArgs(args: string[], params: FallowRunParams): void {
	// Fallow exposes changed-file combined checks through the root command plus --changed-since.
	addCommonArgs(args, params);
	if (!params.changedSince && !params.base) throw new Error("check-changed requires changedSince or base.");
	addValue(args, "--changed-since", params.changedSince ?? params.base);
	addBool(args, "--include-entry-exports", params.includeEntryExports);
}

function buildDupeArgs(args: string[], params: FallowRunParams): void {
	args.push("dupes");
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince);
	addValue(args, "--top", params.top);
	addDupesOptions(args, params);
}

function buildHealthArgs(args: string[], params: FallowRunParams): void {
	args.push("health");
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince);
	addValue(args, "--top", params.top);
	addValue(args, "--group-by", params.groupBy);
	addBool(args, "--file-scores", params.fileScores);
	addBool(args, "--hotspots", params.hotspots);
	addBool(args, "--targets", params.targets);
	addBool(args, "--score", params.score);
	addBool(args, "--trend", params.trend);
	addCoverageOptions(args, params);
}

function buildAuditArgs(args: string[], params: FallowRunParams): void {
	args.push("audit");
	addCommonArgs(args, params);
	addValue(args, "--base", params.base ?? params.changedSince);
	addValue(args, "--gate", params.gate);
	addBool(args, "--explain", params.explain);
	addBool(args, "--include-entry-exports", params.includeEntryExports);
	addCoverageOptions(args, params);
	addValue(args, "--diff-file", params.diffFile);
}

function buildFixPreviewArgs(args: string[], params: FallowRunParams): void {
	args.push("fix", "--dry-run");
	addCommonArgs(args, params);
	addBool(args, "--include-entry-exports", params.includeEntryExports);
	addBool(args, "--no-create-config", params.noCreateConfig);
}

function buildFixApplyArgs(args: string[], params: FallowRunParams): void {
	args.push("fix", "--yes");
	addCommonArgs(args, params);
	addBool(args, "--include-entry-exports", params.includeEntryExports);
	addBool(args, "--no-create-config", params.noCreateConfig);
}

function buildFlagsArgs(args: string[], params: FallowRunParams): void {
	args.push("flags");
	addCommonArgs(args, params);
	addValue(args, "--top", params.top);
}

function buildInspectArgs(args: string[], params: FallowRunParams): void {
	args.push("inspect");
	addCommonArgs(args, params);
	if (params.symbol || params.exportName) addValue(args, "--symbol", buildSymbolTarget(params, "inspect"));
	else if (params.file) addValue(args, "--file", stripAtPrefix(params.file));
	else throw new Error("inspect requires file, symbol, or file plus exportName.");
	addBool(args, "--symbol-chain", params.symbolChain);
}

function buildTraceSymbolArgs(args: string[], params: FallowRunParams): void {
	args.push("trace", buildSymbolTarget(params, "trace-symbol"));
	addCommonArgs(args, params);
	addBool(args, "--callers", params.callers);
	addBool(args, "--callees", params.callees);
	addValue(args, "--depth", params.depth);
}

function buildSymbolTarget(params: FallowRunParams, commandName: string): string {
	if (params.symbol) return stripAtPrefix(params.symbol);
	if (params.file && params.exportName) return `${stripAtPrefix(params.file)}:${params.exportName}`;
	throw new Error(`${commandName} requires symbol or file and exportName.`);
}

function buildSecurityArgs(args: string[], params: FallowRunParams): void {
	args.push("security");
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince ?? params.base);
	addValue(args, "--diff-file", params.diffFile);
	addValue(args, "--runtime-coverage", params.runtimeCoverage);
	addValue(args, "--min-invocations-hot", params.minInvocationsHot);
	addValue(args, "--file", params.file ? stripAtPrefix(params.file) : undefined);
	addValue(args, "--gate", params.securityGate);
	addBool(args, "--surface", params.surface);
	addBool(args, "--explain", params.explain);
}

function buildWorkspacesArgs(args: string[], params: FallowRunParams): void {
	args.push("workspaces");
	addCommonArgs(args, params);
}

function buildConfigArgs(args: string[], params: FallowRunParams): void {
	args.push("config");
	addCommonArgs(args, params);
}

function buildSchemaArgs(args: string[], params: FallowRunParams): void {
	args.push("schema");
	addCommonArgs(args, params);
}

function buildDecisionSurfaceArgs(args: string[], params: FallowRunParams): void {
	args.push("decision-surface");
	addCommonArgs(args, params);
	addValue(args, "--changed-since", params.changedSince ?? params.base);
	addValue(args, "--diff-file", params.diffFile);
	addValue(args, "--max-decisions", params.maxDecisions);
}

function buildImpactArgs(args: string[], params: FallowRunParams): void {
	args.push("impact");
	addCommonArgs(args, params);
}

function buildProjectInfoArgs(args: string[], params: FallowRunParams): void {
	args.push("list");
	addCommonArgs(args, params);
	addBool(args, "--entry-points", params.entryPoints);
	addBool(args, "--files", params.files);
	addBool(args, "--plugins", params.plugins);
	addBool(args, "--boundaries", params.boundaries);
	addBool(args, "--workspaces", params.listWorkspaces);
}

function buildListBoundariesArgs(args: string[], params: FallowRunParams): void {
	args.push("list", "--boundaries");
	addCommonArgs(args, params);
}

function buildExplainArgs(args: string[], params: FallowRunParams): void {
	if (!params.issueType) throw new Error("explain requires issueType.");
	args.push("explain", params.issueType);
	addCommonArgs(args, params);
}

function buildTraceExportArgs(args: string[], params: FallowRunParams): void {
	if (!params.file || !params.exportName) throw new Error("trace-export requires file and exportName.");
	args.push("dead-code", "--trace", `${stripAtPrefix(params.file)}:${params.exportName}`);
	addCommonArgs(args, params);
}

function buildTraceFileArgs(args: string[], params: FallowRunParams): void {
	if (!params.file) throw new Error("trace-file requires file.");
	args.push("dead-code", "--trace-file", stripAtPrefix(params.file));
	addCommonArgs(args, params);
}

function buildTraceDependencyArgs(args: string[], params: FallowRunParams): void {
	if (!params.packageName) throw new Error("trace-dependency requires packageName.");
	args.push("dead-code", "--trace-dependency", params.packageName);
	addCommonArgs(args, params);
}

function buildTraceCloneArgs(args: string[], params: FallowRunParams): void {
	if (!params.file || !params.line) throw new Error("trace-clone requires file and line.");
	args.push("dupes", "--trace", `${stripAtPrefix(params.file)}:${params.line}`);
	addCommonArgs(args, params);
	addDupesOptions(args, params);
}

function buildCoverageAnalyzeArgs(args: string[], params: FallowRunParams): void {
	args.push("coverage", "analyze");
	addCommonArgs(args, params);
	addValue(args, "--runtime-coverage", params.runtimeCoverage ?? params.coverage);
	addValue(args, "--top", params.top);
	addValue(args, "--group-by", params.groupBy);
}

const commandBuilders: Record<string, CommandArgsBuilder> = {
	all: buildAllArgs,
	"dead-code": buildDeadCodeArgs,
	"check-changed": buildCheckChangedArgs,
	dupes: buildDupeArgs,
	health: buildHealthArgs,
	audit: buildAuditArgs,
	"fix-preview": buildFixPreviewArgs,
	"fix-apply": buildFixApplyArgs,
	flags: buildFlagsArgs,
	inspect: buildInspectArgs,
	"trace-symbol": buildTraceSymbolArgs,
	security: buildSecurityArgs,
	workspaces: buildWorkspacesArgs,
	config: buildConfigArgs,
	schema: buildSchemaArgs,
	"decision-surface": buildDecisionSurfaceArgs,
	impact: buildImpactArgs,
	"project-info": buildProjectInfoArgs,
	"list-boundaries": buildListBoundariesArgs,
	explain: buildExplainArgs,
	"trace-export": buildTraceExportArgs,
	"trace-file": buildTraceFileArgs,
	"trace-dependency": buildTraceDependencyArgs,
	"trace-clone": buildTraceCloneArgs,
	"coverage-analyze": buildCoverageAnalyzeArgs,
};

function buildFallowArgs(params: FallowRunParams): string[] {
	rejectFormatOverride(params.extraArgs);
	const args: string[] = [];
	const builder = commandBuilders[params.command];
	if (!builder) throw new Error(`Unsupported fallow command: ${params.command}`);
	builder(args, params);
	args.push(...(params.extraArgs ?? []));
	return args;
}

const fallowRunner = createFallowRunner();

function execFallow(pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number) {
	return fallowRunner.execute(pi, args, cwd, signal, timeoutSecs);
}

function clearRunnerCache(pi: ExtensionAPI): void {
	fallowRunner.clear(pi);
}

function resolveFallowRoot(params: FallowRunParams, contextRoot: string): string {
	if (!params.root) return contextRoot;
	return resolve(contextRoot, stripAtPrefix(params.root));
}

function resolveFallowTimeout(params: FallowRunParams): number {
	if (params.timeoutSecs !== undefined) return params.timeoutSecs;
	return Number(process.env.FALLOW_TIMEOUT_SECS || 120);
}

async function runFallow(pi: ExtensionAPI, params: FallowRunParams, ctx: ExtensionContext, signal?: AbortSignal) {
	const { details, content } = await fallowEngine.runFallowWithExecutor({
		pi,
		cwd: resolveFallowRoot(params, ctx.cwd),
		args: buildFallowArgs(params),
		signal: signal ?? ctx.signal,
		timeoutSecs: resolveFallowTimeout(params),
		executor: execFallow,
	});
	return { content: [{ type: "text" as const, text: content }], details };
}

type CliQuote = "'" | '"';

function splitArgs(input: string): string[] {
	const state = createSplitArgsState();
	for (const char of input) {
		applySplitChar(state, char);
	}
	if (state.quote) throw new Error("Unclosed quote in arguments.");
	if (state.current) state.args.push(state.current);
	return state.args;
}

function createSplitArgsState(): {
	args: string[];
	current: string;
	quote: CliQuote | undefined;
	escaped: boolean;
} {
	return { args: [], current: "", quote: undefined, escaped: false };
}

function applySplitChar(
	state: { args: string[]; current: string; quote: CliQuote | undefined; escaped: boolean },
	char: string,
): void {
	if (state.escaped) return handleEscapedChar(state, char);
	return applySplitCharWithoutEscape(state, char);
}

function handleEscapedChar(
	state: { current: string; escaped: boolean },
	char: string,
): void {
	applyEscapedChar(state, char);
}

function applySplitCharWithoutEscape(
	state: { args: string[]; current: string; quote: CliQuote | undefined; escaped: boolean },
	char: string,
): void {
	if (char === "\\") {
		state.escaped = true;
		return;
	}
	if (state.quote) {
		return applyQuotedChar(state, char);
	}
	return applySplitCharInUnquoted(state, char);
}

function applySplitCharInUnquoted(
	state: { args: string[]; current: string; quote: CliQuote | undefined },
	char: string,
): void {
	if (isQuoteChar(char)) {
		state.quote = char;
		return;
	}
	if (isWhitespaceChar(char)) return flushSplitArg(state);
	state.current += char;
}

function applyEscapedChar(state: { current: string; escaped: boolean }, char: string): void {
	state.current += char;
	state.escaped = false;
}

function applyQuotedChar(
	state: { current: string; quote: CliQuote | undefined },
	char: string,
): void {
	if (char === state.quote) state.quote = undefined;
	else state.current += char;
}

function isWhitespaceChar(value: string): boolean {
	return /\s/.test(value);
}
function isQuoteChar(value: string): value is CliQuote {
	return value === "'" || value === '"';
}

function flushSplitArg(state: { args: string[]; current: string }): void {
	if (!state.current) return;
	state.args.push(state.current);
	state.current = "";
}

export const fallowCli = {
	runFallow,
	execFallow,
	execCommand: execFallowProcess,
	clearRunnerCache,
	splitArgs,
	buildFallowArgs,
};

