// fallow-ignore-file unused-export
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { buildFallowPrSummary, formatFallowPrSummary } from "./pr-summary";
import { detectFallowProjectState, formatFallowProjectState } from "./project";
import { formatSummaryLines } from "./summary";
import { formatToolOutput, parseJson } from "./output";
import type { FallowDetails, FallowOverview, FallowPrSummary, FallowProjectState } from "./types";

interface FallowExecutor {
	(pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<{
		binary: string;
		args: string[];
		result: ExecResult;
	}>;
}

interface FallowCommandInput {
	pi: ExtensionAPI;
	cwd: string;
	args: string[];
	signal: AbortSignal | undefined;
	timeoutSecs: number;
	executor: FallowExecutor;
	throwOnExecutionError?: boolean;
}

interface FallowCommandResult {
	binary: string;
	args: string[];
	result: ExecResult;
	formatted: {
		text: string;
		summary: string;
		overview?: FallowOverview;
		fullOutputPath?: string;
		truncated?: boolean;
	};
	parsed: { parsed: boolean; data?: unknown; raw: string };
	projectState: FallowProjectState;
	prSummary?: FallowPrSummary;
	details: FallowDetails;
	content: string;
}

function formatCommandLine(binary: string, args: string[]): string {
	if (!args.length) return binary;
	return [binary, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

async function runFallowWithExecutor(input: FallowCommandInput): Promise<FallowCommandResult> {
	const {
		pi,
		cwd,
		args,
		signal,
		timeoutSecs,
		executor,
		throwOnExecutionError = true,
	} = input;

	const started = Date.now();
	const { binary, args: executedArgs, result } = await executor(pi, args, cwd, signal, timeoutSecs);
	const elapsedMs = Date.now() - started;
	const projectState = await detectFallowProjectState(cwd, executedArgs);
	const parsed = parseJson(result.stdout, result.stderr);
	const formatted = await formatToolOutput(parsed, cwd, result.code);
	const prSummary = buildFallowPrSummary(parsed.data, executedArgs, result.code);

	const details: FallowDetails = {
		command: binary,
		args: executedArgs,
		cwd,
		exitCode: result.code,
		elapsedMs,
		parsed: parsed.parsed,
		summary: formatted.summary,
		overview: formatted.overview,
		fullOutputPath: formatted.fullOutputPath,
		truncated: formatted.truncated,
		projectState,
		prSummary,
	};

	const prSummaryLines = formatFallowPrSummary(prSummary);
	const projectStateLines = formatFallowProjectState(projectState);
	const prSummaryText = formatSummaryLines(prSummaryLines);
	const projectStateText = formatSummaryLines(projectStateLines);
	const contentPrefix = [prSummaryText, projectStateText].filter(Boolean).join("\n");
	const content = contentPrefix ? `${contentPrefix}\n\n${formatted.text}` : formatted.text;

	if ((result.code >= 2 || result.killed) && throwOnExecutionError) {
		throw new Error([
			`Fallow command failed (${formatCommandLine(binary, executedArgs)})`,
			`exitCode=${result.code}${result.killed ? " killed=true" : ""}`,
			formatted.text,
		].join("\n"));
	}

	return {
		binary,
		args: executedArgs,
		result,
		formatted,
		parsed,
		projectState,
		prSummary,
		details,
		content,
	};
}

export const fallowEngine = {
	runFallowWithExecutor,
};
