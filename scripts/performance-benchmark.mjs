import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { populateFallowProject, runFixtureEngine, writeJsonArtifact } from "./benchmark-utils.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_BIN = join(ROOT, "benchmarks", "bin", "fallow-fixture.mjs");
const MEMORY_WORKER = join(ROOT, "scripts", "performance-memory-worker.mjs");
const DEFAULT_CONFIG = { warmups: 3, iterations: 15, gitColdIterations: 8, memoryIterations: 3, systemRunnerIterations: 5 };
const PROCESSING_SCENARIOS = ["no-findings", "small-findings", "medium-findings", "large-findings", "schema"];
const MEMORY_SCENARIOS = ["small-findings", "medium-findings", "large-findings", "schema"];
const CLI_OPTION_SETTERS = {
	"--label": (options, value) => { options.label = value; },
	"--output": (options, value) => { options.output = value; },
	"--iterations": (options, value) => { options.config.iterations = parsePositiveInteger(value, "--iterations"); },
	"--warmups": (options, value) => { options.config.warmups = parsePositiveInteger(value, "--warmups", true); },
	"--memory-iterations": (options, value) => { options.config.memoryIterations = parsePositiveInteger(value, "--memory-iterations"); },
};
const jiti = createJiti(import.meta.url);

const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const { fallowCompletions } = await jiti.import("../extensions/fallow/autocomplete.ts");
const { detectFallowGitState } = await jiti.import("../extensions/fallow/project/git.ts");

const cli = parseCli(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const corpus = JSON.parse(await readFile(join(ROOT, "benchmarks", "corpus.json"), "utf8"));
const fixtureById = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-performance-"));
const measurements = [];

try {
	measurements.push(...await benchmarkRunners(workspace, cli.config));
	measurements.push(...await benchmarkProcessing(workspace, cli.config));
	measurements.push(...await benchmarkGit(workspace, cli.config));
	measurements.push(...await benchmarkMemory(cli.config));
} finally {
	process.chdir(ROOT);
	await rm(workspace, { recursive: true, force: true });
}

const artifact = {
	benchmarkVersion: 1,
	label: cli.label,
	generatedAt: new Date().toISOString(),
	config: cli.config,
	environment: buildEnvironment(packageJson),
	measurements,
	findings: buildPerformanceFindings(measurements),
};

await writeJsonArtifact(artifact, cli.output);
printSummary(artifact, cli.output);

function parseCli(args) {
	const options = { label: "working-tree", output: undefined, config: { ...DEFAULT_CONFIG } };
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const setter = CLI_OPTION_SETTERS[flag];
		if (!setter) throw new Error(`Unknown argument: ${flag}`);
		setter(options, requireValue(args, index + 1, flag));
	}
	return options;
}

function requireValue(args, index, flag) {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

function parsePositiveInteger(rawValue, flag, allowZero = false) {
	const value = Number(rawValue);
	const minimum = allowZero ? 0 : 1;
	if (!Number.isInteger(value) || value < minimum) throw new Error(`${flag} must be an integer >= ${minimum}.`);
	return value;
}

async function benchmarkRunners(workspacePath, config) {
	const runnerDir = join(workspacePath, "runner-bin");
	await mkdir(runnerDir, { recursive: true });
	const pathFallow = join(runnerDir, "fallow");
	const pathNpx = join(runnerDir, "npx");
	await copyExecutable(FIXTURE_BIN, pathFallow);
	await copyExecutable(FIXTURE_BIN, pathNpx);
	const originalPath = process.env.PATH;
	const nodePath = dirname(process.execPath);
	const fixturePath = [runnerDir, nodePath, "/usr/bin", "/bin"].join(delimiter);
	await execFileAsync(FIXTURE_BIN, ["dead-code", "--format", "json", "--quiet"]);

	const configured = await withEnvironment({ FALLOW_BIN: FIXTURE_BIN, PATH: originalPath }, () => benchmarkOperation(
		"runner",
		"configured-fallow-bin",
		() => runFallowFixture(),
		config,
	));
	const pathResolved = await withEnvironment({ FALLOW_BIN: undefined, PATH: fixturePath }, () => benchmarkOperation(
		"runner",
		"path-fallow",
		() => runFallowFixture(),
		config,
	));
	const deterministicFallback = await benchmarkNpxFallback(workspacePath, pathNpx, nodePath, config);
	const systemFallowBinary = resolveSystemFallowBinary(originalPath);
	const systemDirect = await benchmarkSystemDirect(systemFallowBinary, originalPath, config);
	const systemResolution = await benchmarkSystemResolution(originalPath, config);
	return [configured, pathResolved, deterministicFallback, systemDirect, systemResolution];
}

async function benchmarkNpxFallback(workspacePath, npxFixture, nodePath, config) {
	const npxOnlyDir = join(workspacePath, "npx-only-bin");
	await mkdir(npxOnlyDir, { recursive: true });
	await copyExecutable(npxFixture, join(npxOnlyDir, "npx"));
	const fallbackPath = [npxOnlyDir, nodePath, "/usr/bin", "/bin"].join(delimiter);
	return withEnvironment({ FALLOW_BIN: undefined, PATH: fallbackPath }, () => benchmarkOperation(
		"runner",
		"npx-fallback-fixture",
		() => runFallowFixture(),
		config,
	));
}

function resolveSystemFallowBinary(pathValue) {
	return execFileSync("npm", ["exec", "--yes", "--package=fallow", "--", "which", "fallow"], {
		cwd: ROOT,
		env: { ...process.env, PATH: pathValue },
		encoding: "utf8",
	}).trim();
}

async function benchmarkSystemDirect(fallowBinary, pathValue, config) {
	const systemConfig = { ...config, warmups: 1, iterations: config.systemRunnerIterations };
	const measurement = await withEnvironment({ FALLOW_BIN: fallowBinary, PATH: pathValue }, () => benchmarkOperation(
		"runner",
		"system-direct-fallow",
		() => runSystemFallow(),
		systemConfig,
	));
	measurement.resolvedBinary = measurement.cold.binary;
	measurement.fallowVersion = measurement.cold.fallowVersion;
	return measurement;
}

async function benchmarkSystemResolution(pathValue, config) {
	const systemConfig = { ...config, warmups: 1, iterations: config.systemRunnerIterations };
	const measurement = await withEnvironment({ FALLOW_BIN: undefined, PATH: pathValue }, () => benchmarkOperation(
		"runner",
		"system-resolution",
		() => runSystemFallow(),
		systemConfig,
	));
	measurement.resolvedBinary = measurement.cold.binary;
	measurement.fallowVersion = measurement.cold.fallowVersion;
	return measurement;
}

async function runSystemFallow() {
	const { result, binary } = await fallowCli.execFallow({}, ["dupes", "--format", "json", "--quiet"], ROOT, undefined, 120);
	const parsed = JSON.parse(result.stdout);
	return { internalElapsedMs: parsed.elapsed_ms, binary, fallowVersion: parsed.version };
}

async function copyExecutable(source, target) {
	await copyFile(source, target);
	await chmod(target, 0o755);
}

async function runFallowFixture() {
	const { result, binary } = await fallowCli.execFallow({}, ["dead-code", "--format", "json", "--quiet"], ROOT, undefined, 120);
	const parsed = JSON.parse(result.stdout);
	return { internalElapsedMs: parsed.elapsed_ms, binary };
}

async function benchmarkProcessing(workspacePath, config) {
	const projectDir = join(workspacePath, "processing-project");
	await populateFallowProject(projectDir);
	const results = [];
	for (const scenarioId of PROCESSING_SCENARIOS) {
		const scenario = fixtureById.get(scenarioId);
		const fixtureText = await readFile(join(ROOT, "benchmarks", scenario.fixture), "utf8");
		results.push(await benchmarkOperation(
			"processing",
			scenarioId,
			() => processFixture(scenario, fixtureText, projectDir),
			config,
		));
	}
	return results;
}

async function processFixture(scenario, fixtureText, cwd) {
	const result = await runFixtureEngine(fallowEngine, { scenario, fixtureText, cwd });
	const fullOutputPath = result.formatted.fullOutputPath;
	return {
		outputBytes: Buffer.byteLength(result.content),
		cleanup: fullOutputPath ? () => rm(dirname(fullOutputPath), { recursive: true, force: true }) : undefined,
	};
}

async function benchmarkGit(workspacePath, config) {
	const sourceRepo = join(workspacePath, "git-source");
	await createGitRepository(sourceRepo);
	const autocomplete = await benchmarkAutocomplete(workspacePath, sourceRepo, config);
	const detection = await benchmarkOperation(
		"git",
		"base-detection",
		() => detectFallowGitState(sourceRepo),
		config,
	);
	const counts = await countGitSubprocesses(workspacePath, sourceRepo);
	autocomplete.subprocessesPerColdInvocation = counts.autocomplete;
	detection.subprocessesPerInvocation = counts.baseDetection;
	return [autocomplete, detection];
}

async function createGitRepository(cwd) {
	await mkdir(cwd, { recursive: true });
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.email", "benchmark@example.invalid"]);
	git(cwd, ["config", "user.name", "Pi Fallow Benchmark"]);
	await writeFile(join(cwd, "index.ts"), "export const benchmark = true;\n", "utf8");
	git(cwd, ["add", "index.ts"]);
	git(cwd, ["commit", "-qm", "benchmark"]);
	git(cwd, ["branch", "-M", "main"]);
	git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

function git(cwd, args) {
	return execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function benchmarkAutocomplete(workspacePath, sourceRepo, config) {
	const repos = [];
	for (let index = 0; index < config.gitColdIterations; index++) {
		const target = join(workspacePath, `autocomplete-${index}`);
		execFileSync("git", ["clone", "-q", "--shared", sourceRepo, target]);
		repos.push(target);
	}
	const originalCwd = process.cwd();
	const coldSamples = [];
	try {
		for (const repo of repos) {
			process.chdir(repo);
			coldSamples.push(await measureInvocation(() => completeBaseRef()));
		}
		process.chdir(repos[0]);
		completeBaseRef();
		const warmSamples = [];
		for (let index = 0; index < config.iterations; index++) warmSamples.push(await measureInvocation(() => completeBaseRef()));
		return buildMeasurement("git", "autocomplete-refs", coldSamples[0], coldSamples, warmSamples, {
			eventLoopBlockedMs: summarize(coldSamples, "wallMs"),
		});
	} finally {
		process.chdir(originalCwd);
	}
}

function completeBaseRef() {
	return fallowCompletions.getFallowArgumentCompletions("audit --base ");
}

async function countGitSubprocesses(workspacePath, sourceRepo) {
	const traceDir = join(workspacePath, "git-trace");
	const logPath = join(traceDir, "calls.log");
	const wrapperPath = join(traceDir, "git");
	const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	await mkdir(traceDir, { recursive: true });
	await writeFile(wrapperPath, "#!/bin/sh\necho call >> \"$PI_FALLOW_GIT_LOG\"\nexec \"$PI_FALLOW_REAL_GIT\" \"$@\"\n", { mode: 0o755 });
	const tracedRepo = join(workspacePath, "git-traced-repo");
	execFileSync(actualGit, ["clone", "-q", "--shared", sourceRepo, tracedRepo]);
	const tracedPath = [traceDir, process.env.PATH].join(delimiter);
	return withEnvironment({ PATH: tracedPath, PI_FALLOW_GIT_LOG: logPath, PI_FALLOW_REAL_GIT: actualGit }, async () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(tracedRepo);
			completeBaseRef();
			const autocomplete = await countLogLines(logPath);
			await detectFallowGitState(tracedRepo);
			const total = await countLogLines(logPath);
			return { autocomplete, baseDetection: total - autocomplete };
		} finally {
			process.chdir(originalCwd);
		}
	});
}

async function countLogLines(path) {
	try {
		const text = await readFile(path, "utf8");
		return text.trim() ? text.trim().split(/\r?\n/).length : 0;
	} catch {
		return 0;
	}
}

async function benchmarkMemory(config) {
	const results = [];
	for (const scenarioId of MEMORY_SCENARIOS) {
		const scenario = fixtureById.get(scenarioId);
		const fixturePath = join(ROOT, "benchmarks", scenario.fixture);
		const samples = [];
		for (let index = 0; index < config.memoryIterations; index++) samples.push(await runMemoryWorker(fixturePath));
		results.push(buildMemoryMeasurement(scenarioId, samples));
	}
	return results;
}

async function runMemoryWorker(fixturePath) {
	const { stdout } = await execFileAsync(process.execPath, ["--expose-gc", MEMORY_WORKER, fixturePath], {
		cwd: ROOT,
		maxBuffer: 10 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

function buildMemoryMeasurement(scenario, samples) {
	const fixtureBytes = samples[0].fixtureBytes;
	const retainedHeap = samples.map((sample) => sample.deltaWhileRetained.heapUsedBytes);
	return {
		key: `memory/${scenario}`,
		category: "memory",
		scenario,
		fixtureBytes,
		retained: memoryStats(samples, "deltaWhileRetained"),
		afterRelease: memoryStats(samples, "deltaAfterRelease"),
		maxRssBytes: aggregate(samples.map((sample) => sample.maxRssBytes)),
		retainedHeapAmplification: round(aggregate(retainedHeap).median / fixtureBytes),
	};
}

function memoryStats(samples, field) {
	const keys = ["rssBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"];
	return Object.fromEntries(keys.map((key) => [key, aggregate(samples.map((sample) => sample[field][key]))]));
}

async function benchmarkOperation(category, scenario, operation, config) {
	const cold = await measureInvocation(operation);
	for (let index = 0; index < config.warmups; index++) await measureInvocation(operation);
	const warmSamples = [];
	for (let index = 0; index < config.iterations; index++) warmSamples.push(await measureInvocation(operation));
	return buildMeasurement(category, scenario, cold, [cold], warmSamples);
}

async function measureInvocation(operation) {
	const cpuStart = process.cpuUsage();
	const wallStart = performance.now();
	const observation = asObservation(await operation());
	const wallMs = performance.now() - wallStart;
	const cpu = process.cpuUsage(cpuStart);
	await cleanupObservation(observation);
	return buildInvocationResult(observation, wallMs, cpu);
}

function asObservation(value) {
	return value && typeof value === "object" ? value : {};
}

async function cleanupObservation(observation) {
	if (typeof observation.cleanup === "function") await observation.cleanup();
}

function buildInvocationResult(observation, wallMs, cpu) {
	return {
		wallMs: round(wallMs),
		parentCpuUserMs: round(cpu.user / 1000),
		parentCpuSystemMs: round(cpu.system / 1000),
		internalElapsedMs: observation.internalElapsedMs,
		wrapperOverheadMs: wrapperOverhead(wallMs, observation.internalElapsedMs),
		outputBytes: observation.outputBytes,
		binary: observation.binary,
		fallowVersion: observation.fallowVersion,
	};
}

function wrapperOverhead(wallMs, internalElapsedMs) {
	return internalElapsedMs === undefined ? undefined : round(wallMs - internalElapsedMs);
}

function buildMeasurement(category, scenario, cold, coldSamples, warmSamples, extra = {}) {
	return {
		key: `${category}/${scenario}`,
		category,
		scenario,
		cold,
		coldStats: summarizeSamples(coldSamples),
		warm: summarizeSamples(warmSamples),
		...extra,
	};
}

function summarizeSamples(samples) {
	const fields = ["wallMs", "parentCpuUserMs", "parentCpuSystemMs", "internalElapsedMs", "wrapperOverheadMs", "outputBytes"];
	return Object.fromEntries(fields.flatMap((field) => {
		const values = samples.map((sample) => sample[field]).filter((value) => value !== undefined);
		return values.length ? [[field, aggregate(values)]] : [];
	}));
}

function summarize(samples, field) {
	return aggregate(samples.map((sample) => sample[field]));
}

function aggregate(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		min: round(sorted[0] ?? 0),
		median: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		max: round(sorted.at(-1) ?? 0),
		mean: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
	};
}

function percentile(sorted, value) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

async function withEnvironment(values, operation) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	applyEnvironment(values);
	try {
		return await operation();
	} finally {
		applyEnvironment(previous);
	}
}

function applyEnvironment(values) {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function buildEnvironment(manifest) {
	const cpu = cpus()[0];
	return {
		piFallowVersion: manifest.version,
		gitSha: readGitSha(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cpuModel: cpu?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		totalMemoryBytes: totalmem(),
	};
}

function readGitSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function buildPerformanceFindings(items) {
	const byKey = new Map(items.map((item) => [item.key, item]));
	return {
		runner: runnerFinding(byKey),
		processing: processingFinding(byKey),
		git: gitFinding(byKey),
		memory: memoryFinding(byKey),
	};
}

function runnerFinding(byKey) {
	const fixtureDirect = byKey.get("runner/configured-fallow-bin");
	const deterministicFallback = byKey.get("runner/npx-fallback-fixture");
	const systemDirect = byKey.get("runner/system-direct-fallow");
	const systemResolution = byKey.get("runner/system-resolution");
	return {
		fixtureDirectWarmMedianMs: fixtureDirect.warm.wallMs.median,
		deterministicFallbackWarmMedianMs: deterministicFallback.warm.wallMs.median,
		fallowVersion: systemResolution.fallowVersion,
		directFallowWarmMedianMs: systemDirect.warm.wallMs.median,
		npxFallbackWarmMedianMs: systemResolution.warm.wallMs.median,
		npxWrapperOverheadMedianMs: round(systemResolution.warm.wallMs.median - systemDirect.warm.wallMs.median),
		npxToDirectRatio: round(systemResolution.warm.wallMs.median / systemDirect.warm.wallMs.median),
	};
}

function processingFinding(byKey) {
	return Object.fromEntries(PROCESSING_SCENARIOS.map((scenario) => {
		const item = byKey.get(`processing/${scenario}`);
		return [scenario, { warmMedianMs: item.warm.wallMs.median, warmP95Ms: item.warm.wallMs.p95 }];
	}));
}

function gitFinding(byKey) {
	const autocomplete = byKey.get("git/autocomplete-refs");
	const detection = byKey.get("git/base-detection");
	return {
		autocompleteColdMedianBlockedMs: autocomplete.eventLoopBlockedMs.median,
		autocompleteWarmMedianMs: autocomplete.warm.wallMs.median,
		autocompleteGitProcesses: autocomplete.subprocessesPerColdInvocation,
		baseDetectionWarmMedianMs: detection.warm.wallMs.median,
		baseDetectionGitProcesses: detection.subprocessesPerInvocation,
	};
}

function memoryFinding(byKey) {
	return Object.fromEntries(MEMORY_SCENARIOS.map((scenario) => {
		const item = byKey.get(`memory/${scenario}`);
		return [scenario, {
			retainedHeapMedianBytes: item.retained.heapUsedBytes.median,
			retainedHeapAmplification: item.retainedHeapAmplification,
			maxRssMedianBytes: item.maxRssBytes.median,
		}];
	}));
}

function printSummary(artifactValue, outputPath) {
	const timingRows = artifactValue.measurements
		.filter((item) => item.category !== "memory")
		.map((item) => ({
			key: item.key,
			coldMs: item.coldStats.wallMs.median,
			warmMedianMs: item.warm.wallMs.median,
			warmP95Ms: item.warm.wallMs.p95,
			processes: item.subprocessesPerInvocation ?? item.subprocessesPerColdInvocation ?? "",
		}));
	const memoryRows = artifactValue.measurements
		.filter((item) => item.category === "memory")
		.map((item) => ({
			key: item.key,
			fixtureKB: round(item.fixtureBytes / 1024),
			retainedHeapKB: round(item.retained.heapUsedBytes.median / 1024),
			amplification: item.retainedHeapAmplification,
			maxRssMB: round(item.maxRssBytes.median / 1024 / 1024),
		}));
	console.log(`Pi Fallow performance benchmark: ${artifactValue.label}`);
	console.log(`${artifactValue.environment.platform}/${artifactValue.environment.arch} · ${artifactValue.environment.cpuModel}`);
	console.table(timingRows);
	console.table(memoryRows);
	if (outputPath) console.log(`Wrote ${resolve(outputPath)}`);
}

function round(value) {
	return Math.round(value * 100) / 100;
}
