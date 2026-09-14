import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
	aggregateBenchmarkValues as aggregate,
	parseBenchmarkInteger,
	readGitSha,
	requireValue,
	roundBenchmarkValue as round,
	writeJsonArtifact,
} from "./benchmark-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FALLOW_BINARY = join(ROOT, "node_modules", ".bin", "fallow");
const DEFAULT_CONFIG = { warmups: 1, iterations: 5, smallFiles: 10, largeFiles: 500, sampleIntervalMs: 10 };
const SCENARIOS = [
	{ id: "small", fileCountKey: "smallFiles" },
	{ id: "large", fileCountKey: "largeFiles" },
];
const SCHEDULES = ["sequential", "concurrent"];
const jiti = createJiti(import.meta.url);
const { fallowProjectIssues } = await jiti.import("../extensions/fallow/command/issues.ts");
const { execFallowProcess } = await jiti.import("../extensions/fallow/process.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");

const cli = parseCli(process.argv.slice(2));
const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-project-issues-"));
const measurements = [];

try {
	for (const scenario of SCENARIOS) {
		for (const schedule of SCHEDULES) {
			measurements.push(await benchmarkScenario(workspace, scenario, schedule, cli.config));
		}
	}
} finally {
	await rm(workspace, { recursive: true, force: true });
}

const artifact = {
	benchmarkVersion: 1,
	label: cli.label,
	generatedAt: new Date().toISOString(),
	config: cli.config,
	environment: buildEnvironment(),
	measurements,
	comparisons: buildComparisons(measurements),
};
await publishBenchmark(artifact, cli.output);

async function publishBenchmark(value, outputPath) {
	await writeJsonArtifact(value, outputPath);
	printSummary(value, outputPath);
}

function parseCli(args) {
	const options = { label: "working-tree", output: undefined, config: { ...DEFAULT_CONFIG } };
	const setters = {
		"--label": (value) => { options.label = value; },
		"--output": (value) => { options.output = value; },
		"--iterations": (value) => { options.config.iterations = parseBenchmarkInteger(value, "--iterations"); },
		"--warmups": (value) => { options.config.warmups = parseBenchmarkInteger(value, "--warmups", true); },
		"--large-files": (value) => { options.config.largeFiles = parseBenchmarkInteger(value, "--large-files"); },
	};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const setter = setters[flag];
		if (!setter) throw new Error(`Unknown argument: ${flag}`);
		setter(requireValue(args, index + 1, flag));
	}
	return options;
}

async function benchmarkScenario(workspace, scenario, schedule, config) {
	const fileCount = config[scenario.fileCountKey];
	const cwd = join(workspace, `${scenario.id}-${schedule}`);
	await createBenchmarkProject(cwd, fileCount);
	const cold = await runMeasuredAggregate(cwd, schedule);
	for (let index = 0; index < config.warmups; index++) await runMeasuredAggregate(cwd, schedule);
	const warmSamples = [];
	for (let index = 0; index < config.iterations; index++) warmSamples.push(await runMeasuredAggregate(cwd, schedule));
	const resources = await measureProcessTreeResources(cwd, schedule, config.sampleIntervalMs);
	return {
		key: `project-issues/${scenario.id}/${schedule}`,
		category: "project-issues",
		scenario: scenario.id,
		schedule,
		fileCount,
		cold,
		warm: summarizeSamples(warmSamples),
		resources,
	};
}

async function createBenchmarkProject(cwd, fileCount) {
	const source = join(cwd, "src");
	await mkdir(source, { recursive: true });
	await Promise.all([
		writeFile(join(cwd, ".fallowrc.json"), `${JSON.stringify({ entry: ["src/index.ts"] }, null, 2)}\n`),
		writeFile(join(cwd, "package.json"), '{"name":"project-issues-benchmark","private":true,"type":"module"}\n'),
	]);
	const exports = [];
	const modules = [];
	for (let index = 1; index <= fileCount; index++) {
		exports.push(`export { value${index} } from "./module-${index}.js";`);
		modules.push(writeFile(
			join(source, `module-${index}.ts`),
			`export function value${index}(input: number): number { return input > ${index} ? input + ${index} : input - ${index}; }\n`,
		));
	}
	await Promise.all([writeFile(join(source, "index.ts"), `${exports.join("\n")}\n`), ...modules]);
}

async function runMeasuredAggregate(cwd, schedule) {
	const tracker = createChildTracker();
	const cpuStart = process.cpuUsage();
	const wallStart = performance.now();
	const execution = await fallowProjectIssues.runCommands(
		{}, [], cwd, undefined, 120, tracker.execute, schedule,
	);
	const wallMs = performance.now() - wallStart;
	const cpu = process.cpuUsage(cpuStart);
	const navigatorStart = performance.now();
	const report = JSON.parse(execution.result.stdout);
	const overview = buildFallowOverview(report);
	const normalized = getNormalizedFallowReport(overview);
	const navigatorReadyMs = performance.now() - navigatorStart;
	return {
		wallMs: round(wallMs),
		parentCpuMs: round((cpu.user + cpu.system) / 1000),
		combinedChildMs: round(tracker.durations.combined ?? 0),
		securityChildMs: round(tracker.durations.security ?? 0),
		navigatorReadyMs: round(navigatorReadyMs),
		maxConcurrentChildren: tracker.maxActive,
		outputBytes: Buffer.byteLength(execution.result.stdout),
		findingCount: normalized.findingCount,
		exitCode: execution.result.code,
	};
}

function createChildTracker() {
	const tracker = { active: 0, maxActive: 0, durations: {}, execute: undefined };
	tracker.execute = async (_pi, args, cwd, signal, timeoutSecs) => {
		const label = args[0] === "security" ? "security" : "combined";
		tracker.active++;
		tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
		const start = performance.now();
		try {
			const result = await execFallowProcess(FALLOW_BINARY, args, cwd, signal, timeoutSecs);
			tracker.durations[label] = performance.now() - start;
			return { binary: FALLOW_BINARY, args, result };
		} finally {
			tracker.active--;
		}
	};
	return tracker;
}

async function measureProcessTreeResources(cwd, schedule, intervalMs) {
	if (process.platform === "win32") return { available: false, reason: "process-tree RSS sampling is unavailable on Windows" };
	let settled = false;
	let peakDescendantRssBytes = 0;
	let peakDescendantProcesses = 0;
	const sampling = (async () => {
		while (!settled) {
			const snapshot = readProcessSnapshot();
			const descendants = descendantProcesses(snapshot, process.pid);
			peakDescendantProcesses = Math.max(peakDescendantProcesses, descendants.length);
			peakDescendantRssBytes = Math.max(peakDescendantRssBytes, descendants.reduce((sum, item) => sum + item.rssKb * 1024, 0));
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	})();
	try {
		await fallowProjectIssues.runCommands({}, [], cwd, undefined, 120, createChildTracker().execute, schedule);
	} finally {
		settled = true;
		await sampling;
	}
	return { available: true, peakDescendantRssBytes, peakDescendantProcesses, sampleIntervalMs: intervalMs };
}

function readProcessSnapshot() {
	const text = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
	return text.split(/\r?\n/).map(parseProcessRow).filter(Boolean);
}

function parseProcessRow(line) {
	const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
	if (!match || /(?:^|\/)ps$/.test(match[4])) return undefined;
	return { pid: Number(match[1]), parentPid: Number(match[2]), rssKb: Number(match[3]) };
}

function descendantProcesses(snapshot, rootPid) {
	const descendants = [];
	const pendingParents = [rootPid];
	for (let index = 0; index < pendingParents.length; index++) {
		const children = snapshot.filter((item) => item.parentPid === pendingParents[index]);
		descendants.push(...children);
		pendingParents.push(...children.map((item) => item.pid));
	}
	return descendants;
}

function summarizeSamples(samples) {
	const fields = [
		"wallMs", "parentCpuMs", "combinedChildMs", "securityChildMs", "navigatorReadyMs",
		"maxConcurrentChildren", "outputBytes", "findingCount", "exitCode",
	];
	return Object.fromEntries(fields.map((field) => [field, aggregate(samples.map((sample) => sample[field]))]));
}

function buildComparisons(items) {
	return Object.fromEntries(SCENARIOS.map(({ id }) => {
		const sequential = items.find((item) => item.scenario === id && item.schedule === "sequential");
		const concurrent = items.find((item) => item.scenario === id && item.schedule === "concurrent");
		const before = sequential.warm.wallMs.median;
		const after = concurrent.warm.wallMs.median;
		return [id, {
			sequentialWarmMedianMs: before,
			concurrentWarmMedianMs: after,
			wallTimeReductionPercent: round(before ? (before - after) / before * 100 : 0),
			combinedChildContentionPercent: increasePercent(sequential.warm.combinedChildMs.median, concurrent.warm.combinedChildMs.median),
			securityChildContentionPercent: increasePercent(sequential.warm.securityChildMs.median, concurrent.warm.securityChildMs.median),
			sequentialPeakRssBytes: sequential.resources.peakDescendantRssBytes,
			concurrentPeakRssBytes: concurrent.resources.peakDescendantRssBytes,
		}];
	}));
}

function increasePercent(before, after) {
	return round(before ? (after - before) / before * 100 : 0);
}

function buildEnvironment() {
	const versionLine = execFileSync(FALLOW_BINARY, ["--version", "--format", "json"], { encoding: "utf8" }).split(/\r?\n/)[0];
	const version = JSON.parse(versionLine).message;
	return {
		gitSha: readGitSha(ROOT),
		node: process.version,
		fallow: version,
		platform: process.platform,
		arch: process.arch,
		cpuModel: cpus()[0]?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		totalMemoryBytes: totalmem(),
	};
}

function printSummary(value, outputPath) {
	console.log(`Pi Fallow project-issues benchmark: ${value.label}`);
	console.table(value.measurements.map((item) => ({
		scenario: item.scenario,
		schedule: item.schedule,
		files: item.fileCount,
		coldMs: item.cold.wallMs,
		warmMedianMs: item.warm.wallMs.median,
		warmP95Ms: item.warm.wallMs.p95,
		combinedMs: item.warm.combinedChildMs.median,
		securityMs: item.warm.securityChildMs.median,
		navigatorMs: item.warm.navigatorReadyMs.median,
		maxChildren: item.warm.maxConcurrentChildren.max,
		peakRssMb: item.resources.available ? round(item.resources.peakDescendantRssBytes / 1024 / 1024) : "n/a",
	})));
	console.table(Object.entries(value.comparisons).map(([scenario, comparison]) => ({ scenario, ...comparison })));
	if (outputPath) console.log(`Wrote ${resolve(outputPath)}`);
}
