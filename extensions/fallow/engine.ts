import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { buildFallowPrSummary } from "./pr-summary/build";
import { formatFallowPrSummaryText } from "./pr-summary/text";
import { detectFallowProjectState } from "./project/state";
import { formatFallowProjectStateText } from "./project/text";
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

interface ExecutedFallowCommand {
	binary: string;
	args: string[];
	result: ExecResult;
	stdout: string;
	stderr: string;	
	code: number;
	killed: boolean;
	elapsedMs: number;
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
	const execution = await executeCommand(input);
	const projectState = await detectFallowProjectState(input.cwd, execution.args);
	const parsed = parseJson(execution.stdout, execution.stderr);
	const formatted = await formatToolOutput(parsed, input.cwd, execution.code);
	const prSummary = buildFallowPrSummary(parsed.data, execution.args, execution.code);
	if (shouldThrowExecutionError(execution, input.throwOnExecutionError ?? true)) {
		throwExecutionError(execution, formatted.text);
	}
	return {
		binary: execution.binary,
		args: execution.args,
		result: execution.result,
		formatted,
		parsed,
		projectState,
		prSummary,
		details: buildFallowDetails(execution, parsed.parsed, input.cwd, formatted, projectState, prSummary),
		content: buildFallowResultContent(formatted, projectState, prSummary),
	};
}

async function executeCommand(input: FallowCommandInput): Promise<ExecutedFallowCommand> {
	const started = Date.now();
	const { pi, cwd, args, signal, timeoutSecs, executor } = input;
	const { binary, args: executedArgs, result } = await executor(pi, args, cwd, signal, timeoutSecs);
	return {
		binary,
		args: executedArgs,
		result,
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		killed: result.killed,
		elapsedMs: Date.now() - started,
	};
}

function shouldThrowExecutionError(
	execution: Pick<ExecutedFallowCommand, "code" | "killed">,
	throwOnExecutionError: boolean,
): boolean {
	if (!throwOnExecutionError) return false;
	return execution.code >= 2 || execution.killed;
}

function throwExecutionError(execution: Pick<ExecutedFallowCommand, "binary" | "args" | "code" | "killed">, formattedText: string): never {
	const reason = [
		`Fallow command failed (${formatCommandLine(execution.binary, execution.args)})`,
		`exitCode=${execution.code}${execution.killed ? " killed=true" : ""}`,
		formattedText,
	].join("\n");
	throw new Error(reason);
}

function buildFallowDetails(
	execution: Pick<ExecutedFallowCommand, "binary" | "args" | "elapsedMs" | "code">,
	parsed: boolean,
	cwd: string,
	formatted: { summary: string; overview?: FallowOverview; fullOutputPath?: string; truncated?: boolean },
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
): FallowDetails {
	return {
		command: execution.binary,
		args: execution.args,
		cwd,
		exitCode: execution.code,
		elapsedMs: execution.elapsedMs,
		parsed,
		summary: formatted.summary,
		overview: formatted.overview,
		fullOutputPath: formatted.fullOutputPath,
		truncated: formatted.truncated,
		projectState,
		prSummary,
	};
}

function buildFallowResultContent(
	formatted: { text: string },
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
): string {
	const prSummaryText = formatFallowPrSummaryText(prSummary);
	const projectStateText = formatFallowProjectStateText(projectState);
	const contentPrefix = [prSummaryText, projectStateText].filter(Boolean).join("\n");
	return contentPrefix ? `${contentPrefix}\n\n${formatted.text}` : formatted.text;
}

export const fallowEngine = {
	runFallowWithExecutor,
};
