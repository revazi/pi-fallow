import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests", "fixtures", "process-fixture.mjs");
const jiti = createJiti(import.meta.url);
const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const { buildFallowExecutor } = await jiti.import("../extensions/fallow/command/loader.ts");

function assignEnvironmentValue(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function applyEnvironment(values) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		assignEnvironmentValue(key, value);
	}
	return previous;
}

function restoreEnvironment(previous) {
	for (const [key, value] of previous) assignEnvironmentValue(key, value);
}

async function withFixture(mode, callback, extraEnv = {}) {
	const previous = applyEnvironment({
		FALLOW_BIN: fixture,
		PI_FALLOW_PROCESS_FIXTURE_MODE: mode,
		...extraEnv,
	});
	try {
		return await callback();
	} finally {
		restoreEnvironment(previous);
	}
}

async function waitForFile(path, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function isProcessRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	assert.equal(isProcessRunning(pid), false, `process ${pid} should have exited`);
}

function fakeResult(code, options = {}) {
	return {
		stdout: JSON.stringify({ kind: "dead-code", total_issues: code === 1 ? 1 : 0, unused_files: [], unused_exports: [] }),
		stderr: options.stderr ?? "",
		code,
		killed: options.killed ?? false,
	};
}

describe("Fallow process execution", () => {
	it("does not spawn a command for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await fallowCli.execCommand("definitely-not-a-command", [], root, controller.signal, 10);
		assert.deepEqual(result, { stdout: "", stderr: "", code: 130, killed: true });
	});

	it("reports a missing executable as a pre-execution launch failure", async () => {
		const result = await fallowCli.execCommand(join(root, "missing-fallow-binary"), [], root, undefined, 10);
		assert.equal(result.code, 127);
		assert.equal(result.killed, false);
		assert.equal(result.launchError?.code, "ENOENT");
	});

	it("distinguishes a launched command's exit 127 from a launch failure", async () => {
		await withFixture("exit-127", async () => {
			const result = await fallowCli.execCommand(fixture, [], root, undefined, 10);
			assert.equal(result.code, 127);
			assert.equal(result.launchError, undefined);
		});
	});

	it("escalates a timeout when the process ignores SIGTERM", async () => {
		await withFixture("ignore-term", async () => {
			const started = Date.now();
			const result = await fallowCli.execCommand(fixture, [], root, undefined, 1);
			assert.equal(result.killed, true);
			assert.equal(result.code, 130);
			assert.match(result.stderr, /received SIGTERM/);
			assert.ok(Date.now() - started < 3_000, "forced termination should settle promptly");
		});
	});

	it("kills descendants when cancellation terminates a wrapper process", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-cancel-"));
		const pidFile = join(workspace, "child.pid");
		let childPid;
		try {
			await withFixture("tree", async () => {
				const controller = new AbortController();
				const execution = fallowCli.execCommand(fixture, [], root, controller.signal, 10);
				await waitForFile(pidFile);
				childPid = Number(await readFile(pidFile, "utf8"));
				assert.equal(isProcessRunning(childPid), true);
				controller.abort();
				const result = await execution;
				assert.equal(result.killed, true);
				await waitForProcessExit(childPid);
			}, { PI_FALLOW_PROCESS_FIXTURE_PID_FILE: pidFile });
		} finally {
			if (childPid && isProcessRunning(childPid)) {
				try { process.kill(childPid, "SIGKILL"); } catch {}
			}
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("uses the tool signal instead of an unrelated context signal", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-tool-"));
		try {
			await withFixture("wait", async () => {
				const toolController = new AbortController();
				const contextController = new AbortController();
				const execution = fallowCli.runFallow(
					{},
					{ command: "health" },
					{ cwd: workspace, signal: contextController.signal },
					toolController.signal,
				);
				setTimeout(() => toolController.abort(), 50);
				await assert.rejects(execution, /killed=true/);
				assert.equal(contextController.signal.aborted, false);
			});
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("passes loader cancellation through the slash-command executor", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-command-"));
		try {
			await withFixture("wait", async () => {
				const loaderController = new AbortController();
				const contextController = new AbortController();
				const execute = buildFallowExecutor(
					{},
					{ cwd: workspace, mode: "tui", hasUI: true, signal: contextController.signal, ui: {} },
					["health", "--format", "json", "--quiet"],
				);
				const execution = execute(loaderController.signal);
				setTimeout(() => loaderController.abort(), 50);
				const result = await execution;
				assert.equal(result.result.killed, true);
				assert.equal(contextController.signal.aborted, false);
			});
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("Fallow exit-code semantics", () => {
	it("keeps exit code 1 as a findings result", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-exit-one-"));
		try {
			const result = await fallowEngine.runFallowWithExecutor({
				pi: {}, cwd: workspace, args: [], signal: undefined, timeoutSecs: 1,
				executor: async () => ({ binary: "fixture", args: [], result: fakeResult(1) }),
			});
			assert.equal(result.details.exitCode, 1);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("throws for exit code 2 and killed executions", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-execution-error-"));
		try {
			const input = {
				pi: {}, cwd: workspace, args: [], signal: undefined, timeoutSecs: 1,
				executor: async () => ({ binary: "fixture", args: [], result: fakeResult(2, { stderr: "bad" }) }),
			};
			await assert.rejects(fallowEngine.runFallowWithExecutor(input), /exitCode=2/);
			await assert.rejects(fallowEngine.runFallowWithExecutor({
				...input,
				executor: async () => ({ binary: "fixture", args: [], result: fakeResult(130, { killed: true }) }),
			}), /killed=true/);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
