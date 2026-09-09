import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { inspectCoverageArtifact, buildRuntimeCoverageRequest, revalidateRuntimeCoverageRequest, localCoverageEnvironment } = await jiti.import("../extensions/fallow/runtime-coverage-options.ts");
const { RuntimeCoverageForm } = await jiti.import("../extensions/fallow/ui/runtime-coverage-form.ts");
const { runtimeCoverageExecutor } = await jiti.import("../extensions/fallow/command/runtime-coverage.ts");
const { openFallowOverviewNavigator } = await jiti.import("../extensions/fallow/command/result-flow.ts");
const { runFallowNavigatorLoop } = await jiti.import("../extensions/fallow/command/navigator-loop.ts");
const sidecar = { binaryPath: "/verified/fallow-cov", fingerprint: "verified-binary-digest" };
const ready = { phase: "ready", summary: "Signed sidecar verified", details: [], next: "Preview local artifact", runtime: sidecar };
const signal = () => new AbortController().signal;
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const text = (form, width = 100) => form.render(width).join("\n");
function enterPath(form, path) { form.handleInput("a"); form.handleInput("\x15"); for (const char of path) form.handleInput(char); form.handleInput("\r"); }
async function until(predicate) {
	const deadline = Date.now() + 3000;
	while (!predicate()) { assert.ok(Date.now() < deadline, "form check must settle"); await delay(5); }
}
async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "fallow-artifact-"));
	try {
		await writeFile(join(root, "v8.json"), '{"result":[]}');
		await writeFile(join(root, "istanbul.json"), '{}');
		await mkdir(join(root, "capture"));
		await run(root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
function createForm(root, options = {}) {
	return new RuntimeCoverageForm({ root, readiness: () => ready, checkReadiness: async () => ready, onRun() {}, ...options }, () => {});
}

it("previews only explicitly selected files/directories and builds shell-free absolute artifact requests", async () => {
	await fixture(async (root) => {
		for (const path of ["v8.json", "istanbul.json", "capture"]) {
			const preview = await inspectCoverageArtifact(root, path);
			assert.equal(preview.kind, path === "capture" ? "directory" : "file");
			assert.equal(preview.path, await realpath(join(root, path)));
			assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
			const request = buildRuntimeCoverageRequest(preview, sidecar);
			assert.deepEqual(request.commandArgs, ["coverage", "analyze", "--root", await realpath(root), "--no-cache", "--runtime-coverage", preview.path]);
			await revalidateRuntimeCoverageRequest(request, signal(), async () => ready);
		}
		const weird = join(root, 'file;$(echo test) space.json'); await writeFile(weird, "{}");
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, weird), sidecar);
		assert.equal(request.commandArgs.at(-1), await realpath(weird));
		assert.equal(await readFile(weird, "utf8"), "{}");
	});
});

it("rejects missing artifacts, blank inputs, remote/UNC/URI paths, and control characters inline", async () => {
	await fixture(async (root) => {
		for (const path of ["", "  ", "missing.json", "https://example/coverage", "s3://bucket/key", "file:///tmp/capture", "\\\\server\\capture", "//server/capture", "v8.json\n", "x".repeat(4097)]) {
			await assert.rejects(inspectCoverageArtifact(root, path));
		}
		if (process.platform !== "win32") await assert.rejects(inspectCoverageArtifact(root, "/dev/null"), /regular coverage file or directory/);
		const form = createForm(root); enterPath(form, "missing.json");
		await until(() => form.snapshot().feedback.startsWith("Check failed:"));
		assert.equal(form.snapshot().input, "missing.json"); assert.equal(form.snapshot().preview, undefined);
		assert.match(text(form), /no Run yet/); form.dispose();
	});
});

it("detects file replacement/type/metadata drift and readiness drift before a request can execute", async () => {
	await fixture(async (root) => {
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "v8.json"), sidecar);
		for (const report of [{ ...ready, phase: "missing" }, { ...ready, runtime: undefined }, { ...ready, runtime: { ...sidecar, fingerprint: "changed" } }]) {
			await assert.rejects(revalidateRuntimeCoverageRequest(request, signal(), async () => report), /readiness|sidecar changed/);
		}
		await writeFile(join(root, "v8.json"), '{"result":[],"changed":true}');
		await assert.rejects(revalidateRuntimeCoverageRequest(request, signal(), async () => ready), /Artifact.*changed/);
		const current = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "v8.json"), sidecar);
		await rename(join(root, "v8.json"), join(root, "old.json")); await mkdir(join(root, "v8.json"));
		await assert.rejects(revalidateRuntimeCoverageRequest(current, signal(), async () => ready), /Artifact.*changed/);
	});
});

it("catches artifact drift during readiness verification and symlink retargeting", { skip: process.platform === "win32" }, async () => {
	await fixture(async (root) => {
		await symlink(join(root, "v8.json"), join(root, "selected"));
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "selected"), sidecar);
		await assert.rejects(revalidateRuntimeCoverageRequest(request, signal(), async () => {
			await rm(join(root, "selected")); await symlink(join(root, "capture"), join(root, "selected"));
			return ready;
		}), /Artifact.*changed/);
	});
});

it("does not claim to recursively snapshot capture directories", async () => {
	await fixture(async (root) => {
		await writeFile(join(root, "capture", "nested.json"), "{}");
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "capture"), sidecar);
		await writeFile(join(root, "capture", "nested.json"), '{"new":"content"}');
		await revalidateRuntimeCoverageRequest(request, signal(), async () => ready);
		const form = createForm(root); enterPath(form, "capture"); await until(() => Boolean(form.snapshot().preview));
		assert.match(text(form), /not recursively snapshotted/); form.dispose();
	});
});

it("requires a preview then a distinct Run, displays scope/limitations, and preserves feedback and draft input", async () => {
	await fixture(async (root) => {
		const requests = []; const form = createForm(root, { onRun: (request) => requests.push(request) });
		form.focused = true;
		form.handleInput("a"); for (const char of "v8.json") form.handleInput(char);
		assert.ok(text(form).includes(CURSOR_MARKER)); form.focused = false; assert.ok(!text(form).includes(CURSOR_MARKER)); form.focused = true;
		form.handleInput("\x1b"); assert.equal(form.isEditing, false); assert.equal(form.snapshot().input, "v8.json");
		form.handleInput("\r"); await until(() => Boolean(form.snapshot().preview)); assert.equal(requests.length, 0);
		assert.match(text(form), /Project source scope:/); assert.match(text(form), /unknown-production/); assert.match(text(form), /No\s+capture\s+or\s+upload/);
		const snapshot = form.snapshot(); const restored = createForm(root, { initialState: snapshot });
		assert.deepEqual(restored.snapshot(), snapshot); restored.dispose();
		form.handleInput("\r"); await until(() => requests.length === 1);
		assert.equal(requests[0].artifact.path, await realpath(join(root, "v8.json")));
		for (const width of [1, 20, 50, 100]) assert.ok(form.render(width).every((line) => visibleWidth(line) <= width));
		form.dispose();
	});
});

it("blocks non-ready runs and catches stale artifact/readiness checks in the form itself", async () => {
	await fixture(async (root) => {
		let current = { ...ready, phase: "missing" }; let requests = 0;
		const form = createForm(root, { readiness: () => current, checkReadiness: async () => current, onRun: () => requests++ });
		enterPath(form, "v8.json"); await until(() => Boolean(form.snapshot().preview));
		form.handleInput("\r"); assert.match(text(form), /Run disabled/); assert.equal(requests, 0);
		current = ready; form.handleInput("v"); await until(() => Boolean(form.snapshot().sidecar));
		await writeFile(join(root, "v8.json"), '{"changed":true}');
		form.handleInput("\r"); await until(() => form.snapshot().feedback.includes("Artifact")); assert.equal(requests, 0);
		form.dispose();
	});
});

it("cancels stale preview completions on edits, back navigation, timeout, and disposal", async () => {
	await fixture(async (root) => {
		const pending = [];
		const artifact = await inspectCoverageArtifact(root, "v8.json");
		const form = createForm(root, { timeoutMs: 15, inspectArtifact: (_root, input) => new Promise((resolve) => pending.push({ input, resolve })) });
		enterPath(form, "v8.json"); await tick(); form.cancelPending(); pending[0].resolve(artifact); await tick();
		assert.equal(form.snapshot().preview, undefined); assert.match(form.snapshot().feedback, /cancelled/);
		form.handleInput("v"); await tick(); form.handleInput("a"); form.handleInput("2"); form.handleInput("\x1b"); pending[1].resolve(artifact); await tick();
		assert.equal(form.snapshot().input, "v8.json2"); assert.equal(form.snapshot().preview, undefined);
		form.handleInput("v"); await delay(35); assert.match(form.snapshot().feedback, /timed out/);
		pending[2].resolve(artifact); await tick(); assert.equal(form.snapshot().preview, undefined);
		form.handleInput("v"); await tick(); form.dispose(); pending[3].resolve(artifact); await tick(); assert.equal(form.snapshot().preview, undefined);
	});
});

it("gates the executor again, rejects changed argv, and scopes cloud-free environment only to the child", async () => {
	await fixture(async (root) => {
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "v8.json"), sidecar);
		const args = [...request.commandArgs, "--format", "json", "--quiet"];
		const calls = [];
		const execute = async (...args) => { calls.push(args); return { result: { code: 0 } }; };
		const checker = (request, abort) => revalidateRuntimeCoverageRequest(request, abort, async () => ready);
		const guarded = runtimeCoverageExecutor(request, execute, checker);
		await guarded({}, args, root, signal(), 120);
		assert.deepEqual(calls[0][5], localCoverageEnvironment(sidecar.binaryPath));
		assert.equal(calls[0][5].FALLOW_COV_BINARY_PATH, undefined);
		assert.equal(calls[0][5].FALLOW_API_KEY, undefined);
		assert.equal(calls[0][5].FALLOW_RUNTIME_COVERAGE_SOURCE, undefined);
		await assert.rejects(guarded({}, [...args, "--cloud"], root, signal(), 120), /arguments changed/);
		await writeFile(join(root, "v8.json"), '{"later":"changed"}');
		await assert.rejects(guarded({}, args, root, signal(), 120), /Artifact.*changed/);
		assert.equal(calls.length, 1); assert.equal(runtimeCoverageExecutor(undefined, execute), execute);
	});
});

it("does not execute after cancelled or timed-out preflight, even if its check completes later", async () => {
	await fixture(async (root) => {
		const request = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "v8.json"), sidecar);
		const args = [...request.commandArgs, "--format", "json", "--quiet"];
		let calls = 0; let complete;
		const guarded = runtimeCoverageExecutor(request, async () => { calls++; }, () => new Promise((resolve) => { complete = resolve; }), 15);
		const controller = new AbortController();
		const promise = guarded({}, args, root, controller.signal, 120); await tick(); controller.abort();
		await assert.rejects(promise); complete(); await tick(); assert.equal(calls, 0);
		await assert.rejects(guarded({}, args, root, signal(), 120), /timed out/);
		complete(); await tick(); assert.equal(calls, 0);
	});
});

it("keeps one overlay for artifact selection, passes preflight data to execution, and restores preview on result return", async () => {
	await fixture(async (root) => {
		let stage = 0; let saved;
		const overview = { title: "Coverage test report", status: "success", stats: [], notes: [], sections: [] };
		const ctx = { cwd: root, mode: "tui", ui: { custom: async (factory) => {
			let result;
			const shell = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { result = value; });
			shell.focused = true; await tick();
			if (stage === 1) {
				shell.handleInput("3"); await tick(); enterPath(shell, "v8.json");
				await until(() => Boolean(shell.snapshotState().runtimeCoverage.preview));
				saved = shell.snapshotState().runtimeCoverage;
				for (const key of ["1", "2", "3"]) shell.handleInput(key);
				assert.deepEqual(shell.snapshotState().runtimeCoverage, saved);
				shell.handleInput("\r"); await until(() => result !== undefined);
				saved = result.returnTo.state.overlay.runtimeCoverage;
			} else {
				if (stage === 3) { assert.match(text(shell), /\[3 Runtime Coverage\]/); assert.deepEqual(shell.snapshotState().runtimeCoverage, saved); }
				shell.handleInput("q");
			}
			return result;
		} } };
		await runFallowNavigatorLoop(["issues"], true, async (args, _remember, initialState, _protected, environment, request) => {
			stage++;
			if (stage === 2) { assert.deepEqual(args, request.commandArgs); assert.equal(request.sidecar.fingerprint, sidecar.fingerprint); assert.equal(environment, undefined); }
			if (stage === 3) assert.equal(request, undefined, "preflight/child credentials must not leak to return navigation");
			return openFallowOverviewNavigator(ctx, overview, { commandArgs: args, initialState, optionalAnalysis: true, checkReadiness: async () => ready });
		});
		assert.equal(stage, 3);
	});
});
