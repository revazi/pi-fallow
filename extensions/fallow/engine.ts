import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFallowPrSummary } from "./pr-summary/build";
import { formatFallowPrSummaryText } from "./pr-summary/text";
import { detectFallowProjectState } from "./project/state";
import { formatFallowProjectStateText } from "./project/text";
import { parseJson } from "./json";
import { formatToolOutput } from "./output";
import type { FallowTerminationReason } from "./process";
import type { FallowDetails, FallowOutputDetail, FallowOverview, FallowPrSummary, FallowProjectState } from "./types";

interface FallowExecutor {
	(pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<{
		binary: string;
		args: string[];
		result: {
			stdout: string;
			stderr: string;
			code: number;
			killed?: boolean;
			terminationReason?: FallowTerminationReason;
		};
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
	preserveNavigatorDetails?: boolean;
	outputDetail?: FallowOutputDetail;
}

interface ExecutedFallowCommand {
	binary: string;
	args: string[];
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	terminationReason?: FallowTerminationReason;
	elapsedMs: number;
}

interface FallowCommandResult {
	binary: string;
	args: string[];
	execution: {
		code: number;
		killed: boolean;
		terminationReason?: FallowTerminationReason;
	};
	reportMetadata: FallowReportMetadata;
	formatted: {
		summary: string;
		overview?: FallowOverview;
		fullOutputPath?: string;
		truncated?: boolean;
	};
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
	const projectStatePromise = detectFallowProjectState(input.cwd, execution.args);
	const parsed = parseJson(execution.stdout, execution.stderr);
	const formattedPromise = formatToolOutput(parsed, input.cwd, execution.code, input.preserveNavigatorDetails, input.outputDetail);
	const prSummary = buildFallowPrSummary(parsed.data, execution.args, execution.code);
	const [projectState, formattedOutput] = await Promise.all([projectStatePromise, formattedPromise]);
	if (shouldThrowExecutionError(execution, input.throwOnExecutionError ?? true)) {
		throwExecutionError(execution, formattedOutput.errorText);
	}
	const formatted = retainFormattedMetadata(formattedOutput);
	return {
		binary: execution.binary,
		args: execution.args,
		execution: {
			code: execution.code,
			killed: execution.killed,
			...(execution.terminationReason ? { terminationReason: execution.terminationReason } : {}),
		},
		reportMetadata: buildFallowReportMetadata(parsed.data, parsed.parsed, execution),
		formatted,
		projectState,
		prSummary,
		details: buildFallowDetails(execution, parsed.parsed, input.cwd, formatted, projectState, prSummary),
		content: buildFallowResultContent(formattedOutput.text, projectState, prSummary, execution.terminationReason),
	};
}

async function executeCommand(input: FallowCommandInput): Promise<ExecutedFallowCommand> {
	const started = Date.now();
	const { pi, cwd, args, signal, timeoutSecs, executor } = input;
	const { binary, args: executedArgs, result } = await executor(pi, args, cwd, signal, timeoutSecs);
	return {
		binary,
		args: executedArgs,
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		killed: result.killed === true,
		terminationReason: result.terminationReason,
		elapsedMs: Date.now() - started,
	};
}

interface FallowReportMetadata {
	kind?: string;
	fallowVersion?: string;
	schemaVersion?: string;
	complete: boolean;
	completenessReason?: string;
}

function buildFallowReportMetadata(
	data: unknown,
	parsed: boolean,
	execution: Pick<ExecutedFallowCommand, "code" | "killed" | "terminationReason">,
): FallowReportMetadata {
	const root = reportRoot(data);
	const completenessReason = reportIncompleteReason(root, parsed, execution);
	return {
		...reportIdentity(root),
		complete: completenessReason === undefined,
		...optionalCompletenessReason(completenessReason),
	};
}

function reportRoot(data: unknown): Record<string, unknown> | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	return data as Record<string, unknown>;
}

function reportIdentity(root: Record<string, unknown> | undefined): Partial<FallowReportMetadata> {
	return {
		...optionalStringField("kind", stringValue(root?.kind)),
		...optionalStringField("fallowVersion", stringValue(root?.version)),
		...optionalStringField("schemaVersion", scalarValue(root?.schema_version)),
	};
}

function optionalStringField(key: string, value: string | undefined): Record<string, string> {
	return value ? { [key]: value } : {};
}

function optionalCompletenessReason(value: string | undefined): Pick<FallowReportMetadata, "completenessReason"> | Record<string, never> {
	return value ? { completenessReason: value } : {};
}

function reportIncompleteReason(
	root: Record<string, unknown> | undefined,
	parsed: boolean,
	execution: Pick<ExecutedFallowCommand, "code" | "killed" | "terminationReason">,
): string | undefined {
	return executionIncompleteReason(execution) ?? contentIncompleteReason(root, parsed);
}

function executionIncompleteReason(
	execution: Pick<ExecutedFallowCommand, "code" | "killed" | "terminationReason">,
): string | undefined {
	if (execution.terminationReason) return execution.terminationReason;
	if (execution.killed) return "cancelled";
	return execution.code >= 2 ? `exit-${execution.code}` : undefined;
}

function contentIncompleteReason(root: Record<string, unknown> | undefined, parsed: boolean): string | undefined {
	return structureIncompleteReason(root, parsed) ?? structuredContentIncompleteReason(root!);
}

function structureIncompleteReason(root: Record<string, unknown> | undefined, parsed: boolean): string | undefined {
	return parsed && root ? undefined : "unstructured-report";
}

function structuredContentIncompleteReason(root: Record<string, unknown>): string | undefined {
	if (root.error) return "report-error";
	return explicitCompletionReason(root.completion) ?? identityCompletenessReason(root);
}

function explicitCompletionReason(value: unknown): string | undefined {
	const status = completionStatus(value);
	if (!status || status === "complete") return undefined;
	return `completion-${status}`;
}

function completionStatus(value: unknown): string | undefined {
	return stringValue(recordValue(value)?.status);
}

function identityCompletenessReason(root: Record<string, unknown>): string | undefined {
	return nonCompleteIdentityReason(recordValue(root.identity), "identity")
		?? typeAwareCompletenessReason(recordValue(root._meta));
}

function typeAwareCompletenessReason(metadata: Record<string, unknown> | undefined): string | undefined {
	const typeAware = recordValue(metadata?.type_aware);
	return nonCompleteIdentityReason(recordValue(typeAware?.identity), "type-aware");
}

function nonCompleteIdentityReason(identity: Record<string, unknown> | undefined, label: string): string | undefined {
	const completeness = stringValue(identity?.completeness);
	if (!completeness || completeness === "complete") return undefined;
	return `${label}-${completeness}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value || undefined;
}

function scalarValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function shouldThrowExecutionError(
	execution: Pick<ExecutedFallowCommand, "code" | "killed">,
	throwOnExecutionError: boolean,
): boolean {
	if (!throwOnExecutionError) return false;
	return execution.code >= 2 || execution.killed;
}

function throwExecutionError(
	execution: Pick<ExecutedFallowCommand, "binary" | "args" | "code" | "killed" | "terminationReason">,
	formattedText: string,
): never {
	const termination = execution.terminationReason ? ` termination=${execution.terminationReason}` : "";
	const reason = [
		`Fallow command failed (${formatCommandLine(execution.binary, execution.args)})`,
		`exitCode=${execution.code}${execution.killed ? " killed=true" : ""}${termination}`,
		formattedText,
	].join("\n");
	throw new Error(reason);
}

function buildFallowDetails(
	execution: Pick<ExecutedFallowCommand, "binary" | "args" | "elapsedMs" | "code" | "terminationReason">,
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
		...(execution.terminationReason ? { terminationReason: execution.terminationReason } : {}),
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

function retainFormattedMetadata(formatted: {
	summary: string;
	overview?: FallowOverview;
	fullOutputPath?: string;
	truncated?: boolean;
}): FallowCommandResult["formatted"] {
	return {
		summary: formatted.summary,
		overview: formatted.overview,
		fullOutputPath: formatted.fullOutputPath,
		truncated: formatted.truncated,
	};
}

function buildFallowResultContent(
	formattedText: string,
	projectState: FallowProjectState,
	prSummary: FallowPrSummary | undefined,
	terminationReason: FallowTerminationReason | undefined,
): string {
	const terminationText = formatTerminationText(terminationReason);
	const prSummaryText = formatFallowPrSummaryText(prSummary);
	const projectStateText = formatFallowProjectStateText(projectState);
	const contentPrefix = [terminationText, prSummaryText, projectStateText].filter(Boolean).join("\n");
	return contentPrefix ? `${contentPrefix}\n\n${formattedText}` : formattedText;
}

function formatTerminationText(reason: FallowTerminationReason | undefined): string {
	if (reason === "timed-out") return "Fallow execution timed out before completion.";
	if (reason === "cancelled") return "Fallow execution was cancelled before completion.";
	return "";
}

export const fallowEngine = {
	runFallowWithExecutor,
};
