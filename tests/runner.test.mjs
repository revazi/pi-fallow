import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createFallowRunner } = await jiti.import("../extensions/fallow/runner.ts");

function executableName(name) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

async function createExecutable(directory, name) {
	await mkdir(directory, { recursive: true });
	const path = join(directory, executableName(name));
	await writeFile(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(path, 0o755);
	return path;
}

function executionResult(code = 0, extra = {}) {
	return { stdout: "{}", stderr: "", code, killed: false, ...extra };
}

function missingResult(command, code = "ENOENT") {
	return executionResult(code === "ENOENT" ? 127 : 1, {
		stderr: `${code}: ${command}`,
		launchError: { code, message: `${code}: ${command}` },
	});
}

function setEnvironment(values) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

describe("Fallow runner resolution", { concurrency: false }, () => {
	it("does not resolve or launch after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let lookups = 0;
		let executions = 0;
		const runner = createFallowRunner({
			packageRoot: null,
			findExecutable: async () => { lookups++; return undefined; },
			executeProcess: async () => { executions++; return executionResult(); },
		});
		const result = await runner.execute({}, ["health"], "/project", controller.signal, 10);
		assert.equal(result.result.killed, true);
		assert.equal(lookups, 0);
		assert.equal(executions, 0);
	});

	it("treats an explicit FALLOW_BIN launch failure as final", async () => {
		const restore = setEnvironment({ FALLOW_BIN: "/configured/fallow", PATH: "/unused" });
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			executeProcess: async (command, args) => {
				calls.push({ command, args });
				return missingResult(command);
			},
		});
		try {
			const execution = await runner.execute({}, ["health"], "/project", undefined, 10);
			assert.equal(execution.binary, "/configured/fallow");
			assert.equal(calls.length, 1);
			assert.deepEqual(calls[0], { command: "/configured/fallow", args: ["health"] });
			assert.match(execution.result.stderr, /Unable to launch FALLOW_BIN/);
		} finally {
			restore();
		}
	});

	it("caches a PATH runner and resolves again when PATH changes", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-path-"));
		const firstBin = join(workspace, "first");
		const secondBin = join(workspace, "second");
		const firstFallow = await createExecutable(firstBin, "fallow");
		const secondFallow = await createExecutable(secondBin, "fallow");
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			executeProcess: async (command) => {
				calls.push(command);
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: firstBin });
		try {
			const pi = {};
			await runner.execute(pi, ["health"], workspace, undefined, 10);
			await runner.execute(pi, ["dupes"], workspace, undefined, 10);
			process.env.PATH = secondBin;
			await runner.execute(pi, ["dead-code"], workspace, undefined, 10);
			assert.deepEqual(calls, [firstFallow, firstFallow, secondFallow]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("prefers an available package-local runner over npx", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-package-"));
		const packageRoot = join(workspace, "package");
		const pathBin = join(workspace, "path");
		const packageFallow = await createExecutable(join(workspace, ".bin"), "fallow");
		await createExecutable(pathBin, "npx");
		const calls = [];
		const runner = createFallowRunner({
			packageRoot,
			executeProcess: async (command, args) => {
				calls.push({ command, args });
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: pathBin });
		try {
			const execution = await runner.execute({}, ["health"], workspace, undefined, 10);
			assert.equal(execution.binary, packageFallow);
			assert.deepEqual(calls, [{ command: packageFallow, args: ["health"] }]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("invalidates a missing cached runner, retries once, and caches the fallback", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-retry-"));
		const bin = join(workspace, "bin");
		const fallow = await createExecutable(bin, "fallow");
		const npx = await createExecutable(bin, "npx");
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			resolveNpxPackage: false,
			executeProcess: async (command, args) => {
				calls.push({ command, args });
				if (command === fallow && calls.filter((call) => call.command === fallow).length > 1) return missingResult(command);
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: bin });
		try {
			const pi = {};
			await runner.execute(pi, ["health"], workspace, undefined, 10);
			await unlink(fallow);
			const fallback = await runner.execute(pi, ["dupes"], workspace, undefined, 10);
			await runner.execute(pi, ["dead-code"], workspace, undefined, 10);
			assert.equal(fallback.binary, "npx");
			assert.deepEqual(calls, [
				{ command: fallow, args: ["health"] },
				{ command: fallow, args: ["dupes"] },
				{ command: npx, args: ["-y", "fallow", "dupes"] },
				{ command: npx, args: ["-y", "fallow", "dead-code"] },
			]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("does not fall back after a runner starts and returns code 127", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-exit-"));
		const bin = join(workspace, "bin");
		const fallow = await createExecutable(bin, "fallow");
		await createExecutable(bin, "npx");
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			executeProcess: async (command) => {
				calls.push(command);
				return executionResult(127);
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: bin });
		try {
			const execution = await runner.execute({}, ["fix", "--yes"], workspace, undefined, 10);
			assert.equal(execution.result.code, 127);
			assert.deepEqual(calls, [fallow]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("refreshes a cached npx route after the negative-cache TTL", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-ttl-"));
		const bin = join(workspace, "bin");
		const npx = await createExecutable(bin, "npx");
		let currentTime = 0;
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			resolveNpxPackage: false,
			fallbackCacheTtlMs: 100,
			now: () => currentTime,
			executeProcess: async (command) => {
				calls.push(command);
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: bin });
		try {
			const pi = {};
			await runner.execute(pi, ["health"], workspace, undefined, 10);
			const fallow = await createExecutable(bin, "fallow");
			currentTime = 50;
			await runner.execute(pi, ["dupes"], workspace, undefined, 10);
			currentTime = 100;
			await runner.execute(pi, ["dead-code"], workspace, undefined, 10);
			assert.deepEqual(calls, [npx, npx, fallow]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("resolves the npx package once and then runs its executable directly", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-runner-npx-package-"));
		const pathBin = join(workspace, "path");
		const packageBin = join(workspace, "npx-cache", "node_modules", ".bin");
		const npx = await createExecutable(pathBin, "npx");
		const fallow = await createExecutable(packageBin, "fallow");
		const calls = [];
		const runner = createFallowRunner({
			packageRoot: null,
			executeProcess: async (command, args) => {
				calls.push({ command, args });
				if (command === npx) return executionResult(0, { stdout: packageBin });
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: pathBin });
		try {
			const pi = {};
			await runner.execute(pi, ["health"], workspace, undefined, 10);
			await runner.execute(pi, ["dupes"], workspace, undefined, 10);
			assert.deepEqual(calls, [
				{ command: npx, args: ["-y", "--package=fallow", process.execPath, "-e", "process.stdout.write(process.env.PATH || '')"] },
				{ command: fallow, args: ["health"] },
				{ command: fallow, args: ["dupes"] },
			]);
		} finally {
			restore();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("deduplicates concurrent runner resolution and clears session state", async () => {
		let releaseLookup;
		let lookupCount = 0;
		let executionCount = 0;
		const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
		const runner = createFallowRunner({
			packageRoot: null,
			findExecutable: async (name) => {
				if (name !== "fallow") return undefined;
				lookupCount++;
				await lookupGate;
				return "/resolved/fallow";
			},
			executeProcess: async () => {
				executionCount++;
				return executionResult();
			},
		});
		const restore = setEnvironment({ FALLOW_BIN: undefined, PATH: ["/one", "/two"].join(delimiter) });
		try {
			const pi = {};
			const first = runner.execute(pi, ["health"], "/project", undefined, 10);
			const second = runner.execute(pi, ["dupes"], "/project", undefined, 10);
			releaseLookup();
			await Promise.all([first, second]);
			assert.equal(lookupCount, 1);
			assert.equal(executionCount, 2);
			runner.clear(pi);
			await runner.execute(pi, ["dead-code"], "/project", undefined, 10);
			assert.equal(lookupCount, 2);
		} finally {
			restore();
		}
	});
});
