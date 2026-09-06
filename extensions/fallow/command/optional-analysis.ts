import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCli } from "../cli";
import { parseJson } from "../json";
import {
	artifactDisplayName,
	capabilityLabel,
	createOptionalAnalysisState,
	inspectRuntimeCoverageCapability,
	parseCoverageSetupPlan,
	parseSimilarCodeCapability,
	resolveLocalArtifact,
	saveOptionalSetupOutput,
	runtimeCoverageInstallArgs,
	runtimeCoverageSetupPreview,
	runtimeCoverageStatusLines,
	similarCodeSetupPreview,
	similarCodeStatusLines,
	FALLOW_COV_VERSION,
	type CapabilityPhase,
	type OptionalAnalysisState,
	type RuntimeCoverageCapability,
	type SimilarCodeCapability,
} from "../optional-analysis";
import { SIMILAR_CODE_DEFAULT_TIMEOUT_SECS } from "../similar-code";
import type { FallowNavigatorResult } from "../types";
import { runFallowTaskWithLoader } from "./loader";
import type { FallowCommandContext } from "./types";

interface RawCommandResult {
	result: {
		stdout: string;
		stderr: string;
		code: number;
		killed?: boolean;
		terminationReason?: string;
	};
}

interface ProcessResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
	terminationReason?: string;
}

export interface OptionalAnalysisDependencies {
	runFallow(args: string[], label: string, timeoutSecs?: number): Promise<RawCommandResult | null>;
	runProcess(command: string, args: string[], label: string, timeoutSecs?: number): Promise<ProcessResult | null>;
	inspectRuntime(plan?: unknown): Promise<RuntimeCoverageCapability>;
	resolveArtifact(path: string): Promise<string>;
	saveSetupOutput(stdout: string, stderr: string): Promise<string>;
}

interface OptionalChoice {
	id: "similar-status" | "similar-setup" | "similar-run" | "coverage-status" | "coverage-setup" | "coverage-run" | "back";
	label: string;
}

export async function runOptionalAnalysisWorkflow(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: OptionalAnalysisState = createOptionalAnalysisState(),
	providedDependencies?: OptionalAnalysisDependencies,
): Promise<FallowNavigatorResult | null> {
	if (ctx.mode !== "tui") return null;
	return runTuiOptionalAnalysis(ctx, state, providedDependencies ?? createDependencies(pi, ctx));
}

async function runTuiOptionalAnalysis(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<FallowNavigatorResult | null> {
	while (true) {
		const choices = buildOptionalChoices(state);
		const selected = await ctx.ui.select(buildPanelTitle(state), choices.map((choice) => choice.label));
		const choice = actionableChoice(choices.find((entry) => entry.label === selected));
		if (!choice) return null;
		const result = await applyChoice(choice.id, ctx, state, dependencies);
		if (result) return result;
	}
}

function actionableChoice(choice: OptionalChoice | undefined): OptionalChoice | undefined {
	if (!choice || choice.id === "back") return undefined;
	return choice;
}

function buildOptionalChoices(state: OptionalAnalysisState): OptionalChoice[] {
	const similar = stateCapabilityLabel(state.similarCode);
	const coverage = stateCapabilityLabel(state.runtimeCoverage);
	return [
		{ id: "similar-status", label: `Similar Code · Status [${similar}]` },
		{ id: "similar-setup", label: "Similar Code · Setup (preview + confirmation)" },
		{ id: "similar-run", label: `Similar Code · Run${runAvailabilityLabel(similar)}` },
		{ id: "coverage-status", label: `Runtime Coverage · Status [${coverage}]` },
		{ id: "coverage-setup", label: "Runtime Coverage · Setup (local sidecar preview + confirmation)" },
		{ id: "coverage-run", label: `Runtime Coverage · Run local artifact${runAvailabilityLabel(coverage)}` },
		{ id: "back", label: "Back to Fallow results" },
	];
}

function stateCapabilityLabel(capability: { phase: CapabilityPhase } | undefined): string {
	return capabilityLabel(capability?.phase);
}

function runAvailabilityLabel(phase: string): string {
	return phase === "ready" ? "" : " (requires ready status)";
}

function buildPanelTitle(state: OptionalAnalysisState): string {
	return [
		"Optional analysis — Status / Setup / Run",
		"Opening this panel or selecting Status never installs anything. Setup always shows a separate preview and confirmation.",
		...similarCodeStatusLines(state.similarCode),
		...runtimeCoverageStatusLines(state.runtimeCoverage),
		`Similar Code options: ${similarCodeOptionsLabel(state.similarCodeArgs)}`,
		`Runtime artifact: ${artifactDisplayName(state.artifactPath)}`,
		...completeSetupOutputLines(state.completeSetupOutputPath),
		...noticeLines(state.notice),
	].join("\n");
}

function similarCodeOptionsLabel(args: string[] | undefined): string {
	if (!args?.length) return "project defaults";
	return args.join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
}

function completeSetupOutputLines(path: string | undefined): string[] {
	return path ? [`Complete setup output: ${artifactDisplayName(path)}`] : [];
}

function noticeLines(notice: string | undefined): string[] {
	return notice ? [`Result: ${notice}`] : [];
}

async function applyChoice(
	choice: OptionalChoice["id"],
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<FallowNavigatorResult | null> {
	state.notice = undefined;
	const handlers: Record<OptionalChoice["id"], () => Promise<FallowNavigatorResult | null>> = {
		"similar-status": () => refreshSimilarCode(state, dependencies).then(() => null),
		"similar-setup": () => setupSimilarCode(ctx, state, dependencies).then(() => null),
		"similar-run": () => runSimilarCode(ctx, state, dependencies),
		"coverage-status": () => refreshRuntimeCoverage(state, dependencies).then(() => null),
		"coverage-setup": () => setupRuntimeCoverage(ctx, state, dependencies).then(() => null),
		"coverage-run": () => runRuntimeCoverage(ctx, state, dependencies),
		back: async () => null,
	};
	return handlers[choice]();
}

async function refreshSimilarCode(
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<SimilarCodeCapability | undefined> {
	const execution = await dependencies.runFallow(
		["similar-code", "status", "--format", "json", "--quiet"],
		"Checking Similar Code readiness...",
		120,
	);
	if (!execution) {
		state.notice = "Similar Code status cancelled; no setup was performed.";
		return undefined;
	}
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	state.similarCode = parseSimilarCodeCapability(parsed.parsed ? parsed.data : undefined);
	if (execution.result.code >= 2) state.similarCode = { ...state.similarCode, phase: "error", problem: commandFailure(execution.result) };
	state.notice = `Similar Code status: ${state.similarCode.phase}.`;
	return state.similarCode;
}

async function setupSimilarCode(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	state.completeSetupOutputPath = undefined;
	const preview = await confirmedSimilarCodePreview(ctx, state, dependencies);
	if (!preview) return;
	const current = await refreshSimilarCode(state, dependencies);
	if (!sameSimilarCodePreview(preview, current)) return setNotice(state, "Similar Code status changed after preview; setup was stopped. Review Status and preview again.");
	await executeSimilarCodeSetup(state, dependencies);
}

async function confirmedSimilarCodePreview(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<SimilarCodeCapability | undefined> {
	const preview = await eligibleSimilarCodePreview(state, dependencies);
	if (!preview) return undefined;
	const confirmed = await ctx.ui.confirm("Set up Similar Code?", similarCodeSetupPreview(preview));
	return confirmed ? preview : setNotice(state, "Similar Code setup declined; no download was started.");
}

async function eligibleSimilarCodePreview(
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<SimilarCodeCapability | undefined> {
	const preview = await refreshSimilarCode(state, dependencies);
	if (!preview) return undefined;
	if (preview.phase === "ready") return setNotice(state, "Similar Code is already ready; setup did not run.");
	if (preview.phase !== "missing") return setNotice(state, `Similar Code setup is blocked for ${preview.phase} state. Review the status remediation; Pi Fallow will not overwrite or clear the model cache.`);
	return preview;
}

function sameSimilarCodePreview(preview: SimilarCodeCapability, current: SimilarCodeCapability | undefined): boolean {
	return current?.fingerprint === preview.fingerprint;
}

async function executeSimilarCodeSetup(
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	const setup = await dependencies.runFallow(
		["similar-code", "setup", "--local", "--yes", "--format", "json", "--quiet"],
		"Downloading and verifying the pinned Similar Code model...",
		SIMILAR_CODE_DEFAULT_TIMEOUT_SECS,
	);
	await persistSetupOutput(setup, state, dependencies);
	await refreshSimilarCode(state, dependencies);
	if (!setup) return setNotice(state, "Similar Code setup was cancelled; Status was rechecked for partial state.");
	if (setup.result.code >= 2) return setNotice(state, `Similar Code setup failed: ${commandFailure(setup.result)}`);
	if (!similarCodeIsReady(state)) return setNotice(state, "Similar Code setup completed without verified readiness. Review Status remediation.");
	setNotice(state, "Similar Code setup completed and pinned model integrity was verified.");
}

function similarCodeIsReady(state: OptionalAnalysisState): boolean {
	return state.similarCode?.phase === "ready";
}

async function runSimilarCode(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<FallowNavigatorResult | null> {
	const status = await refreshSimilarCode(state, dependencies);
	if (!similarCodeReadyForRun(status, state)) return null;
	const args = await selectSimilarCodeArgs(ctx, state);
	if (!args) return null;
	const current = await refreshSimilarCode(state, dependencies);
	if (!sameSimilarCodePreview(status, current)) {
		setNotice(state, "Similar Code status changed while selecting Run options; Run was stopped. Review Status and choose the options again.");
		return null;
	}
	return { type: "forward", label: "Run Similar Code", commandArgs: ["similar-code", ...args] };
}

function similarCodeReadyForRun(
	status: SimilarCodeCapability | undefined,
	state: OptionalAnalysisState,
): status is SimilarCodeCapability {
	if (status?.phase === "ready") return true;
	setNotice(state, "Similar Code Run is disabled until Status reports a ready, integrity-verified pinned model.");
	return false;
}

async function selectSimilarCodeArgs(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
): Promise<string[] | undefined> {
	const inputs = await promptSimilarCodeArgs(ctx, state);
	if (!inputs) return undefined;
	try {
		state.similarCodeArgs = buildSimilarCodeArgs(ctx.cwd, inputs.scope, inputs.threshold, inputs.top);
		return state.similarCodeArgs;
	} catch (error) {
		return setNotice(state, `Similar Code Run options are invalid: ${errorMessage(error)}`);
	}
}

async function promptSimilarCodeArgs(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
): Promise<{ scope: string; threshold: string; top: string } | undefined> {
	const scope = await ctx.ui.input("Similar Code scope", "Project-relative file, or blank for the whole project");
	if (scope === undefined) return setNotice(state, "Similar Code Run cancelled before choosing scope.");
	const threshold = await ctx.ui.input("Similar Code threshold", "0..1, or blank for the Fallow default");
	if (threshold === undefined) return setNotice(state, "Similar Code Run cancelled before choosing a threshold.");
	const top = await ctx.ui.input("Similar Code result limit", "Positive integer, or blank for the Fallow default");
	if (top === undefined) return setNotice(state, "Similar Code Run cancelled before choosing a result limit.");
	return { scope, threshold, top };
}

function buildSimilarCodeArgs(projectRoot: string, scope: string, threshold: string, top: string): string[] {
	return [
		...similarScopeArgs(projectRoot, scope.trim()),
		...numericOptionArgs("--threshold", threshold.trim(), 0, 1, false),
		...numericOptionArgs("--top", top.trim(), 1, 100_000, true),
	];
}

function similarScopeArgs(projectRoot: string, scope: string): string[] {
	if (!scope) return [];
	const target = resolve(projectRoot, scope);
	const invalid = [isAbsolute(scope), /^[a-z][a-z0-9+.-]*:\/\//iu.test(scope), scope.startsWith("-"), /[\u0000-\u001f\u007f-\u009f]/u.test(scope), !isPathWithin(projectRoot, target)].some(Boolean);
	if (invalid) throw new Error("scope must be a project-relative local path");
	const projectPath = relative(resolve(projectRoot), target);
	if (!projectPath) throw new Error("leave scope blank to analyze the whole project");
	return ["--file", projectPath];
}

function numericOptionArgs(flag: string, value: string, minimum: number, maximum: number, integer: boolean): string[] {
	if (!value) return [];
	const parsed = Number(value);
	const valid = [Number.isFinite(parsed), parsed >= minimum, parsed <= maximum, validNumberKind(parsed, integer)].every(Boolean);
	if (!valid) throw new Error(`${flag} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}`);
	return [flag, value];
}

function validNumberKind(value: number, integer: boolean): boolean {
	return integer ? Number.isInteger(value) : true;
}

async function refreshRuntimeCoverage(
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<RuntimeCoverageCapability | undefined> {
	const execution = await dependencies.runFallow(
		["coverage", "setup", "--json", "--root", "."],
		"Reading the runtime coverage setup plan...",
		120,
	);
	if (!execution) {
		state.notice = "Runtime Coverage status cancelled; no setup was performed.";
		return undefined;
	}
	return applyRuntimeCoverageStatus(execution, state, dependencies);
}

async function applyRuntimeCoverageStatus(
	execution: RawCommandResult,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<RuntimeCoverageCapability> {
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
	if (execution.result.code >= 2) throw new Error(commandFailure(execution.result));
	const parsed = parseJson(execution.result.stdout, execution.result.stderr);
	return parseCoverageSetupPlan(parsed.parsed ? parsed.data : undefined);
}

async function setupRuntimeCoverage(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	state.completeSetupOutputPath = undefined;
	const preview = await confirmedRuntimeCoveragePreview(ctx, state, dependencies);
	if (!preview) return;
	const current = await refreshRuntimeCoverage(state, dependencies);
	if (!sameRuntimePreview(preview, current)) return setNotice(state, "Runtime Coverage status or Fallow setup plan changed after preview; installation was stopped. Review Status and preview again.");
	await executeRuntimeCoverageSetup(preview, state, dependencies);
}

async function confirmedRuntimeCoveragePreview(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<RuntimeCoverageCapability | undefined> {
	const preview = await eligibleRuntimeCoveragePreview(ctx.cwd, state, dependencies);
	if (!preview) return undefined;
	const confirmed = await ctx.ui.confirm("Install local Runtime Coverage sidecar?", runtimeCoverageSetupPreview(preview));
	return confirmed ? preview : setNotice(state, "Runtime Coverage setup declined; no installation was started.");
}

async function eligibleRuntimeCoveragePreview(
	projectRoot: string,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<RuntimeCoverageCapability | undefined> {
	const preview = await refreshRuntimeCoverage(state, dependencies);
	if (!preview) return undefined;
	if (preview.phase === "ready") return setNotice(state, "Runtime Coverage sidecar is already ready; setup did not run.");
	if (runtimeSetupBlocked(projectRoot, preview, state)) return undefined;
	return preview;
}

function runtimeSetupBlocked(
	projectRoot: string,
	preview: RuntimeCoverageCapability,
	state: OptionalAnalysisState,
): boolean {
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

async function executeRuntimeCoverageSetup(
	preview: RuntimeCoverageCapability,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	const install = await dependencies.runProcess(
		"npm",
		runtimeCoverageInstallArgs(preview.destination),
		`Installing @fallow-cli/fallow-cov@${FALLOW_COV_VERSION} in the Pi Fallow managed cache...`,
		300,
	);
	await persistSetupOutput(wrapProcessResult(install), state, dependencies);
	await refreshRuntimeCoverage(state, dependencies);
	if (!install) return setNotice(state, "Runtime Coverage setup was cancelled; Status was rechecked for partial state.");
	if (install.code !== 0) return setNotice(state, `Runtime Coverage setup failed: ${commandFailure(install)}`);
	if (!runtimeCoverageIsReady(state)) return setNotice(state, "Runtime Coverage setup completed without verified package/signature readiness. Review Status remediation.");
	setNotice(state, "Runtime Coverage sidecar installed in the managed cache; exact package metadata and detached signature presence were verified.");
}

function runtimeCoverageIsReady(state: OptionalAnalysisState): boolean {
	return state.runtimeCoverage?.phase === "ready";
}

function sameRuntimePreview(
	preview: RuntimeCoverageCapability,
	current: RuntimeCoverageCapability | undefined,
): boolean {
	return current?.phase === "missing"
		&& current.destination === preview.destination
		&& current.planFingerprint === preview.planFingerprint;
}

async function runRuntimeCoverage(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<FallowNavigatorResult | null> {
	const status = await readyRuntimeCoverageStatus(state, dependencies);
	if (!status) return null;
	const artifactPath = await confirmedRuntimeArtifact(ctx, state, status, dependencies);
	if (!artifactPath) return null;
	const current = await refreshRuntimeCoverage(state, dependencies);
	if (!sameRuntimeRunStatus(status, current)) {
		setNotice(state, "Runtime Coverage status changed while selecting the artifact; Run was stopped. Review Status and select the artifact again.");
		return null;
	}
	return {
		type: "forward",
		label: "Run Runtime Coverage",
		commandArgs: ["coverage", "analyze", "--runtime-coverage", artifactPath],
		executionEnvironment: localCoverageEnvironment(status.binaryPath),
	};
}

async function confirmedRuntimeArtifact(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	status: RuntimeCoverageCapability & { binaryPath: string },
	dependencies: OptionalAnalysisDependencies,
): Promise<string | undefined> {
	const artifactPath = await selectRuntimeArtifact(ctx, state, dependencies);
	if (!artifactPath) return undefined;
	return await confirmRuntimeCoverageRun(ctx, state, status, artifactPath) ? artifactPath : undefined;
}

async function confirmRuntimeCoverageRun(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	status: RuntimeCoverageCapability & { binaryPath: string },
	artifactPath: string,
): Promise<boolean> {
	const confirmed = await ctx.ui.confirm("Run local Runtime Coverage analysis?", [
		`Resolved artifact: ${artifactDisplayName(artifactPath)}`,
		`Verified sidecar: ${artifactDisplayName(status.binaryPath)}`,
		"Effect: read the selected local V8/Istanbul artifact and project source; run fallow coverage analyze locally.",
		"Cloud source and API credential environment variables will be removed for the analysis child process.",
	].join("\n"));
	if (confirmed) return true;
	setNotice(state, "Runtime Coverage Run declined after path preview; no analysis was started.");
	return false;
}

function sameRuntimeRunStatus(
	preview: RuntimeCoverageCapability,
	current: RuntimeCoverageCapability | undefined,
): boolean {
	return current?.phase === "ready"
		&& current.fingerprint === preview.fingerprint
		&& current.binaryPath === preview.binaryPath;
}

function localCoverageEnvironment(binaryPath: string): NodeJS.ProcessEnv {
	return {
		FALLOW_COV_BIN: binaryPath,
		FALLOW_RUNTIME_COVERAGE_SOURCE: undefined,
		FALLOW_API_KEY: undefined,
		FALLOW_API_URL: undefined,
		FALLOW_REPO: undefined,
		FALLOW_CA_BUNDLE: undefined,
	};
}

async function readyRuntimeCoverageStatus(
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<(RuntimeCoverageCapability & { binaryPath: string }) | undefined> {
	const status = await refreshRuntimeCoverage(state, dependencies);
	if (status?.phase === "ready" && status.binaryPath) return { ...status, binaryPath: status.binaryPath };
	setNotice(state, "Runtime Coverage Run is disabled until Status reports the exact certified sidecar and detached signature.");
	return undefined;
}

async function selectRuntimeArtifact(
	ctx: FallowCommandContext,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<string | undefined> {
	const selected = await ctx.ui.input("Local V8/Istanbul artifact", "Path to a local coverage JSON file or directory");
	if (!selected?.trim()) return setNotice(state, "Runtime Coverage Run cancelled before selecting an artifact.");
	try {
		state.artifactPath = await dependencies.resolveArtifact(selected.trim());
		return state.artifactPath;
	} catch (error) {
		return setNotice(state, `Runtime artifact is unavailable: ${errorMessage(error)}`);
	}
}

function createDependencies(pi: ExtensionAPI, ctx: FallowCommandContext): OptionalAnalysisDependencies {
	return {
		runFallow: (args, label, timeoutSecs = 120) => runFallowTaskWithLoader(
			ctx, label, (signal) => fallowCli.execFallow(pi, args, ctx.cwd, signal, timeoutSecs),
		),
		runProcess: (command, args, label, timeoutSecs = 120) => runFallowTaskWithLoader(
			ctx, label, (signal) => fallowCli.execCommand(command, args, ctx.cwd, signal, timeoutSecs),
		),
		inspectRuntime: (plan) => inspectRuntimeCoverageCapability(plan),
		resolveArtifact: resolveLocalArtifact,
		saveSetupOutput: saveOptionalSetupOutput,
	};
}

function wrapProcessResult(result: ProcessResult | null): RawCommandResult | null {
	return result ? { result } : null;
}

async function persistSetupOutput(
	execution: RawCommandResult | null,
	state: OptionalAnalysisState,
	dependencies: OptionalAnalysisDependencies,
): Promise<void> {
	if (!execution) return;
	try {
		state.completeSetupOutputPath = await dependencies.saveSetupOutput(execution.result.stdout, execution.result.stderr);
	} catch {
		state.completeSetupOutputPath = undefined;
	}
}

function isPathWithin(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function setNotice(state: OptionalAnalysisState, notice: string): undefined {
	state.notice = notice.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
	return undefined;
}

function commandFailure(result: { stderr: string; stdout: string; code: number; terminationReason?: string }): string {
	const message = [result.terminationReason, result.stderr.trim(), result.stdout.trim()].find(Boolean) ?? `exit ${result.code}`;
	return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
