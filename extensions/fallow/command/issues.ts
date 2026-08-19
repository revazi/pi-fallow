import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { asRecord } from "../data";
import { fallowEngine } from "../engine";
import { parseJson } from "../json";
import { partitionFallowProjectIssueArgs } from "./issues-args";
import {
	buildAggregateExecutionResult,
	buildFallowProjectIssuesReport,
	type FallowChildExecution,
	type ParsedChildReport,
} from "./issues-report";
import type { FallowCommandContext } from "./types";

const MANAGED_OUTPUT_ARGS = ["--format", "json", "--quiet"] as const;
const PROJECT_ISSUES_COMMAND = "issues";

type FallowChildExecutor = (
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
) => Promise<FallowChildExecution>;

function buildFallowProjectIssuesExecutor(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	commandArgs: string[],
) {
	const timeoutSecs = Number(process.env.FALLOW_TIMEOUT_SECS || 120);
	const issueArgs = commandArgs.slice(1);
	return (signal?: AbortSignal) => fallowEngine.runFallowWithExecutor({
		pi,
		cwd: ctx.cwd,
		args: commandArgs,
		signal: signal ?? ctx.signal,
		timeoutSecs,
		executor: (executorPi, _args, cwd, executorSignal, timeout) => runFallowProjectIssueCommands(
			executorPi,
			issueArgs,
			cwd,
			executorSignal,
			timeout,
		),
		throwOnExecutionError: false,
		preserveNavigatorDetails: ctx.mode === "tui",
		outputDetail: "raw",
	});
}

async function runFallowProjectIssueCommands(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
	executeChild: FallowChildExecutor = fallowCli.execFallow,
): Promise<FallowChildExecution> {
	const partitioned = partitionFallowProjectIssueArgs(args);
	const combined = await executeChild(pi, [...MANAGED_OUTPUT_ARGS, ...partitioned.combined], cwd, signal, timeoutSecs);
	const combinedReport = parseChildReport("combined", combined);
	const securityReport = await runSecurityReport(pi, cwd, signal, timeoutSecs, partitioned.security, combinedReport, executeChild);
	const reports = collectChildReports(combinedReport, securityReport);
	const aggregate = buildFallowProjectIssuesReport(combinedReport.report, securityReport?.report, reports);
	return {
		binary: "/fallow",
		args: [PROJECT_ISSUES_COMMAND, ...args],
		result: buildAggregateExecutionResult(aggregate, reports),
	};
}

async function runSecurityReport(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
	securityArgs: string[],
	combined: ParsedChildReport,
	executeChild: FallowChildExecutor,
): Promise<ParsedChildReport | undefined> {
	if (combined.execution.result.killed) return undefined;
	if (signal?.aborted) return cancelledSecurityReport(combined.execution.binary, securityArgs);
	const execution = await executeChild(pi, ["security", ...MANAGED_OUTPUT_ARGS, ...securityArgs], cwd, signal, timeoutSecs);
	return parseChildReport("security", execution);
}

function cancelledSecurityReport(binary: string, securityArgs: string[]): ParsedChildReport {
	return {
		label: "security",
		execution: {
			binary,
			args: ["security", ...MANAGED_OUTPUT_ARGS, ...securityArgs],
			result: { stdout: "", stderr: "", code: 130, killed: true },
		},
		parseFailed: false,
	};
}

function parseChildReport(label: ParsedChildReport["label"], execution: FallowChildExecution): ParsedChildReport {
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	const report = parsed.parsed ? asRecord(parsed.data) : undefined;
	return { label, execution, report, parseFailed: !report };
}

function collectChildReports(combined: ParsedChildReport, security: ParsedChildReport | undefined): ParsedChildReport[] {
	if (!security) return [combined];
	return [combined, security];
}

export const fallowProjectIssues = {
	buildExecutor: buildFallowProjectIssuesExecutor,
	buildReport: buildFallowProjectIssuesReport,
	partitionArgs: partitionFallowProjectIssueArgs,
	runCommands: runFallowProjectIssueCommands,
};
