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

type ProjectIssueSchedule = "concurrent" | "sequential";

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
		preserveNavigatorDetails: true,
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
	schedule: ProjectIssueSchedule = "concurrent",
): Promise<FallowChildExecution> {
	const partitioned = partitionFallowProjectIssueArgs(args);
	const [combined, security] = await runChildAnalyses(
		pi, cwd, signal, timeoutSecs, partitioned, executeChild, schedule,
	);
	const reports = [parseChildReport("combined", combined), parseChildReport("security", security)];
	const aggregate = buildFallowProjectIssuesReport(reports[0]!.report, reports[1]!.report, reports);
	return {
		binary: "/fallow",
		args: [PROJECT_ISSUES_COMMAND, ...args],
		result: buildAggregateExecutionResult(aggregate, reports),
	};
}

async function runChildAnalyses(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
	partitioned: ReturnType<typeof partitionFallowProjectIssueArgs>,
	executeChild: FallowChildExecutor,
	schedule: ProjectIssueSchedule,
): Promise<[FallowChildExecution, FallowChildExecution]> {
	const combinedArgs = [...MANAGED_OUTPUT_ARGS, ...partitioned.combined];
	const securityArgs = ["security", ...MANAGED_OUTPUT_ARGS, ...partitioned.security];
	if (schedule === "sequential") {
		return runSequentialChildren(pi, cwd, signal, timeoutSecs, combinedArgs, securityArgs, executeChild);
	}
	return runConcurrentChildren(pi, cwd, signal, timeoutSecs, combinedArgs, securityArgs, executeChild);
}

async function runSequentialChildren(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
	combinedArgs: string[],
	securityArgs: string[],
	executeChild: FallowChildExecutor,
): Promise<[FallowChildExecution, FallowChildExecution]> {
	const combined = await executeChild(pi, combinedArgs, cwd, signal, timeoutSecs);
	if (combined.result.killed || signal?.aborted) return [combined, cancelledExecution(combined.binary, securityArgs)];
	return [combined, await executeChild(pi, securityArgs, cwd, signal, timeoutSecs)];
}

async function runConcurrentChildren(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
	combinedArgs: string[],
	securityArgs: string[],
	executeChild: FallowChildExecutor,
): Promise<[FallowChildExecution, FallowChildExecution]> {
	const controller = new AbortController();
	const relayAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", relayAbort, { once: true });
	const children = [combinedArgs, securityArgs].map((childArgs) => Promise.resolve().then(() => executeObservedChild(
		pi, childArgs, cwd, controller, timeoutSecs, executeChild,
	)));
	try {
		return await Promise.all(children) as [FallowChildExecution, FallowChildExecution];
	} catch (error) {
		controller.abort();
		await Promise.allSettled(children);
		throw error;
	} finally {
		signal?.removeEventListener("abort", relayAbort);
	}
}

async function executeObservedChild(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	controller: AbortController,
	timeoutSecs: number,
	executeChild: FallowChildExecutor,
): Promise<FallowChildExecution> {
	const execution = await executeChild(pi, args, cwd, controller.signal, timeoutSecs);
	if (execution.result.killed) controller.abort();
	return execution;
}

function cancelledExecution(binary: string, args: string[]): FallowChildExecution {
	return { binary, args, result: { stdout: "", stderr: "", code: 130, killed: true } };
}

function parseChildReport(label: ParsedChildReport["label"], execution: FallowChildExecution): ParsedChildReport {
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	const report = parsed.parsed ? asRecord(parsed.data) : undefined;
	return { label, execution, report, parseFailed: !report };
}

export const fallowProjectIssues = {
	buildExecutor: buildFallowProjectIssuesExecutor,
	buildReport: buildFallowProjectIssuesReport,
	partitionArgs: partitionFallowProjectIssueArgs,
	runCommands: runFallowProjectIssueCommands,
};
