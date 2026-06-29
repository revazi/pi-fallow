import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { stripAtPrefix } from "./path";
import { fallowEngine } from "./engine";
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

function buildProjectInfoArgs(args: string[], params: FallowRunParams): void {
	args.push("list");
	addCommonArgs(args, params);
	addBool(args, "--entry-points", params.entryPoints);
	addBool(args, "--files", params.files);
	addBool(args, "--plugins", params.plugins);
	addBool(args, "--boundaries", params.boundaries);
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

async function execCommand(command: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", killProcess);
			resolve(result);
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};

		proc.stdout?.on("data", (data) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error: NodeJS.ErrnoException) => {
			finish({ stdout, stderr: stderr || error.message, code: error.code === "ENOENT" ? 127 : 1, killed });
		});
		proc.on("close", (code) => finish({ stdout, stderr, code: code ?? 0, killed }));

		if (signal?.aborted) killProcess();
		else signal?.addEventListener("abort", killProcess, { once: true });
		if (timeoutSecs > 0) timeoutId = setTimeout(killProcess, timeoutSecs * 1000);
	});
}

async function execFallow(_pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<{ binary: string; args: string[]; result: ExecResult }> {
	const configuredBin = process.env.FALLOW_BIN;
	const binary = configuredBin || "fallow";
	const result = await execCommand(binary, args, cwd, signal, timeoutSecs);
	if (!shouldTryNpxFallback(configuredBin, result)) {
		return { binary, args, result };
	}
	const npxArgs = buildNpxArgs(args);
	return { binary: "npx", args: npxArgs, result: await execCommand("npx", npxArgs, cwd, signal, timeoutSecs) };
}

function shouldTryNpxFallback(configuredBin: string | undefined, result: ExecResult): boolean {
	if (configuredBin) return false;
	if (!isNpxFallbackCode(result.code)) return false;
	return result.code === 127 || isEmptyFailureOutput(result);
}

function isNpxFallbackCode(code: number): boolean {
	return code === 127 || code === 1;
}

function isEmptyFailureOutput(result: ExecResult): boolean {
	return !result.stdout.trim() && !result.stderr.trim();
}

function buildNpxArgs(args: string[]): string[] {
	return ["-y", "fallow", ...args];
}

async function runFallow(pi: ExtensionAPI, params: FallowRunParams, ctx: ExtensionContext) {
	const args = buildFallowArgs(params);
	const cwd = params.root ? resolve(ctx.cwd, stripAtPrefix(params.root)) : ctx.cwd;
	const timeoutSecs = params.timeoutSecs ?? Number(process.env.FALLOW_TIMEOUT_SECS || 120);
	const { details, content } = await fallowEngine.runFallowWithExecutor({
		pi,
		cwd,
		args,
		signal: ctx.signal,
		timeoutSecs,
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
	splitArgs,
	buildFallowArgs,
};

