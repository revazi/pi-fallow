import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

export function runFixtureEngine(fallowEngine, { scenario, fixtureText, cwd, preserveNavigatorDetails = false }) {
	return fallowEngine.runFallowWithExecutor({
		pi: {},
		cwd,
		args: scenario.args,
		signal: undefined,
		timeoutSecs: 120,
		throwOnExecutionError: false,
		preserveNavigatorDetails,
		executor: async (_pi, args) => ({
			binary: "fallow",
			args,
			result: { stdout: fixtureText, stderr: "", code: scenario.exitCode, killed: false },
		}),
	});
}
