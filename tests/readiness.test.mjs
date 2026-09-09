import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createReadinessCheck, resolveReadinessRoot } = await jiti.import("../extensions/fallow/readiness.ts");
const { inspectRuntimeReadiness } = await jiti.import("../extensions/fallow/runtime-readiness.ts");
const { ReadinessState } = await jiti.import("../extensions/fallow/ui/readiness-state.ts");
const { createFallowRunner } = await jiti.import("../extensions/fallow/runner.ts");
const signal = () => new AbortController().signal;
const ready = { phase: "ready", summary: "Installed", details: ["Location: /cache/model"], next: "No analysis run." };
const model = { kind: "similar-code-status", model_ready: true, integrity_verified: true,
	model_id: "jinaai/jina-embeddings-v2-base-code", model_revision: "516f4baf13dec4ddddda8631e019b5737c8bc250", license: "Apache-2.0", cache_dir: "/existing/cache" };

it("uses the report's explicit project root for installation discovery", () => {
	for (const args of [["--root", "child"], ["--root=child"], ["-r", "child"], ["-rchild"]]) {
		assert.equal(resolveReadinessRoot("/project", args), resolve("/project", "child"));
	}
	assert.equal(resolveReadinessRoot("/project", ["health"]), "/project");
});

it("checks the existing model using only read-only status and refreshes runner resolution", async () => {
	let clears = 0;
	const runner = { clear() { clears++; }, async execute(_pi, args, cwd, abort, timeout) {
		assert.deepEqual(args, ["similar-code", "status", "--format", "json", "--quiet"]);
		assert.equal(cwd, "/project"); assert.ok(abort); assert.equal(timeout, 30);
		return { result: { code: 0, killed: false, stdout: JSON.stringify(model), stderr: "" } };
	} };
	const check = createReadinessCheck({}, "/project", runner);
	for (let i = 0; i < 2; i++) {
		const status = await check("similar-code", signal());
		assert.equal(status.phase, "ready");
		assert.match(status.details.join("\n"), /existing\/cache/);
		assert.match(status.details.join("\n"), new RegExp(model.model_revision));
	}
	assert.equal(clears, 2);
});

it("does not invent readiness for missing, incompatible, unverified, malformed, or failed model checks", async () => {
	for (const [patch, phase] of [[{ model_ready: false }, "missing"], [{ model_revision: "other" }, "incompatible"], [{ integrity_verified: false }, "corrupt"], [{ kind: "other" }, "error"]]) {
		const check = createReadinessCheck({}, "/project", { clear() {}, execute: async () => ({ result: { code: 0, stdout: JSON.stringify({ ...model, ...patch }) } }) });
		assert.equal((await check("similar-code", signal())).phase, phase);
	}
	const check = createReadinessCheck({}, "/project", { clear() {}, execute: async () => ({ result: { code: 2, stderr: "unavailable" } }) });
	await assert.rejects(check("similar-code", signal()), /unavailable/);
});

it("read-only runner refuses installing fallbacks, including launch-failure retry", async () => {
	const old = process.env.FALLOW_BIN;
	delete process.env.FALLOW_BIN;
	try {
		let calls = 0;
		for (const exists of [false, true]) {
			const runner = createFallowRunner({ allowNpxFallback: false, packageRoot: null,
				findExecutable: async (name) => { assert.equal(name, "fallow"); return exists ? "/gone/fallow" : undefined; },
				executeProcess: async (command) => {
					calls++; assert.equal(command, "/gone/fallow");
					return { code: 127, stdout: "", stderr: "gone", killed: false, launchError: { code: "ENOENT" } };
				},
			});
			if (exists) assert.equal((await runner.execute({}, ["similar-code", "status"], "/project", signal(), 30)).result.code, 127);
			else await assert.rejects(runner.execute({}, [], "/project", signal(), 30), /Automatic installation is disabled/);
		}
		assert.equal(calls, 1);
	} finally { if (old === undefined) delete process.env.FALLOW_BIN; else process.env.FALLOW_BIN = old; }
});

describe("per-overlay asynchronous readiness", () => {
	it("retains per-view results and details, refreshes without stale ready labels, and ignores superseded responses", async () => {
		const pending = [];
		const state = new ReadinessState((view, signal) => new Promise((resolve) => pending.push({ view, signal, resolve })), () => {});
		try {
			state.enter("similar-code"); await tick();
			assert.match(state.lines("similar-code").join("\n"), /loading/);
			state.refresh("similar-code"); await tick();
			assert.equal(pending[0].signal.aborted, true);
			pending[1].resolve(ready); await tick();
			pending[0].resolve({ ...ready, phase: "missing" }); await tick();
			assert.match(state.lines("similar-code")[0], /ready/);
			assert.doesNotMatch(state.lines("similar-code").join("\n"), /Location:/);
			state.toggleDetails("similar-code");
			state.enter("runtime-coverage"); await tick();
			pending[2].resolve({ ...ready, phase: "incompatible" }); await tick();
			state.enter("similar-code");
			assert.equal(pending.length, 3);
			assert.match(state.lines("similar-code").join("\n"), /Location:/);
			assert.match(state.lines("runtime-coverage")[0], /incompatible/);
			state.refresh("similar-code");
			assert.doesNotMatch(state.lines("similar-code")[0], /ready/);
		} finally { state.dispose(); }
	});

	it("bounds and sanitizes errors and handles unavailable checks and timeouts", async () => {
		for (const check of [undefined, async () => { throw new Error("\x1b[2J" + "x".repeat(4_000)); }]) {
			const state = new ReadinessState(check, () => {});
			state.enter("similar-code"); await tick();
			assert.match(state.lines("similar-code")[0], /check failed/);
			assert.ok(state.lines("similar-code")[1].length <= 1_000);
			assert.doesNotMatch(state.lines("similar-code").join("\n"), /\x1b/);
			state.dispose();
		}
		let abort;
		let resolve;
		const state = new ReadinessState((_view, signal) => { abort = signal; return new Promise((done) => { resolve = done; }); }, () => {}, 10);
		state.enter("similar-code"); await delay(25);
		assert.match(state.lines("similar-code").join("\n"), /timed out/);
		assert.equal(abort.aborted, true);
		resolve(ready); await tick();
		assert.match(state.lines("similar-code")[0], /check failed/);
		state.dispose();
	});

	it("aborts on disposal and ignores late completions without rendering or changing a new mount", async () => {
		let complete; let abort; let renders = 0;
		const state = new ReadinessState((_view, signal) => { abort = signal; return new Promise((resolve) => { complete = resolve; }); }, () => renders++);
		state.enter("runtime-coverage"); await tick(); state.dispose();
		assert.equal(abort.aborted, true);
		complete(ready); await tick();
		assert.equal(renders, 1);
		state.refresh("runtime-coverage"); assert.equal(renders, 1);
		const fresh = new ReadinessState(undefined, () => {});
		assert.match(fresh.lines("runtime-coverage")[0], /not checked/);
		fresh.dispose();
	});
});

const binaryName = process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov";
const platformName = `fallow-cov-${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`;
async function candidate(path, version = "0.4.1") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "not executed"); await chmod(path, 0o755);
	await writeFile(join(dirname(path), "package.json"), JSON.stringify({ name: `@fallow-cli/${platformName}`, version }));
	return path;
}

function locationPath(root, source, cwd, home) {
	if (source === "project") return join(cwd, "node_modules", "@fallow-cli", platformName, binaryName);
	if ([".pnpm", ".bun"].includes(source)) return join(cwd, "node_modules", source, `@fallow-cli+${platformName}@0.4.1`, "node_modules", "@fallow-cli", platformName, binaryName);
	if (source === "canonical") return join(home, ".fallow", "bin", binaryName);
	return join(root, source, "external", binaryName);
}

it("detects supported external sidecar locations without requiring the managed installation", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-readiness-"));
	try {
		for (const source of ["FALLOW_COV_BIN", "FALLOW_COV_BINARY_PATH", "project", ".pnpm", ".bun", "canonical", "PATH"]) {
			const cwd = join(root, source, "project"); await mkdir(cwd, { recursive: true });
			const home = join(root, source, "home");
			const environment = { PATH: "" };
			const path = locationPath(root, source, cwd, home);
			await candidate(path);
			if (source.startsWith("FALLOW")) environment[source] = path;
			if (source === "PATH") environment.PATH = dirname(path);
			const report = await inspectRuntimeReadiness(cwd, signal(), { home, environment,
				inspectManaged() { assert.fail("must detect existing installation, not require managed setup"); },
				verifyBinary: async (binary) => assert.equal(binary, await realpath(path)),
			});
			assert.equal(report.phase, "ready", source);
			assert.match(report.details.join("\n"), /0\.4\.1/);
			assert.ok(report.details.includes(`Location: ${await realpath(path)}`));
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

it("resolves a global npm PATH launcher to its existing signed platform package without executing the wrapper", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-readiness-global-"));
	try {
		const scope = join(root, "global", "node_modules", "@fallow-cli");
		const binary = await candidate(join(scope, platformName, binaryName));
		const wrapper = join(scope, "fallow-cov", "bin", "fallow-cov");
		await mkdir(dirname(wrapper), { recursive: true }); await writeFile(wrapper, "never execute this wrapper");
		const binDir = join(root, "bin"); await mkdir(binDir); await symlink(wrapper, join(binDir, "fallow-cov"));
		const report = await inspectRuntimeReadiness(root, signal(), { environment: { PATH: binDir }, home: root,
			verifyBinary: async (path) => assert.equal(path, await realpath(binary)),
		});
		assert.equal(report.phase, "ready");
		assert.ok(report.details.includes(`Location: ${await realpath(binary)}`));
	} finally { await rm(root, { recursive: true, force: true }); }
});

it("reports missing, incompatible, unsigned, signature-tampered, and unversioned installations conservatively", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-readiness-errors-"));
	try {
		const options = { home: root, environment: { PATH: "" }, inspectManaged: async () => ({ phase: "missing", destination: "/managed" }) };
		assert.equal((await inspectRuntimeReadiness(root, signal(), options)).phase, "missing");
		const path = await candidate(join(root, "external", binaryName), "9.9.9");
		options.environment.FALLOW_COV_BIN = path;
		assert.equal((await inspectRuntimeReadiness(root, signal(), options)).phase, "corrupt");
		await writeFile(`${path}.sig`, Buffer.alloc(64));
		const corrupted = await inspectRuntimeReadiness(root, signal(), options);
		assert.equal(corrupted.phase, "corrupt"); assert.match(corrupted.summary, /does not verify/);
		options.verifyBinary = async () => {};
		assert.equal((await inspectRuntimeReadiness(root, signal(), options)).phase, "incompatible");
		await rm(join(dirname(path), "package.json"));
		const unversioned = await inspectRuntimeReadiness(root, signal(), options);
		assert.equal(unversioned.phase, "corrupt"); assert.match(unversioned.summary, /version is unverified/);
		options.environment.FALLOW_COV_BIN = join(root, "missing");
		await assert.rejects(inspectRuntimeReadiness(root, signal(), options), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
