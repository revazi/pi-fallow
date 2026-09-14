import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function requireValue(args, index, flag) {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

export function parseBenchmarkInteger(rawValue, flag, allowZero = false) {
	const value = Number(rawValue);
	const minimum = allowZero ? 0 : 1;
	if (!Number.isInteger(value) || value < minimum) throw new Error(`${flag} must be an integer >= ${minimum}.`);
	return value;
}

export function aggregateBenchmarkValues(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		min: roundBenchmarkValue(sorted[0] ?? 0),
		median: roundBenchmarkValue(benchmarkPercentile(sorted, 0.5)),
		p95: roundBenchmarkValue(benchmarkPercentile(sorted, 0.95)),
		max: roundBenchmarkValue(sorted.at(-1) ?? 0),
		mean: roundBenchmarkValue(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
	};
}

function benchmarkPercentile(sorted, value) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

export function roundBenchmarkValue(value) {
	return Math.round(value * 100) / 100;
}

export function readGitSha(root) {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

export async function writeJsonArtifact(artifact, outputPath) {
	if (!outputPath) return;
	const absolutePath = resolve(outputPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function readArtifactPair(args, usage) {
	const [beforePath, afterPath] = args;
	if (!beforePath || !afterPath) throw new Error(usage);
	return Promise.all([readJson(beforePath), readJson(afterPath)]);
}

async function readJson(path) {
	return JSON.parse(await readFile(resolve(path), "utf8"));
}

export function indexMeasurements(before, after) {
	return {
		beforeByKey: new Map(before.measurements.map((measurement) => [measurement.key, measurement])),
		afterByKey: new Map(after.measurements.map((measurement) => [measurement.key, measurement])),
	};
}

export async function createFallowBenchmarkProject(prefix) {
	const cwd = await mkdtemp(join(tmpdir(), prefix));
	await populateFallowProject(cwd);
	return cwd;
}

export async function populateFallowProject(cwd) {
	await mkdir(join(cwd, ".fallow"), { recursive: true });
	await writeFile(join(cwd, ".fallowrc.json"), "{}\n", "utf8");
	await writeFile(join(cwd, ".fallow", "cache.bin"), "benchmark", "utf8");
}

export function runFixtureEngine(fallowEngine, { scenario, fixtureText, cwd, preserveNavigatorDetails = false, outputDetail }) {
	return fallowEngine.runFallowWithExecutor({
		pi: {},
		cwd,
		args: scenario.args,
		signal: undefined,
		timeoutSecs: 120,
		throwOnExecutionError: false,
		preserveNavigatorDetails,
		outputDetail,
		executor: async (_pi, args) => ({
			binary: "fallow",
			args,
			result: { stdout: fixtureText, stderr: "", code: scenario.exitCode, killed: false },
		}),
	});
}
