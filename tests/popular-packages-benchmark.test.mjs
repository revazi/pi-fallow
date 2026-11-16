import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(await readFile(join(root, "benchmarks", "popular-packages.json"), "utf8"));
const baseline = JSON.parse(await readFile(join(root, "benchmarks", "baselines", "popular-packages-v0.6.2.json"), "utf8"));
const readme = await readFile(join(root, "README.md"), "utf8");
const categories = new Set(["http-framework", "ui-framework", "library"]);

// Run the unmodified CLI in an isolated synthetic project. Stub the benchmark engine
// and git so these parser tests can never fetch a corpus or run Fallow workloads.
async function createCliFixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "popular-packages-cli-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "scripts"), { recursive: true });
	await mkdir(join(dir, "benchmarks"), { recursive: true });
	await mkdir(join(dir, "bin"), { recursive: true });
	for (const file of ["popular-packages-benchmark.mjs", "benchmark-utils.mjs"]) {
		await copyFile(join(root, "scripts", file), join(dir, "scripts", file));
	}
	await writeFile(join(dir, "scripts", "issues-benchmark-helpers.mjs"), `
export function buildEnvironment() { return {}; }
export async function loadIssuesBenchmarkModules() {
  return { execFallowProcess: async (_binary, _args, cwd, _signal, timeout) => {
    throw new Error("synthetic analysis: " + cwd + " timeout=" + timeout);
  } };
}
`);
	await writeFile(join(dir, "benchmarks", "popular-packages.json"), JSON.stringify({
		benchmarkVersion: 1,
		packages: ["alpha", "beta"].map((id) => ({ id, name: id, category: "library", repo: "synthetic", ref: "v1" })),
	}));
	const git = join(dir, "bin", "git");
	await writeFile(git, "#!/bin/sh\necho 'synthetic git blocked' >&2\nexit 1\n");
	await chmod(git, 0o755);
	for (const cache of [join(dir, "benchmarks", ".cache", "popular-packages"), join(dir, "custom-cache")]) {
		for (const id of ["alpha", "beta"]) await mkdir(join(cache, `${id}-v1`, ".git"), { recursive: true });
	}
	return {
		dir,
		run: (...args) => spawnSync(process.execPath, [join(dir, "scripts", "popular-packages-benchmark.mjs"), ...args], {
			cwd: dir, encoding: "utf8", env: { PATH: join(dir, "bin"), HOME: dir }, timeout: 10_000,
		}),
	};
}

describe("popular-packages benchmark", () => {
	it("uses defaults and cached synthetic packages without writing an artifact", async (t) => {
		const { dir, run } = await createCliFixture(t);
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /benchmark: working-tree/);
		assert.doesNotMatch(result.stdout, /Wrote /);
		assert.match(result.stdout, /alpha/);
		assert.match(result.stdout, /beta/);
		assert.match(result.stdout, /timeout=180/);
		assert.ok(result.stdout.includes(join(dir, "benchmarks", ".cache", "popular-packages")));
	});

	it("applies value options, filters packages and writes the requested artifact", async (t) => {
		const { dir, run } = await createCliFixture(t);
		const output = join(dir, "out", "result.json");
		const cache = join(dir, "custom-cache");
		const result = run("--label", "candidate", "--output", output, "--cache-dir", cache, "--only", " beta, ,beta ", "--timeout-secs", "7");
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /benchmark: candidate/);
		assert.ok(result.stdout.includes(`Wrote ${output}`));
		assert.match(result.stderr, /Analyzing beta@v1/);
		assert.doesNotMatch(result.stderr, /Analyzing alpha/);
		const artifact = JSON.parse(await readFile(output, "utf8"));
		assert.equal(artifact.label, "candidate");
		assert.equal(artifact.config.timeoutSecs, 7);
		assert.equal(artifact.corpus.packageCount, 1);
		assert.deepEqual(artifact.measurements.map((item) => item.id), ["beta"]);
		assert.equal(artifact.measurements[0].error, `synthetic analysis: ${join(cache, "beta-v1")} timeout=7`);
	});

	it("refreshes instead of using a cached package, with git blocked from the network", async (t) => {
		const { dir, run } = await createCliFixture(t);
		const output = join(dir, "refresh.json");
		const result = run("--refresh", "--only", "alpha", "--output", output);
		assert.equal(result.status, 0, result.stderr);
		const artifact = JSON.parse(await readFile(output, "utf8"));
		assert.match(artifact.measurements[0].error, /synthetic git blocked/);
	});

	it("rejects missing values, invalid timeouts, unknown flags and package IDs", async (t) => {
		const { run } = await createCliFixture(t);
		for (const flag of ["--label", "--output", "--cache-dir", "--only", "--timeout-secs"]) {
			const result = run(flag);
			assert.equal(result.status, 1, flag);
			assert.ok(result.stderr.includes(`${flag} requires a value.`), flag);
		}
		for (const value of ["0", "-1", "1.5", "nope"]) {
			const result = run("--timeout-secs", value);
			assert.equal(result.status, 1, value);
			assert.match(result.stderr, /--timeout-secs must be an integer >= 1/);
		}
		for (const [args, expected] of [
			[["--unknown", "value"], /Unknown argument: --unknown/],
			[["--only", "alpha,missing"], /Unknown package id\(s\): missing/],
		]) {
			const result = run(...args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, expected);
		}
	});

	it("pins a unique, complete corpus of popular JS/TS packages", () => {
		assert.equal(corpus.benchmarkVersion, 1);
		assert.ok(corpus.packages.length >= 12);
		const ids = corpus.packages.map((pkg) => pkg.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const pkg of corpus.packages) {
			assert.equal(typeof pkg.id, "string");
			assert.equal(typeof pkg.name, "string");
			assert.equal(typeof pkg.repo, "string");
			assert.equal(typeof pkg.ref, "string");
			assert.match(pkg.repo, /^https:\/\/github\.com\//);
			assert.ok(pkg.ref.length > 0);
			assert.ok(categories.has(pkg.category), `${pkg.id} has unknown category ${pkg.category}`);
		}
	});

	it("records a successful /fallow issues snapshot for every corpus package", () => {
		assert.equal(baseline.benchmarkVersion, corpus.benchmarkVersion);
		assert.equal(baseline.config.schedule, "concurrent");
		assert.equal(baseline.config.shallowClone, true);
		assert.equal(baseline.config.defaultFallowConfig, true);
		assert.equal(baseline.measurements.length, corpus.packages.length);
		const byId = new Map(baseline.measurements.map((item) => [item.id, item]));
		for (const pkg of corpus.packages) {
			const measurement = byId.get(pkg.id);
			assert.ok(measurement, `Missing measurement for ${pkg.id}`);
			assert.equal(measurement.error, undefined, `${pkg.id} recorded ${measurement.error}`);
			assert.equal(measurement.ref, pkg.ref);
			assert.ok(measurement.filesAnalyzed > 0, `${pkg.id} analyzed no files`);
			assert.ok(measurement.wallMs > 0, `${pkg.id} recorded no wall time`);
			assert.ok(measurement.navigatorFindingCount >= 0);
			assert.equal(typeof measurement.healthScore, "number");
			assert.match(measurement.healthGrade, /^[A-F]$/);
			assert.match(measurement.gitSha, /^[a-f0-9]{40}$/);
		}
	});

	it("documents the popular-packages snapshot in the README benchmarks section", () => {
		assert.match(readme, /## 📊 Benchmarks/);
		assert.match(readme, /### 📦 Popular packages/);
		assert.match(readme, /npm run bench:packages/);
		assert.match(readme, /8,493/);
		assert.match(readme, /svelte@5\.57\.0/);
		assert.match(readme, /\*\*Health\*\* is Fallow's overall project score/);
		assert.match(readme, /B 72\.9/);
		assert.match(readme, /F 16\.6/);
		assert.match(readme, /C 65\.6/);
		assert.match(readme, /benchmarks\/baselines\/popular-packages-v0\.6\.2\.json/);
		assert.match(readme, /## 🧩 More Pi packages by Revaz/);
		assert.match(readme, /pi-jscpd/);
		assert.match(readme, /pi-reads/);
	});
});
