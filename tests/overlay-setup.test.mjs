import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url);
const { OverlaySetup } = await jiti.import("../extensions/fallow/ui/overlay-setup.ts");
const { runOptionalSetup } = await jiti.import("../extensions/fallow/command/optional-analysis.ts");
const { createOverlaySetupRun } = await jiti.import("../extensions/fallow/command/overlay-setup.ts");
const { execFallowProcess } = await jiti.import("../extensions/fallow/process.ts");
const { FallowOverlayShell } = await jiti.import("../extensions/fallow/ui/overlay-shell.ts");
const { inspectRuntimeCoverageCapability } = await jiti.import("../extensions/fallow/optional-analysis.ts");
const theme = { fg: (_color, text) => text };
const missing = { kind: "similar-code-status", model_id: "jinaai/jina-embeddings-v2-base-code",
	model_revision: "516f4baf13dec4ddddda8631e019b5737c8bc250", license: "Apache-2.0", cache_dir: "/outside/model", model_ready: false };
const raw = (data, code = 0) => ({ result: { stdout: JSON.stringify(data), stderr: "", code } });
const report = { phase: "ready", summary: "Signature/integrity verified", details: [], next: "Run remains explicit" };
const text = (setup) => setup.render(110, 100, ["Readiness: ready"]).join("\n");
async function until(predicate) {
	for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "expected async setup state");
}

function workflow(view, { drift = false, fail = false, ready = false, destination = "/outside/model" } = {}) {
	let checks = 0;
	let installs = 0;
	const state = {};
	const installed = () => ready || (installs > 0 && !fail);
	const drifted = () => drift && checks > 1;
	const similarStatus = () => ({ ...missing, cache_dir: destination, model_revision: drifted() ? "drift" : missing.model_revision,
		model_ready: installed(), integrity_verified: installed() });
	const dependencies = {
		async runFallow(args) {
			if (args[0] === "coverage") return raw({ kind: "coverage-setup", schema_version: "1", commands: ["do not execute cloud work"], files_to_edit: [] });
			if (args[1] === "setup") { installs++; return raw({ installed: true }, fail ? 2 : 0); }
			checks++;
			return raw(similarStatus());
		},
		async inspectRuntime(plan) {
			checks++;
			const status = await inspectRuntimeCoverageCapability(plan, "/missing/overlay-test-sidecar");
			return { ...status, phase: installed() ? "ready" : "missing", planFingerprint: drifted() ? "changed" : status.planFingerprint };
		},
		async runProcess(command, args) {
			assert.equal(command, "npm");
			assert.ok(args.includes("--ignore-scripts"));
			assert.ok(args.includes("@fallow-cli/fallow-cov@0.4.1"));
			installs++;
			return { stdout: "installed", stderr: fail ? "network failed" : "", code: fail ? 1 : 0 };
		},
		async saveSetupOutput() { return "/tmp/fake-setup-output.txt"; },
	};
	const run = async (_view, _signal, confirm) => {
		await runOptionalSetup(view, "tui", { cwd: "/project", ui: { confirm } }, state, dependencies);
		return state.notice;
	};
	let refreshes = 0;
	const setup = new OverlaySetup(run, () => {}, () => { refreshes++; });
	setup.start(view);
	return { setup, installs: () => installs, refreshes: () => refreshes };
}

function fakeInstallerEffect(outcome) {
	if (outcome === "cancel") return "setInterval(() => {}, 1000);";
	return outcome === "failure" ? "process.stderr.write('fake network failure'); process.exitCode = 2;" : "fs.writeFileSync(marker, 'fake');";
}

async function assertAdapterOutcome(outcome, work) {
	if (outcome === "drift") await assert.rejects(() => work, /Readiness changed after preview/);
	else if (outcome === "cancel") await assert.rejects(() => work, /abort/i);
	else assert.match(await work, outcome === "failure" ? /failed.*fake network failure/s : /integrity was verified/);
}

describe("in-overlay setup safety and lifecycle", () => {
	for (const view of ["similar-code", "runtime-coverage"]) {
		it(`${view}: preview is not consent; decline never installs`, async () => {
			const { setup, installs } = workflow(view);
			await until(() => text(setup).includes("y explicitly"));
			for (const disclosure of ["Source:", "License:", "Destination:", "Command:", "Side effects:"]) assert.ok(text(setup).includes(disclosure));
			for (const key of ["\r", "s", "1", "o"]) setup.handleInput(key);
			assert.equal(installs(), 0);
			setup.handleInput("n");
			await until(() => text(setup).includes("Setup finished"));
			assert.match(text(setup), /declined/);
			assert.equal(installs(), 0);
		});
		for (const outcome of ["drift", "fail", "success"]) it(`${view}: ${outcome} after explicit confirmation`, async () => {
			const { setup, installs, refreshes } = workflow(view, { drift: outcome === "drift", fail: outcome === "fail" });
			await until(() => text(setup).includes("y explicitly"));
			setup.handleInput("y"); setup.handleInput("y");
			await until(() => text(setup).includes("Setup finished"));
			assert.equal(installs(), outcome === "drift" ? 0 : 1);
			assert.match(text(setup), outcome === "drift" ? /changed after preview/ : outcome === "fail" ? /failed/ : /verified/);
			assert.equal(refreshes(), 1);
			assert.match(text(setup), /Readiness: ready/);
		});
		it(`${view}: ready installations are not reinstalled`, async () => {
			const { setup, installs } = workflow(view, { ready: true });
			await until(() => text(setup).includes("Setup finished"));
			assert.match(text(setup), /already ready/);
			assert.equal(installs(), 0);
		});
	}

	it("blocks model setup inside the project", async () => {
		const { setup, installs } = workflow("similar-code", { destination: "/project/cache" });
		await until(() => text(setup).includes("Setup finished"));
		assert.match(text(setup), /destination must be outside/);
		assert.equal(installs(), 0);
	});

	it("cancellation holds input until child cleanup, streams bounded sanitized output, and preserves shell state", async () => {
		let release;
		let signal;
		let settled = false;
		let checks = 0;
		const findings = { focused: true, invalidate() {}, render() { return ["unchanged report"]; }, handleInput() { throw new Error("setup leaked input to findings"); } };
		const shell = new FallowOverlayShell(findings, theme, () => {}, () => 30, async () => { checks++; return report; }, {
			projectRoot: "/project", initialState: { view: 2, similarCode: { threshold: "0.85" } },
			runSetup: async (_view, abort, confirm, progress) => {
				signal = abort;
				if (!await confirm("Install?", "Preview")) return "declined";
				progress("Installing…", "x".repeat(20_000) + "\x1b[2J\x07output");
				await new Promise((resolve) => { release = resolve; });
				settled = true;
				return "finished";
			},
		});
		await tick();
		const before = shell.snapshotState();
		shell.handleInput("S"); await tick(); shell.handleInput("y"); await tick();
		for (const width of [1, 20, 80, 120]) assert.ok(shell.render(width).every((line) => visibleWidth(line) <= width));
		for (const key of ["q", "\x1b", "\x7f", "1", "o", "s", "y"]) shell.handleInput(key);
		assert.equal(signal.aborted, true);
		assert.equal(settled, false);
		assert.match(shell.render(110).join("\n"), /Cancelling/);
		assert.deepEqual(shell.snapshotState(), before);
		release(); await tick(); await tick();
		assert.match(shell.render(110).join("\n"), /Setup cancelled/);
		assert.equal(checks, 2);
		shell.handleInput("q");
		assert.deepEqual(shell.snapshotState(), before);
		shell.dispose();
	});

	it("Back during confirmation cancels without installing and remains inside setup until settled", async () => {
		const { setup, installs } = workflow("similar-code");
		await until(() => text(setup).includes("y explicitly"));
		setup.handleInput("\x1b");
		assert.equal(setup.active, true);
		await until(() => text(setup).includes("Setup cancelled"));
		assert.equal(installs(), 0);
		setup.handleInput("\x7f");
		assert.equal(setup.active, false);
	});

	it("renders unavailable setup and bounded output with scrolling and no terminal controls", async () => {
		const unavailable = new OverlaySetup(undefined, () => {}, () => {});
		unavailable.start("similar-code");
		await tick();
		assert.match(text(unavailable), /Setup unavailable/);
		const setup = new OverlaySetup(async (_view, _signal, _confirm, progress) => {
			progress("Working", "omitted prefix" + "\nline".repeat(4000) + "\x1b[2J\x07safe tail");
			return "done";
		}, () => {}, () => {});
		setup.start("similar-code"); await tick();
		setup.render(80, 12, []);
		for (const key of ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~", "\x1b[H", "\x1b[F"]) setup.handleInput(key);
		const rendered = setup.render(80, 12, []).join("\n");
		assert.match(rendered, /safe tail/);
		assert.doesNotMatch(rendered, /[\x1b\x07]|omitted prefix/);
		assert.ok(rendered.length < 12000);
	});

	it("aborts on disposal and suppresses late callbacks", async () => {
		let signal;
		let resolve;
		let renders = 0;
		const setup = new OverlaySetup(async (_view, abort) => { signal = abort; return new Promise((done) => { resolve = done; }); }, () => { renders++; }, () => assert.fail("disposed refresh"));
		setup.start("similar-code");
		setup.dispose();
		const count = renders;
		assert.equal(signal.aborted, true);
		resolve("late"); await tick();
		assert.equal(renders, count);
	});

	it("rejects non-TUI setup before any callback and avoids reinstalling discovered components", async () => {
		for (const mode of ["rpc", "json", "print", "tool"]) {
			await assert.rejects(() => runOptionalSetup("similar-code", mode, {}, {}, {}), /interactive TUI/);
			await assert.rejects(() => createOverlaySetupRun({}, mode, "/project", () => assert.fail())("similar-code", new AbortController().signal), /interactive TUI/);
		}
		const result = await createOverlaySetupRun({}, "tui", "/project", async () => report)("runtime-coverage", new AbortController().signal, () => assert.fail("must not confirm"), () => {});
		assert.match(result, /Setup did not run/);
	});

	for (const outcome of ["success", "failure", "cancel", "drift"]) it(`live adapter with fake installer: ${outcome}`, { skip: process.platform === "win32" }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-overlay-fake-"));
		const binary = join(directory, "fallow");
		const previous = process.env.FALLOW_BIN;
		let output = "";
		let checks = 0;
		const controller = new AbortController();
		try {
			await writeFile(binary, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst marker = ${JSON.stringify(join(directory, "installed"))};
if (process.argv[3] === 'status') {
 process.stdout.write(JSON.stringify({...${JSON.stringify(missing)}, model_ready: fs.existsSync(marker), integrity_verified: fs.existsSync(marker)}));
} else {
 process.stdout.write('fake installing');
 ${fakeInstallerEffect(outcome)}
}\n`);
			await chmod(binary, 0o755);
			process.env.FALLOW_BIN = binary;
			const run = createOverlaySetupRun({}, "tui", directory, async () => {
				checks++;
				return { ...report, phase: outcome === "drift" && checks > 1 ? "ready" : "missing" };
			});
			const work = run("similar-code", controller.signal, async (_title, preview) => {
				assert.match(preview, /Pinned revision:/);
				return true;
			}, (_label, chunk = "") => {
				output += chunk;
				if (outcome === "cancel" && chunk.includes("fake installing")) controller.abort();
			});
			await assertAdapterOutcome(outcome, work);
			if (outcome !== "drift") assert.match(output, /Complete setup output:/);
			else assert.doesNotMatch(output, /fake installing/);
		} finally {
			if (previous === undefined) delete process.env.FALLOW_BIN;
			else process.env.FALLOW_BIN = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses the existing real process cleanup for a fake installer, retaining final output", async () => {
		const controller = new AbortController();
		let output = "";
		const result = await execFallowProcess(process.execPath, ["-e", "process.stdout.write('fake install progress'); setInterval(() => {}, 1000)"], process.cwd(), controller.signal, 5, undefined, (chunk) => {
			output += chunk;
			controller.abort();
		});
		assert.match(output, /fake install progress/);
		assert.match(result.stdout, /fake install progress/);
		assert.equal(result.terminationReason, "cancelled");
		assert.equal(result.killed, true);
	});
});
