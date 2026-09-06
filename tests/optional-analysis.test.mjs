import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runOptionalAnalysisWorkflow } = await jiti.import("../extensions/fallow/command/optional-analysis.ts");
const {
	createOptionalAnalysisState,
	inspectRuntimeCoverageCapability,
	parseCoverageSetupPlan,
	parseSimilarCodeCapability,
	resolveLocalArtifact,
	runtimeCoverageInstallArgs,
	runtimeCoverageSetupPreview,
	similarCodeSetupPreview,
	FALLOW_COV_VERSION,
} = await jiti.import("../extensions/fallow/optional-analysis.ts");

const SIMILAR_CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const SIMILAR_CODE_MODEL_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250";
const FALLOW_COV_DIST_INTEGRITY = "sha512-j6vKYolLyuOdgoONTFoFZ7RBp5vx/U8lHx9sa1oMZetdD7XAwo3nMd11gQHKuDs2JiBcDTra7YpqxhUyjmz4YA==";
const FALLOW_COV_PLATFORM_INTEGRITIES = {
	"fallow-cov-darwin-arm64": "sha512-pahht40+IUCi8GFaiY10yVGKy5iwsKg62FwM31G+6UvWAYnrtvh/RpqFBVS5QkvhxBfK0kRr3wugaEfFMBsgVQ==",
	"fallow-cov-darwin-x64": "sha512-hiX+xLSkxGI3UiB0MUleNAk8fHc8/iXaCLwJRRw3TMUlpdh/c/t4GFUUF9UIOcGq+lJtLScJHnfrhXL0u2BmqQ==",
	"fallow-cov-linux-arm64-gnu": "sha512-/NegKdrIOd1uc/f4i1jRFgYX7j9OZgKnN4M2numcM2ThoRPIomULb/ZYFJxhqheEj8mtJiq9LyVqpNmZM+XHpw==",
	"fallow-cov-linux-arm64-musl": "sha512-H1/fQ+tAaXSfCrnDFuGwmn6OYw0ZlQQVTwIPffBLTgZrud6uXkhKJKmZ68iodp6fG2AuEdRM4UJV+5/nkEb+ig==",
	"fallow-cov-linux-x64-gnu": "sha512-CBHoqxAjDxPm3G4JER4G6OQR6Zrg9RTdRqIHmd0+Pv34elib7htFSmB9P3HfcSr8TGVCa/fuKcdANIMamcNBcw==",
	"fallow-cov-linux-x64-musl": "sha512-/KR0kktHtf/ryO0bywaj1nzrj3XFLGP19aVG5iOiFYQJ1/a9ML5Tz+HFilSc0v6O+zSSvX7qaO98hOLjMHZOgQ==",
	"fallow-cov-win32-x64-msvc": "sha512-hs0z/jiXtrffOiwPz/Zk1XnAr52Wjybkywk8l5ZlmPuRV7Dz1sw97Y66aQ2AKODeTqLAwFPVrFnV+Qst1UdEBA==",
};

const missingSimilarReport = {
	kind: "similar-code-status",
	schema_version: "1",
	version: "3.21.0",
	protocol_version: 2,
	companion_version: "3.21.0",
	model_ready: false,
	model_id: SIMILAR_CODE_MODEL_ID,
	model_revision: SIMILAR_CODE_MODEL_REVISION,
	license: "Apache-2.0",
	cache_dir: "/cache/model",
	download_bytes: 324329844,
	integrity_verified: false,
	problem: "model missing",
};

const setupPlan = {
	kind: "coverage-setup",
	schema_version: "1",
	commands: ["npm install @fallow-cli/beacon", "npm install --save-dev @fallow-cli/fallow-cov"],
	files_to_edit: [{ path: "src/server.ts" }],
	_meta: { telemetry: { analysis_run_id: "run-1" } },
};

function rawResult(data, code = 0) {
	return { result: { stdout: JSON.stringify(data), stderr: "", code } };
}

function processResult(code = 0) {
	return { stdout: "", stderr: "", code };
}

function choiceContaining(fragment) {
	return (_title, options) => options.find((entry) => entry.includes(fragment));
}

function createContext(selectors, confirmations = [], inputs = []) {
	const calls = { titles: [], options: [], confirmations: [], inputs: [] };
	return {
		calls,
		context: {
			mode: "tui",
			hasUI: true,
			cwd: "/project",
			ui: {
				async select(title, options) {
					calls.titles.push(title);
					calls.options.push(options);
					const selector = selectors.shift();
					return selector ? selector(title, options) : undefined;
				},
				async confirm(title, message) {
					calls.confirmations.push({ title, message });
					return confirmations.shift() ?? false;
				},
				async input(title, placeholder) {
					calls.inputs.push({ title, placeholder });
					return inputs.shift();
				},
				notify() {}, setStatus() {}, custom() {}, setEditorText() {},
			},
		},
	};
}

function createDependencies(overrides = {}) {
	const calls = { fallow: [], process: [], inspect: 0, artifact: [], savedOutput: [] };
	const dependencies = {
		async runFallow(args) {
			calls.fallow.push(args);
			throw new Error(`Unexpected Fallow command: ${args.join(" ")}`);
		},
		async runProcess(command, args) {
			calls.process.push({ command, args });
			throw new Error(`Unexpected process: ${command}`);
		},
		async inspectRuntime(plan) {
			calls.inspect++;
			return inspectRuntimeCoverageCapability(plan, "/missing/managed-sidecar");
		},
		async resolveArtifact(path) {
			calls.artifact.push(path);
			return `/resolved/${path}`;
		},
		async saveSetupOutput(stdout, stderr) {
			calls.savedOutput.push({ stdout, stderr });
			return "/tmp/pi-fallow-optional/setup-output.txt";
		},
		...overrides,
	};
	return { calls, dependencies };
}

describe("optional analysis capability metadata", () => {
	it("classifies missing, ready, incompatible, and unverified Similar Code states", () => {
		assert.equal(parseSimilarCodeCapability(missingSimilarReport).phase, "missing");
		assert.equal(parseSimilarCodeCapability({ ...missingSimilarReport, model_ready: true, integrity_verified: true, problem: undefined }).phase, "ready");
		assert.equal(parseSimilarCodeCapability({ ...missingSimilarReport, model_revision: "drift" }).phase, "incompatible");
		assert.equal(parseSimilarCodeCapability({ ...missingSimilarReport, model_ready: true }).phase, "corrupt");
		const bounded = parseSimilarCodeCapability({ ...missingSimilarReport, problem: "x".repeat(5_000) });
		assert.equal(bounded.problem.length, 1_000);
	});

	it("rejects incompatible coverage plans and retains only bounded drift metadata", async () => {
		assert.throws(() => parseCoverageSetupPlan({ kind: "coverage-setup", schema_version: "2" }), /incompatible/);
		const first = parseCoverageSetupPlan(setupPlan);
		const second = structuredClone(first);
		second._meta.telemetry.analysis_run_id = "run-2";
		const [left, right] = await Promise.all([
			inspectRuntimeCoverageCapability(first, "/missing/a"),
			inspectRuntimeCoverageCapability(second, "/missing/a"),
		]);
		assert.equal(left.planFingerprint, right.planFingerprint);
		const largePlan = {
			...setupPlan,
			commands: Array.from({ length: 15 }, (_, index) => `${index}:${"x".repeat(400)}`),
			files_to_edit: Array.from({ length: 25 }, (_, index) => ({ path: `file-${index}.ts` })),
		};
		const bounded = await inspectRuntimeCoverageCapability(largePlan, "/missing/b");
		assert.equal(bounded.plan.commands.length, 10);
		assert.equal(bounded.plan.omittedCommands, 5);
		assert.equal(bounded.plan.filesToEdit.length, 20);
		assert.equal(bounded.plan.omittedFiles, 5);
		assert.match(runtimeCoverageSetupPreview(bounded), /\+5 more not shown/);
	});

	it("verifies exact installed wrapper, platform package, binary, and detached signature", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-fallow-cov-status-"));
		const scope = join(root, "node_modules", "@fallow-cli");
		const platformPackage = process.platform === "darwin"
			? `fallow-cov-darwin-${process.arch}`
			: process.platform === "win32" ? `fallow-cov-win32-${process.arch}-msvc` : `fallow-cov-linux-${process.arch}-gnu`;
		try {
			await mkdir(join(scope, "fallow-cov"), { recursive: true });
			await mkdir(join(scope, platformPackage), { recursive: true });
			await writeFile(join(scope, "fallow-cov", "package.json"), JSON.stringify({ name: "@fallow-cli/fallow-cov", version: FALLOW_COV_VERSION, license: "SEE LICENSE IN LICENSE" }));
			await writeFile(join(root, "node_modules", ".package-lock.json"), JSON.stringify({ packages: {
				"node_modules/@fallow-cli/fallow-cov": { integrity: FALLOW_COV_DIST_INTEGRITY },
				[`node_modules/@fallow-cli/${platformPackage}`]: { integrity: FALLOW_COV_PLATFORM_INTEGRITIES[platformPackage] },
			} }));
			await writeFile(join(scope, platformPackage, "package.json"), JSON.stringify({ name: `@fallow-cli/${platformPackage}`, version: FALLOW_COV_VERSION }));
			const binary = join(scope, platformPackage, process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov");
			await writeFile(binary, "binary");
			await chmod(binary, 0o755);
			await writeFile(`${binary}.sig`, "signature");
			const status = await inspectRuntimeCoverageCapability(setupPlan, root);
			assert.equal(status.phase, "ready");
			assert.equal(status.packageMetadataVerified, true);
			assert.equal(status.signaturePresent, true);
			assert.equal(status.binaryPath, await realpath(binary));
			assert.ok(status.installedBytes > 0);
			await rm(`${binary}.sig`);
			assert.equal((await inspectRuntimeCoverageCapability(setupPlan, root)).phase, "corrupt");
			await writeFile(`${binary}.sig`, "signature");
			await writeFile(join(scope, "fallow-cov", "package.json"), JSON.stringify({ name: "@fallow-cli/fallow-cov", version: "9.9.9" }));
			assert.equal((await inspectRuntimeCoverageCapability(setupPlan, root)).phase, "incompatible");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("canonicalizes managed destinations through existing symlink ancestors", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-fallow-tools-link-"));
		try {
			const project = join(root, "project");
			const alias = join(root, "tools-link");
			await mkdir(project);
			await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
			const status = await inspectRuntimeCoverageCapability(setupPlan, join(alias, "fallow-cov"));
			assert.equal(status.destination, join(await realpath(project), "fallow-cov"));
			assert.equal(status.phase, "missing");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("accepts only existing local artifact files or directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-fallow-artifact-"));
		try {
			const file = join(root, "coverage.json");
			await writeFile(file, "{}");
			assert.equal(await resolveLocalArtifact(file), await realpath(file));
			assert.equal(await resolveLocalArtifact(root), await realpath(root));
			await assert.rejects(() => resolveLocalArtifact("https://example.com/coverage.json"), /Cloud and URL artifacts are not supported/);
			await assert.rejects(() => resolveLocalArtifact(join(root, "missing.json")));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("discloses source, revision/version, license, size, destination, command, and excluded cloud effects", async () => {
		const similar = similarCodeSetupPreview(parseSimilarCodeCapability(missingSimilarReport));
		assert.match(similar, /Hugging Face/);
		assert.match(similar, new RegExp(SIMILAR_CODE_MODEL_REVISION));
		assert.match(similar, /Apache-2\.0.*309 MiB.*1\.2 GiB/s);
		assert.match(similar, /Destination: \/cache\/model/);
		assert.match(similar, /--local --yes/);
		const coverageStatus = await inspectRuntimeCoverageCapability(setupPlan, "/managed/fallow-cov");
		const coverage = runtimeCoverageSetupPreview(coverageStatus);
		assert.match(coverage, /@fallow-cli\/fallow-cov@0\.4\.1/);
		assert.match(coverage, /Proprietary/);
		assert.match(coverage, /approximately 3 MiB/);
		assert.match(coverage, /Destination: \/managed\/fallow-cov/);
		assert.match(coverage, /--ignore-scripts --no-save --package-lock=false/);
		assert.match(coverage, /will NOT perform.*beacon.*src\/server\.ts/s);
	});
});

describe("optional analysis overlay workflow", () => {
	it("shows separate Status, Setup, and Run rows without executing anything when opened", async () => {
		const state = createOptionalAnalysisState();
		const { context, calls: uiCalls } = createContext([choiceContaining("Back")]);
		const { calls, dependencies } = createDependencies();
		assert.equal(await runOptionalAnalysisWorkflow({}, context, state, dependencies), null);
		const labels = uiCalls.options[0];
		assert.equal(labels.filter((label) => /Status/.test(label)).length, 2);
		assert.equal(labels.filter((label) => /Setup/.test(label)).length, 2);
		assert.equal(labels.filter((label) => /· Run/.test(label)).length, 2);
		assert.deepEqual(calls.fallow, []);
		assert.deepEqual(calls.process, []);
	});

	it("runs read-only Similar Code Status without installing", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Similar Code · Status"), choiceContaining("Back")]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(missingSimilarReport); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.deepEqual(calls.fallow, [["similar-code", "status", "--format", "json", "--quiet"]]);
		assert.deepEqual(calls.process, []);
		assert.equal(uiCalls.confirmations.length, 0);
		assert.equal(state.similarCode.phase, "missing");
	});

	it("displays the read-only runtime setup plan from Status without installing", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Runtime Coverage · Status"), choiceContaining("Back")]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
		});
		await runOptionalAnalysisWorkflow({}, context, createOptionalAnalysisState(), dependencies);
		assert.deepEqual(calls.fallow, [["coverage", "setup", "--json", "--root", "."]]);
		assert.equal(calls.process.length, 0);
		assert.match(uiCalls.titles[1], /will NOT perform.*beacon.*src\/server\.ts/s);
	});

	it("does not download Similar Code when setup confirmation is declined", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Similar Code · Setup"), choiceContaining("Back")], [false]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(missingSimilarReport); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.fallow.length, 1);
		assert.equal(calls.fallow.some((args) => args.includes("setup")), false);
		assert.equal(calls.process.length, 0);
		assert.match(uiCalls.confirmations[0].message, /309 MiB/);
		assert.match(state.notice, /declined/);
	});

	it("runs exact Similar Code setup only after confirmation and verifies readiness", async () => {
		const { context } = createContext([choiceContaining("Similar Code · Setup"), choiceContaining("Back")], [true]);
		const ready = { ...missingSimilarReport, model_ready: true, integrity_verified: true, problem: undefined };
		const reports = [missingSimilarReport, missingSimilarReport, { kind: "similar-code-setup" }, ready];
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(reports.shift()); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.deepEqual(calls.fallow[2], ["similar-code", "setup", "--local", "--yes", "--format", "json", "--quiet"]);
		assert.equal(state.similarCode.phase, "ready");
		assert.equal(state.completeSetupOutputPath, "/tmp/pi-fallow-optional/setup-output.txt");
		assert.equal(calls.savedOutput.length, 1);
		assert.match(state.notice, /integrity was verified/);
	});

	it("rechecks partial Similar Code state after setup cancellation", async () => {
		const { context } = createContext([choiceContaining("Similar Code · Setup"), choiceContaining("Back")], [true]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) {
				calls.fallow.push(args);
				return args[1] === "setup" ? null : rawResult(missingSimilarReport);
			},
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.fallow.length, 4);
		assert.match(state.notice, /cancelled.*partial state/);
	});

	it("reports failed Similar Code setup without claiming readiness", async () => {
		const { context } = createContext([choiceContaining("Similar Code · Setup"), choiceContaining("Back")], [true]);
		const { dependencies } = createDependencies({
			async runFallow(args) {
				return args[1] === "setup"
					? { result: { stdout: "", stderr: "verification failed", code: 2 } }
					: rawResult(missingSimilarReport);
			},
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(state.similarCode.phase, "missing");
		assert.match(state.notice, /setup failed: verification failed/);
	});

	it("forwards Similar Code Run only after a fresh integrity-verified status", async () => {
		const { context } = createContext([choiceContaining("Similar Code · Run")], [], ["src/a.ts", "0.8", "5"]);
		const ready = { ...missingSimilarReport, model_ready: true, integrity_verified: true, problem: undefined };
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(ready); },
		});
		const result = await runOptionalAnalysisWorkflow({}, context, createOptionalAnalysisState(), dependencies);
		assert.deepEqual(result, {
			type: "forward", label: "Run Similar Code",
			commandArgs: ["similar-code", "--file", "src/a.ts", "--threshold", "0.8", "--top", "5"],
		});
		assert.equal(calls.process.length, 0);
	});

	it("stops Similar Code setup when status drifts after confirmation", async () => {
		const { context } = createContext([choiceContaining("Similar Code · Setup"), choiceContaining("Back")], [true]);
		const reports = [missingSimilarReport, { ...missingSimilarReport, cache_dir: "/changed/cache" }];
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(reports.shift()); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.fallow.length, 2);
		assert.equal(calls.fallow.some((args) => args.includes("setup")), false);
		assert.match(state.notice, /changed after preview/);
	});

	it("installs the runtime sidecar only after confirmation and unchanged plan", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [true]);
		let inspectCount = 0;
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult({ ...setupPlan, _meta: { telemetry: { analysis_run_id: `run-${calls.fallow.length}` } } }); },
			async inspectRuntime(plan) {
				calls.inspect++;
				inspectCount++;
				if (inspectCount < 3) return inspectRuntimeCoverageCapability(plan, "/missing/managed-sidecar");
				return { ...(await inspectRuntimeCoverageCapability(plan, "/missing/managed-sidecar")), phase: "ready", binaryPath: "/managed/fallow-cov" };
			},
			async runProcess(command, args) { calls.process.push({ command, args }); return processResult(); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(uiCalls.confirmations.length, 1);
		assert.equal(calls.process.length, 1);
		assert.equal(calls.process[0].command, "npm");
		assert.deepEqual(calls.process[0].args, runtimeCoverageInstallArgs("/missing/managed-sidecar"));
		assert.equal(calls.fallow.length, 3);
		assert.equal(state.completeSetupOutputPath, "/tmp/pi-fallow-optional/setup-output.txt");
		assert.equal(calls.savedOutput.length, 1);
		assert.match(state.notice, /installed in the managed cache/);
	});

	it("rechecks partial runtime state after setup cancellation", async () => {
		const { context } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [true]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
			async runProcess(command, args) { calls.process.push({ command, args }); return null; },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.fallow.length, 3);
		assert.match(state.notice, /cancelled.*partial state/);
	});

	it("stops runtime setup when the read-only plan drifts after confirmation", async () => {
		const { context } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [true]);
		const plans = [setupPlan, { ...setupPlan, commands: [...setupPlan.commands, "new command"] }];
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(plans.shift()); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.process.length, 0);
		assert.match(state.notice, /plan changed after preview/);
	});

	it("reports failed runtime setup and rechecks partial state", async () => {
		const { context } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [true]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
			async runProcess(command, args) { calls.process.push({ command, args }); return { stdout: "", stderr: "network failed", code: 1 }; },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.fallow.length, 3);
		assert.match(state.notice, /setup failed: network failed/);
	});

	it("blocks runtime setup when the configured tools destination is inside the project", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [true]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
			async inspectRuntime(plan) { calls.inspect++; return inspectRuntimeCoverageCapability(plan, "/project/.tools/fallow-cov"); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(uiCalls.confirmations.length, 0);
		assert.equal(calls.process.length, 0);
		assert.match(state.notice, /inside the project/);
	});

	it("declines runtime setup without invoking npm", async () => {
		const { context } = createContext([choiceContaining("Runtime Coverage · Setup"), choiceContaining("Back")], [false]);
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
		});
		const state = createOptionalAnalysisState();
		await runOptionalAnalysisWorkflow({}, context, state, dependencies);
		assert.equal(calls.process.length, 0);
		assert.match(state.notice, /declined/);
	});

	it("stops runtime Run if the sidecar drifts while the artifact is selected", async () => {
		const ready = { ...(await inspectRuntimeCoverageCapability(setupPlan, "/missing/managed-sidecar")), phase: "ready", binaryPath: "/managed/fallow-cov", signaturePath: "/managed/fallow-cov.sig" };
		const { context } = createContext([choiceContaining("Runtime Coverage · Run"), choiceContaining("Back")], [true], ["coverage/v8"]);
		let inspections = 0;
		const { dependencies } = createDependencies({
			async runFallow() { return rawResult(setupPlan); },
			async inspectRuntime() { return inspections++ === 0 ? ready : { ...ready, phase: "corrupt", fingerprint: "drift" }; },
		});
		const state = createOptionalAnalysisState();
		assert.equal(await runOptionalAnalysisWorkflow({}, context, state, dependencies), null);
		assert.match(state.notice, /status changed while selecting/);
	});

	it("forwards runtime analysis only with a selected local artifact and managed binary", async () => {
		const { context, calls: uiCalls } = createContext([choiceContaining("Runtime Coverage · Run")], [true], ["coverage/v8"]);
		const ready = { ...(await inspectRuntimeCoverageCapability(setupPlan, "/missing/managed-sidecar")), phase: "ready", binaryPath: "/managed/fallow-cov" };
		const { calls, dependencies } = createDependencies({
			async runFallow(args) { calls.fallow.push(args); return rawResult(setupPlan); },
			async inspectRuntime() { calls.inspect++; return ready; },
		});
		const result = await runOptionalAnalysisWorkflow({}, context, createOptionalAnalysisState(), dependencies);
		assert.equal(result.type, "forward");
		assert.deepEqual(result.commandArgs, ["coverage", "analyze", "--runtime-coverage", "/resolved/coverage/v8"]);
		assert.match(uiCalls.confirmations[0].message, /Resolved artifact: v8 \(\/resolved\/coverage\/v8\)/);
		assert.deepEqual(result.executionEnvironment, {
			FALLOW_COV_BIN: "/managed/fallow-cov",
			FALLOW_RUNTIME_COVERAGE_SOURCE: undefined,
			FALLOW_API_KEY: undefined,
			FALLOW_API_URL: undefined,
			FALLOW_REPO: undefined,
			FALLOW_CA_BUNDLE: undefined,
		});
		assert.deepEqual(calls.artifact, ["coverage/v8"]);
	});

	it("never opens interactive controls outside TUI mode", async () => {
		const { context } = createContext([]);
		context.mode = "rpc";
		const { calls, dependencies } = createDependencies();
		assert.equal(await runOptionalAnalysisWorkflow({}, context, createOptionalAnalysisState(), dependencies), null);
		assert.deepEqual(calls.fallow, []);
		assert.deepEqual(calls.process, []);
	});
});
