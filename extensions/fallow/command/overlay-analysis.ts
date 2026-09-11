import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowEngine } from "../engine";
import { execFallowProcess } from "../process";
import type { ReadinessCheck, ReadinessView } from "../readiness-report";
import { createReadinessCheck } from "../readiness";
import { revalidateRuntimeCoverageRequest, type RuntimeCoverageRunRequest } from "../runtime-coverage-options";
import { createFallowRunner } from "../runner";
import { SIMILAR_CODE_DEFAULT_TIMEOUT_SECS } from "../similar-code";
import { validateSimilarCodeOptions, type SimilarCodeRunRequest } from "../similar-code-options";
import { buildFallowFinalArgs, type FallowCommandResult } from "./loader";
import { checkedWithinBudget, runtimeCoverageExecutor } from "./runtime-coverage";

export type OverlayAnalysisRequest = SimilarCodeRunRequest | RuntimeCoverageRunRequest;
export type OverlayAnalysisRun = (request: OverlayAnalysisRequest, signal: AbortSignal, progress: (label: string, output?: string) => void) => Promise<FallowCommandResult>;
interface ExecutionOptions {
	executeProcess?: typeof execFallowProcess;
	revalidateCoverage?: typeof revalidateRuntimeCoverageRequest;
	preflightMs?: number;
	timeoutSecs?: number;
}

/** Command-only execution: no installing fallback, no dialogs, no transcript dispatch. */
export function createOverlayAnalysisRun(
	pi: ExtensionAPI, mode: string, root: string, check?: ReadinessCheck, options: ExecutionOptions = {},
): OverlayAnalysisRun {
	const executeProcess = options.executeProcess ?? execFallowProcess;
	const preflightMs = options.preflightMs ?? 30_000;
	return (input, signal, progress) => executeOverlayAnalysis(pi, mode, root, check, options, executeProcess, preflightMs, input, signal, progress);
}

async function executeOverlayAnalysis(
	pi: ExtensionAPI, mode: string, root: string, check: ReadinessCheck | undefined, options: ExecutionOptions,
	executeProcess: typeof execFallowProcess, preflightMs: number, input: OverlayAnalysisRequest, signal: AbortSignal,
	progress: (label: string, output?: string) => void,
): Promise<FallowCommandResult> {
	requireTui(mode);
	const request = structuredClone(input);
	const view = analysisView(request);
	let stage = "Rechecking readiness and validated inputs…";
	progress(stage);
	const processes = new Set<Promise<unknown>>();
	const runner = createFallowRunner({ allowNpxFallback: false, executeProcess: (command, args, cwd, abort, timeout, environment) =>
		trackProcess(processes, executeProcess(command, args, cwd, abort, timeout, environment, (output) => progress(stage, output))),
	});
	const readiness = check ?? createReadinessCheck(pi, root, runner);
	await preflightAndDrain(() => checkedWithinBudget((abort) => preflight(root, request, readiness, abort, options), signal, preflightMs, "Analysis preflight timed out; no analysis started."), processes);
	signal.throwIfAborted();
	const executor = runtimeCoverageExecutor(runtimeRequest(request), runner.execute, options.revalidateCoverage, options.preflightMs);
	const timeoutSecs = analysisTimeout(view, options.timeoutSecs);
	stage = `Running ${view} locally (timeout ${timeoutSecs}s)…`;
	progress(stage, runGuidance(request));
	return fallowEngine.runFallowWithExecutor({
		pi, cwd: root, args: analysisArgs(request), signal, timeoutSecs, executor,
		throwOnExecutionError: false, preserveNavigatorDetails: true, outputDetail: "findings",
	});
}

function requireTui(mode: string): void {
	if (mode !== "tui") throw new Error("Optional analysis overlay execution requires an interactive TUI command.");
}

function runtimeRequest(request: OverlayAnalysisRequest): RuntimeCoverageRunRequest | undefined {
	return "sidecar" in request ? request : undefined;
}

function runGuidance(request: OverlayAnalysisRequest): string | undefined {
	return "sidecar" in request ? undefined : similarRunGuidance(request);
}

async function trackProcess<T>(processes: Set<Promise<unknown>>, work: Promise<T>): Promise<T> {
	processes.add(work);
	try { return await work; } finally { processes.delete(work); }
}

async function preflightAndDrain(check: () => Promise<void>, processes: Set<Promise<unknown>>): Promise<void> {
	try { await check(); } finally {
		// An abort race may settle before the readiness child closes. Keep ownership through cleanup.
		await Promise.allSettled([...processes]);
	}
}

function analysisView(request: OverlayAnalysisRequest): ReadinessView { return "sidecar" in request ? "runtime-coverage" : "similar-code"; }

function analysisArgs(request: OverlayAnalysisRequest): string[] {
	// Keep JSON on stdout, but allow cold-run guidance/progress on stderr in the live overlay.
	return "sidecar" in request ? buildFallowFinalArgs(request.commandArgs) : [
		...request.commandArgs, ...(request.values.reuseCache === true ? [] : ["--no-cache"]), "--format", "json",
	];
}

function similarRunGuidance(request: SimilarCodeRunRequest): string {
	const cache = request.values.reuseCache === true
		? "Local embedding cache enabled: this Run may read/write the user-local project cache. Cache misses may take minutes."
		: "Uncached local inference may take minutes. No embedding cache is read or written.";
	return `${cache} No download or installation is attempted.\n`;
}

async function preflight(root: string, request: OverlayAnalysisRequest, check: ReadinessCheck, signal: AbortSignal, options: ExecutionOptions): Promise<void> {
	signal.throwIfAborted();
	if ("sidecar" in request) {
		if (request.artifact.projectRoot !== await realpath(root)) throw new Error("Runtime Coverage project changed; preview again.");
		await (options.revalidateCoverage ?? revalidateRuntimeCoverageRequest)(request, signal, (_root, abort) => check("runtime-coverage", abort));
		return;
	}
	await similarPreflight(root, request, check, signal);
}

async function similarPreflight(root: string, request: SimilarCodeRunRequest, check: ReadinessCheck, signal: AbortSignal): Promise<void> {
	const readiness = await check("similar-code", signal);
	if (readiness.phase !== "ready") throw new Error(`Run blocked: ${readiness.summary} No installation was attempted.`);
	const current = await validateSimilarCodeOptions(root, request.values);
	if (!current.ok || JSON.stringify(current.request.commandArgs) !== JSON.stringify(request.commandArgs)) throw new Error("Similar Code options or scope changed; validate again before Run.");
}

function positiveTimeout(value: number): boolean { return Number.isFinite(value) && value > 0; }

function analysisTimeout(view: ReadinessView, override: number | undefined): number {
	const configured = override ?? Number(process.env.FALLOW_TIMEOUT_SECS);
	if (positiveTimeout(configured)) return configured;
	return view === "similar-code" ? SIMILAR_CODE_DEFAULT_TIMEOUT_SECS : 120;
}
