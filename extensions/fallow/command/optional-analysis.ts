import { isAbsolute, relative, resolve } from "node:path";
import { parseJson } from "../json";
import {
	canonicalDestination, parseCoverageSetupPlan, parseSimilarCodeCapability,
	runtimeCoverageInstallArgs, runtimeCoverageSetupPreview, similarCodeSetupPreview, FALLOW_COV_VERSION,
	type OptionalAnalysisState, type RuntimeCoverageCapability, type SimilarCodeCapability,
} from "../optional-analysis";
import { SIMILAR_CODE_DEFAULT_TIMEOUT_SECS } from "../similar-code";

interface ProcessResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
	terminationReason?: string;
}
interface RawCommandResult { result: ProcessResult }
export interface OptionalAnalysisDependencies {
	runFallow(args: string[], label: string, timeoutSecs?: number): Promise<RawCommandResult | null>;
	runProcess(command: string, args: string[], label: string, timeoutSecs?: number): Promise<ProcessResult | null>;
	inspectRuntime(plan?: unknown): Promise<RuntimeCoverageCapability>;
	saveSetupOutput(stdout: string, stderr: string): Promise<string>;
}
interface SetupContext { cwd: string; confirm(title: string, preview: string): Promise<boolean> }

/** Safety workflow only. The sole production caller supplies the mounted overlay's confirmation. */
export async function runOptionalSetup(
	view: "similar-code" | "runtime-coverage", mode: string, ctx: SetupContext,
	state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	if (mode !== "tui") throw new Error("Optional setup requires an interactive TUI command.");
	if (view === "similar-code") await setupSimilarCode(ctx, state, dependencies);
	else await setupRuntimeCoverage(ctx, state, dependencies);
}

async function refreshSimilarCode(state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<SimilarCodeCapability | undefined> {
	const execution = await dependencies.runFallow(["similar-code", "status", "--format", "json", "--quiet"], "Checking Similar Code readiness...", 120);
	if (!execution) return setNotice(state, "Similar Code status cancelled; no setup was performed.");
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	state.similarCode = parseSimilarCodeCapability(parsed.parsed ? parsed.data : undefined);
	if (setupCommandFailed(execution.result)) state.similarCode = { ...state.similarCode, phase: "error", problem: commandFailure(execution.result) };
	state.notice = `Similar Code status: ${state.similarCode.phase}.`;
	return state.similarCode;
}

async function setupSimilarCode(ctx: SetupContext, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<void> {
	state.completeSetupOutputPath = undefined;
	const preview = await confirmedSimilarCodePreview(ctx, state, dependencies);
	if (!preview) return;
	const current = await refreshSimilarCode(state, dependencies);
	if (!sameSimilarCodePreview(preview, current)) return setNotice(state, "Similar Code status changed after preview; setup was stopped. Review Status and preview again.");
	if (!await safeModelDestination(ctx.cwd, preview, state)) return;
	await executeSimilarCodeSetup(state, dependencies);
}

async function confirmedSimilarCodePreview(ctx: SetupContext, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<SimilarCodeCapability | undefined> {
	const preview = await eligibleSimilarCodePreview(state, dependencies);
	if (!preview) return undefined;
	if (!await safeModelDestination(ctx.cwd, preview, state)) return undefined;
	const confirmed = await ctx.confirm("Set up Similar Code?", similarCodeSetupPreview(preview));
	return confirmed ? preview : setNotice(state, "Similar Code setup declined; no download was started.");
}

async function eligibleSimilarCodePreview(state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<SimilarCodeCapability | undefined> {
	const preview = await refreshSimilarCode(state, dependencies);
	if (!preview) return undefined;
	if (preview.phase === "ready") return setNotice(state, "Similar Code is already ready; setup did not run.");
	if (preview.phase !== "missing") return setNotice(state, `Similar Code setup is blocked for ${preview.phase} state. Review the status remediation; Pi Fallow will not overwrite or clear the model cache.`);
	return preview;
}

async function safeModelDestination(root: string, preview: SimilarCodeCapability, state: OptionalAnalysisState): Promise<boolean> {
	if (!isAbsolute(preview.cacheDir) || isPathWithin(await canonicalDestination(root), await canonicalDestination(preview.cacheDir))) {
		setNotice(state, "Similar Code setup blocked: model destination must be outside the project in the user-local Fallow cache.");
		return false;
	}
	return true;
}
function sameSimilarCodePreview(preview: SimilarCodeCapability, current: SimilarCodeCapability | undefined): boolean {
	return current?.phase === preview.phase && current?.fingerprint === preview.fingerprint;
}

async function executeSimilarCodeSetup(state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<void> {
	const setup = await dependencies.runFallow(
		["similar-code", "setup", "--local", "--yes", "--format", "json", "--quiet"],
		"Downloading and verifying the pinned Similar Code model...", SIMILAR_CODE_DEFAULT_TIMEOUT_SECS,
	);
	await persistSetupOutput(setup, state, dependencies);
	await refreshSimilarCode(state, dependencies);
	setNotice(state, setupOutcome("Similar Code", setup?.result ?? null, state.similarCode?.phase, "Similar Code setup completed and pinned model integrity was verified."));
}

async function refreshRuntimeCoverage(state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<RuntimeCoverageCapability | undefined> {
	const execution = await dependencies.runFallow(["coverage", "setup", "--json", "--root", "."], "Reading the runtime coverage setup plan...", 120);
	if (!execution) return setNotice(state, "Runtime Coverage status cancelled; no setup was performed.");
	return applyRuntimeCoverageStatus(execution, state, dependencies);
}
async function applyRuntimeCoverageStatus(execution: RawCommandResult, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<RuntimeCoverageCapability> {
	try {
		state.runtimeCoverage = await dependencies.inspectRuntime(runtimePlanFromExecution(execution));
		state.notice = `Runtime Coverage status: ${state.runtimeCoverage.phase}.`;
	} catch (error) {
		const inspected = await dependencies.inspectRuntime();
		state.runtimeCoverage = { ...inspected, phase: "error", problem: errorMessage(error) };
		state.notice = "Runtime Coverage status failed; no setup was performed.";
	}
	return state.runtimeCoverage;
}
function runtimePlanFromExecution(execution: RawCommandResult): unknown {
	if (setupCommandFailed(execution.result)) throw new Error(commandFailure(execution.result));
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	return parseCoverageSetupPlan(parsed.parsed ? parsed.data : undefined);
}

async function setupRuntimeCoverage(ctx: SetupContext, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<void> {
	state.completeSetupOutputPath = undefined;
	const preview = await confirmedRuntimeCoveragePreview(ctx, state, dependencies);
	if (!preview) return;
	const current = await refreshRuntimeCoverage(state, dependencies);
	if (!sameRuntimePreview(preview, current)) return setNotice(state, "Runtime Coverage status or Fallow setup plan changed after preview; installation was stopped. Review Status and preview again.");
	if (runtimeSetupBlocked(await canonicalDestination(ctx.cwd), current!, state)) return;
	await executeRuntimeCoverageSetup(preview, state, dependencies);
}
async function confirmedRuntimeCoveragePreview(ctx: SetupContext, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<RuntimeCoverageCapability | undefined> {
	const preview = await eligibleRuntimeCoveragePreview(ctx.cwd, state, dependencies);
	if (!preview) return undefined;
	const confirmed = await ctx.confirm("Install local Runtime Coverage sidecar?", runtimeCoverageSetupPreview(preview));
	return confirmed ? preview : setNotice(state, "Runtime Coverage setup declined; no installation was started.");
}
async function eligibleRuntimeCoveragePreview(projectRoot: string, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<RuntimeCoverageCapability | undefined> {
	const preview = await refreshRuntimeCoverage(state, dependencies);
	if (!preview) return undefined;
	if (preview.phase === "ready") return setNotice(state, "Runtime Coverage sidecar is already ready; setup did not run.");
	if (runtimeSetupBlocked(await canonicalDestination(projectRoot), preview, state)) return undefined;
	return preview;
}
function runtimeSetupBlocked(projectRoot: string, preview: RuntimeCoverageCapability, state: OptionalAnalysisState): boolean {
	if (isPathWithin(projectRoot, preview.destination)) {
		setNotice(state, "Runtime Coverage setup is blocked because the managed-tools destination resolves inside the project. Choose a user-global PI_FALLOW_TOOLS_DIR and check Status again.");
		return true;
	}
	if (preview.phase !== "missing") {
		setNotice(state, `Runtime Coverage setup is blocked for ${preview.phase} state. Remove or repair the displayed managed-cache destination manually; Pi Fallow will not clear it.`);
		return true;
	}
	return false;
}
async function executeRuntimeCoverageSetup(preview: RuntimeCoverageCapability, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<void> {
	const install = await dependencies.runProcess("npm", runtimeCoverageInstallArgs(preview.destination), `Installing @fallow-cli/fallow-cov@${FALLOW_COV_VERSION} in the Pi Fallow managed cache...`, 300);
	await persistSetupOutput(install ? { result: install } : null, state, dependencies);
	await refreshRuntimeCoverage(state, dependencies);
	setNotice(state, setupOutcome("Runtime Coverage", install, state.runtimeCoverage?.phase, "Runtime Coverage sidecar installed in the managed cache; exact package metadata and detached signature presence were verified."));
}
function setupOutcome(label: string, result: ProcessResult | null, phase: string | undefined, success: string): string {
	if (!result) return `${label} setup was cancelled; Status was rechecked for partial state.`;
	if (setupCommandFailed(result)) return `${label} setup failed: ${commandFailure(result)}`;
	if (phase !== "ready") return `${label} setup completed without verified readiness. Review Status remediation.`;
	return success;
}
function sameRuntimePreview(preview: RuntimeCoverageCapability, current: RuntimeCoverageCapability | undefined): boolean {
	return current?.phase === "missing" && current.destination === preview.destination && current.planFingerprint === preview.planFingerprint;
}
async function persistSetupOutput(execution: RawCommandResult | null, state: OptionalAnalysisState, dependencies: OptionalAnalysisDependencies): Promise<void> {
	if (!execution) return;
	try { state.completeSetupOutputPath = await dependencies.saveSetupOutput(execution.result.stdout, execution.result.stderr); }
	catch { state.completeSetupOutputPath = undefined; }
}
function isPathWithin(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function setNotice(state: OptionalAnalysisState, notice: string): undefined {
	state.notice = notice.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
	return undefined;
}
function setupCommandFailed(result: ProcessResult): boolean { return result.code !== 0 || result.killed === true; }
function commandFailure(result: ProcessResult): string {
	const message = [result.terminationReason, result.stderr.trim(), result.stdout.trim()].find(Boolean) ?? `exit ${result.code}`;
	return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
