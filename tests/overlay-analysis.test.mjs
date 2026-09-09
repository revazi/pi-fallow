import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as tick } from "node:timers/promises";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createOverlayAnalysisRun } = await jiti.import("../extensions/fallow/command/overlay-analysis.ts");
const { OverlayAnalysis } = await jiti.import("../extensions/fallow/ui/overlay-analysis.ts");
const { openFallowOverviewNavigator } = await jiti.import("../extensions/fallow/command/result-flow.ts");
const { validateSimilarCodeOptions } = await jiti.import("../extensions/fallow/similar-code-options.ts");
const { inspectCoverageArtifact, buildRuntimeCoverageRequest, revalidateRuntimeCoverageRequest } = await jiti.import("../extensions/fallow/runtime-coverage-options.ts");
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const { execFallowProcess } = await jiti.import("../extensions/fallow/process.ts");
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const ready = { phase: "ready", summary: "verified installed model", details: [], next: "Run only" };
const sidecar = { binaryPath: "/fake/signed/sidecar", fingerprint: "verified-fixture" };
const signal = () => new AbortController().signal;
const values = { scope: "", threshold: ".8", top: "5" };
const request = (root = process.cwd()) => ({ values, commandArgs: ["similar-code", "--root", root, "--threshold", "0.8", "--top", "5"] });
const semantic = (completion = "complete", candidates = true) => ({
	kind: "similar-code", version: "3.22.0", schema_version: 1, completion: { status: completion },
	generation: { model: { model_id: "fixture/model", revision: "pinned-fixture-revision" }, provider: { source_left_machine: false } },
	candidates: candidates ? [{ candidate_id: "sc_fixture", verification_status: "unverified", similarity: .95,
		left: { path: "src/a.ts", name: "normalizeA", start_line: 1 }, right: { path: "src/b.ts", name: "normalizeB", start_line: 2 } }] : [],
});
async function fixture(work) {
	const directory = await mkdtemp(join(tmpdir(), "pi-fallow-inline-analysis-"));
	try { await work(await realpath(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function until(check) {
	for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(check(), "expected async analysis state");
}
const text = (component, rows = 100) => component.render(120, rows).join("\n");
async function resultFor(data, code = 0, terminationReason) {
	return fallowEngine.runFallowWithExecutor({ pi: {}, cwd: process.cwd(), args: request().commandArgs, signal: signal(), timeoutSecs: 1,
		executor: async (_pi, args) => ({ binary: "fixture-fallow", args, result: {
			stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: "", code, terminationReason, killed: Boolean(terminationReason),
		} }), throwOnExecutionError: false, preserveNavigatorDetails: true, outputDetail: "findings",
	});
}

describe("optional analysis execution gate", () => {
	it("checks fresh readiness, canonical options, shell-free argv, complete output, and never installs", async () => {
		await fixture(async (root) => {
			const events = [];
			const run = createOverlayAnalysisRun({}, "tui", root, async () => { events.push("check"); return ready; }, {
				executeProcess: async (command, args, cwd, _signal, timeout, environment, output) => {
					events.push("execute");
					assert.doesNotMatch(command, /npx|npm/);
					assert.deepEqual(args, [...request(root).commandArgs, "--no-cache", "--format", "json", "--quiet"]);
					assert.equal(cwd, root); assert.ok(timeout > 0); assert.equal(environment, undefined);
					output("fixture progress");
					return { stdout: JSON.stringify(semantic()), stderr: "", code: 1, killed: false };
				},
			});
			const progress = [];
			const result = await run(request(root), signal(), (...args) => progress.push(args));
			assert.deepEqual(events, ["check", "execute"]);
			assert.equal(result.reportMetadata.complete, true);
			assert.equal(result.reportMetadata.fallowVersion, "3.22.0");
			assert.match(await readFile(result.formatted.fullOutputPath, "utf8"), /pinned-fixture-revision/);
			assert.ok(progress.some((args) => args[1] === "fixture progress"));
		});
	});

	it("rejects missing readiness, mutated argv, drifted scope, and non-TUI calls without execution", async () => {
		await fixture(async (root) => {
			const options = { executeProcess: () => assert.fail("must not execute") };
			for (const mode of ["rpc", "json", "print", "tool"]) await assert.rejects(createOverlayAnalysisRun({}, mode, root, () => assert.fail(), options)(request(root), signal(), () => {}), /interactive TUI/);
			await assert.rejects(createOverlayAnalysisRun({}, "tui", root, async () => ({ ...ready, phase: "missing" }), options)(request(root), signal(), () => {}), /No installation/);
			const run = createOverlayAnalysisRun({}, "tui", root, async () => ready, options);
			await assert.rejects(run({ ...request(root), commandArgs: ["similar-code", "setup"] }, signal(), () => {}), /options or scope changed/);
			await writeFile(join(root, "scope.ts"), "export const x = 1;");
			const validated = await validateSimilarCodeOptions(root, { ...values, scope: "scope.ts" });
			await rm(join(root, "scope.ts"));
			await assert.rejects(run(validated.request, signal(), () => {}), /options or scope changed/);
		});
	});

	it("bounds and cancels preflight; a late ready response cannot launch analysis", async () => {
		let resolve; let executions = 0;
		const run = createOverlayAnalysisRun({}, "tui", process.cwd(), () => new Promise((done) => { resolve = done; }), {
			preflightMs: 15, executeProcess: async () => { executions++; },
		});
		await assert.rejects(run(request(), signal(), () => {}), /preflight timed out/);
		resolve(ready); await tick(); assert.equal(executions, 0);
		const controller = new AbortController();
		const work = run(request(), controller.signal, () => {}); await tick(); controller.abort();
		await assert.rejects(work); resolve(ready); await tick(); assert.equal(executions, 0);
	});

	it("holds cancellation until its owned readiness process has finished cleanup", async () => {
		let abort; let release; let settled = false;
		const controller = new AbortController();
		const run = createOverlayAnalysisRun({}, "tui", process.cwd(), undefined, {
			executeProcess: async (_command, args, _cwd, signal) => {
				assert.deepEqual(args, ["similar-code", "status", "--format", "json", "--quiet"]);
				abort = signal;
				return new Promise((resolve) => { release = resolve; });
			},
		});
		const work = run(request(), controller.signal, () => {});
		const rejected = assert.rejects(work).then(() => { settled = true; });
		await until(() => Boolean(abort));
		controller.abort(); await tick();
		assert.equal(abort.aborted, true); assert.equal(settled, false);
		release({ stdout: "", stderr: "cancelled readiness", code: 130, killed: true, terminationReason: "cancelled" });
		await rejected; assert.equal(settled, true);
	});

	it("revalidates runtime artifact and signed binding, strips cloud variables, and refuses argument drift", async () => {
		await fixture(async (root) => {
			await writeFile(join(root, "capture.json"), "{}");
			const coverage = buildRuntimeCoverageRequest(await inspectCoverageArtifact(root, "capture.json"), sidecar);
			let report = { ...ready, runtime: sidecar };
			let executions = 0; let validations = 0;
			const run = createOverlayAnalysisRun({}, "tui", root, async () => report, {
				revalidateCoverage: async (request, abort, inspect = async () => report) => { validations++; await revalidateRuntimeCoverageRequest(request, abort, inspect); },
				executeProcess: async (_command, args, _cwd, _signal, _timeout, environment) => {
					executions++;
					assert.deepEqual(args, [...coverage.commandArgs, "--format", "json", "--quiet"]);
					assert.equal(environment.FALLOW_COV_BIN, sidecar.binaryPath);
					for (const key of ["FALLOW_API_KEY", "FALLOW_API_URL", "FALLOW_RUNTIME_COVERAGE_SOURCE", "FALLOW_REPO"]) assert.equal(environment[key], undefined);
					return { stdout: "{}", stderr: "", code: 0, killed: false };
				},
			});
			await run(coverage, signal(), () => {});
			assert.equal(executions, 1); assert.equal(validations, 2);
			await assert.rejects(run({ ...coverage, commandArgs: [...coverage.commandArgs, "--upload"] }, signal(), () => {}), /arguments changed/);
			await assert.rejects(run({ ...coverage, artifact: { ...coverage.artifact, projectRoot: "/changed" } }, signal(), () => {}), /project changed/);
			report = { ...report, runtime: { ...sidecar, fingerprint: "changed-signature" } };
			await assert.rejects(run(coverage, signal(), () => {}), /sidecar changed/);
			report = { ...report, runtime: sidecar };
			await writeFile(join(root, "capture.json"), "changed artifact");
			await assert.rejects(run(coverage, signal(), () => {}), /Artifact.*changed/);
			assert.equal(executions, 1);
		});
	});

	for (const outcome of ["cancelled", "timed-out"]) it(`retains ${outcome} results after actual fake-process cleanup`, async () => {
		const controller = new AbortController();
		const run = createOverlayAnalysisRun({}, "tui", process.cwd(), async () => ready, {
			timeoutSecs: outcome === "cancelled" ? 5 : .1,
			executeProcess: (_command, _args, cwd, abort, timeout, _env, output) => execFallowProcess(process.execPath,
				["-e", "process.stdout.write('fake local analysis'); setInterval(() => {}, 1000)"], cwd, abort, timeout, undefined, output),
		});
		const result = await run(request(), controller.signal, (_label, output) => {
			if (outcome === "cancelled" && output) controller.abort();
		});
		assert.equal(result.execution.terminationReason, outcome);
		assert.equal(result.reportMetadata.complete, false);
		assert.ok(result.formatted.fullOutputPath);
	});
});

function expectedLabel(label) { return ["partial", "error"].includes(label) ? /Analysis incomplete/ : /Analysis complete/; }

describe("persistent analysis and result views", () => {
	for (const [label, data, code] of [["success", semantic(), 1], ["empty", semantic("complete", false), 0], ["partial", semantic("partial"), 0], ["error", "fixture analysis failed", 2]]) {
		it(`renders ${label} without completing overlay and retains provenance/output references`, async () => {
			const result = await resultFor(data, code);
			const analysis = new OverlayAnalysis(async () => result, theme, () => {}, () => assert.fail("no implicit completion"));
			analysis.start(request()); await tick();
			assert.match(text(analysis), expectedLabel(label));
			assert.match(text(analysis), /advisory/);
			if (label === "success") assert.match(text(analysis), /normalizeA/);
			if (label !== "error") analysis.handleInput("I");
			assert.match(text(analysis), /Complete output:/);
			assert.match(text(analysis), /Report metadata:/);
			if (label === "success") assert.match(text(analysis), /pinned-fixture-revision/);
			analysis.handleInput("\x1b"); assert.equal(analysis.active, false);
			analysis.show("similar-code"); assert.equal(analysis.active, true);
			analysis.dispose();
		});
	}

	it("retains separate runtime and semantic navigators with conservative capture provenance", async () => {
		const fixture = JSON.parse(await readFile(new URL("./fixtures/fallow/coverage-report-3.22.0.json", import.meta.url), "utf8"));
		const semanticResult = await resultFor(semantic());
		const runtimeResult = await resultFor(fixture.report);
		const coverage = { sidecar, artifact: { projectRoot: process.cwd() }, commandArgs: ["coverage", "analyze"] };
		const analysis = new OverlayAnalysis(async (request) => "sidecar" in request ? runtimeResult : semanticResult, theme, () => {}, () => {});
		analysis.start(request()); await tick(); analysis.handleInput("s");
		const before = text(analysis);
		analysis.handleInput("b"); analysis.start(coverage); await tick();
		assert.match(text(analysis), /cold code is not proof/);
		assert.match(text(analysis), /cold/);
		analysis.handleInput("I");
		assert.match(text(analysis), /Complete output:/);
		assert.match(text(analysis), /local|Local/);
		analysis.handleInput("b"); analysis.show("similar-code");
		assert.equal(text(analysis), before);
		analysis.dispose();
	});

	it("shows recoverable preflight errors, timeout metadata, explicit retry, and scrollable sanitized output", async () => {
		let runs = 0;
		const timeout = await resultFor("partial output", 130, "timed-out");
		const complete = await resultFor(semantic("complete", false));
		const analysis = new OverlayAnalysis(async (_request, _signal, progress) => {
			runs++;
			progress("Running…", "discard prefix" + "\nline".repeat(4000) + "\x1b[2J\x07safe tail");
			return runs === 1 ? timeout : complete;
		}, theme, () => {}, () => {});
		analysis.start(request()); await tick();
		assert.match(text(analysis), /timed-out/);
		analysis.render(80, 15);
		for (const key of ["\x1b[6~", "\x1b[5~", ...Array(500).fill("\x1b[6~")]) analysis.handleInput(key);
		const output = analysis.render(80, 15).join("\n");
		assert.match(output, /safe tail/); assert.doesNotMatch(output, /[\x1b\x07]|discard prefix/);
		analysis.handleInput("r"); await tick(); assert.equal(runs, 2); assert.match(text(analysis), /Analysis complete/);
		const unavailable = new OverlayAnalysis(undefined, theme, () => {}, () => {});
		unavailable.start(request()); await tick(); assert.match(text(unavailable), /Run unavailable/);
		analysis.dispose(); unavailable.dispose();
	});

	it("owns input through cancellation, prevents overlap, suppresses disposed results, and retries only explicitly", async () => {
		let resolve; let runs = 0; let abort; let progress;
		let renders = 0;
		const analysis = new OverlayAnalysis((_request, signal, update) => { runs++; abort = signal; progress = update; return new Promise((done) => { resolve = done; }); }, theme, () => { renders++; }, () => assert.fail("closed before cleanup"));
		analysis.start(request());
		analysis.start(request()); analysis.show("runtime-coverage"); analysis.hide();
		for (const key of ["1", "S", "r", "o", "\r"]) assert.equal(analysis.handleInput(key), true);
		assert.equal(runs, 1); assert.equal(analysis.active, true);
		analysis.handleInput("q"); assert.equal(abort.aborted, true);
		progress("late output", "still shutting down"); assert.match(text(analysis), /Cancelling analysis/);
		resolve(await resultFor(semantic())); await tick(); assert.match(text(analysis), /cancelled.*incomplete/);
		analysis.handleInput("r"); assert.equal(runs, 2);
		analysis.dispose(); const count = renders;
		resolve(await resultFor(semantic())); progress("late after dispose"); await tick();
		assert.equal(renders, count);
	});

	it("keeps navigator selection, filtering, expansion, search focus, and explicit prompt actions", async () => {
		const result = await resultFor(semantic());
		const done = [];
		const analysis = new OverlayAnalysis(async () => result, theme, () => {}, (value) => done.push(value));
		analysis.focused = true; analysis.start(request()); await tick();
		for (const key of ["s", "\r", "/", "n", "o", "r", "m"]) analysis.handleInput(key);
		assert.ok(text(analysis).includes(CURSOR_MARKER));
		analysis.focused = false; analysis.invalidate(); assert.ok(!text(analysis).includes(CURSOR_MARKER));
		analysis.focused = true; analysis.invalidate();
		analysis.handleInput("\r");
		const before = text(analysis);
		analysis.handleInput("b"); analysis.show("similar-code"); assert.equal(text(analysis), before);
		analysis.handleInput("e"); assert.equal(done[0].type, "prompt");
		assert.match(done[0].prompt, /sc_fixture/);
		analysis.dispose();
	});

	it("explicit result actions return to the original report without silently repeating optional execution", async () => {
		const result = await resultFor(semantic());
		const ctx = { mode: "tui", cwd: process.cwd(), ui: { custom: async (factory) => {
			let done;
			const shell = factory({ terminal: { rows: 50 }, requestRender() {} }, theme, {}, (value) => { done = value; });
			shell.handleInput("s");
			shell.handleInput("2"); await tick(); shell.handleInput("\r");
			await until(() => shell.render(120).join("\n").includes("Analysis complete"));
			shell.handleInput("p"); shell.handleInput("\r");
			assert.equal(done.type, "action");
			assert.deepEqual(done.commandArgs, ["inspect", "--file", "src/a.ts"]);
			assert.deepEqual(done.returnTo.commandArgs, ["issues"]);
			assert.deepEqual(done.returnTo.state.markedReportIndices, [0]);
			assert.equal(done.returnTo.state.overlay.view, 1);
			return done;
		} } };
		await openFallowOverviewNavigator(ctx, result.formatted.overview, { commandArgs: ["issues"], optionalAnalysis: true,
			checkReadiness: async () => ready, runAnalysis: async () => result,
		});
	});

	it("mounts once, keeps original report and forms, separates scope from Setup, and runs neither setup nor analysis on Back", async () => {
		const result = await resultFor(semantic());
		let mounts = 0; let runs = 0; let setups = 0;
		const overview = result.formatted.overview;
		const ctx = { mode: "tui", cwd: process.cwd(), ui: { custom: async (factory) => {
			mounts++;
			let done;
			const shell = factory({ terminal: { rows: 45 }, requestRender() {} }, theme, {}, (value) => { done = value; });
			shell.focused = true;
			shell.handleInput("s"); shell.handleInput("\r");
			const original = shell.render(120).join("\n");
			shell.handleInput("2"); await tick();
			shell.handleInput("s"); assert.ok(shell.render(120).join("\n").includes(CURSOR_MARKER));
			shell.handleInput("\x1b"); assert.equal(setups, 0);
			shell.handleInput("t"); shell.handleInput(".8"); shell.handleInput("\x1b");
			const form = shell.snapshotState();
			shell.handleInput("\r"); await until(() => shell.render(120).join("\n").includes("Analysis complete"));
			assert.equal(done, undefined); assert.equal(runs, 1);
			for (const width of [1, 20, 50, 120]) assert.ok(shell.render(width).every((line) => visibleWidth(line) <= width));
			shell.handleInput("b"); assert.deepEqual(shell.snapshotState(), form);
			shell.handleInput("R"); assert.match(shell.render(120).join("\n"), /Analysis complete/);
			shell.handleInput("1"); assert.equal(shell.render(120).join("\n"), original);
			shell.handleInput("q"); return done;
		} } };
		await openFallowOverviewNavigator(ctx, overview, { commandArgs: ["issues"], optionalAnalysis: true, checkReadiness: async () => ready,
			runAnalysis: async () => { runs++; return result; }, runSetup: async () => { setups++; return "not invoked"; },
		});
		assert.equal(mounts, 1); assert.equal(runs, 1); assert.equal(setups, 0);
	});
});
