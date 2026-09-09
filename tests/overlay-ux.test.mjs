import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createJiti } from "jiti";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url);
const { FallowOverlayShell } = await jiti.import("../extensions/fallow/ui/overlay-shell.ts");
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");
const { OverlayAnalysis } = await jiti.import("../extensions/fallow/ui/overlay-analysis.ts");
const { OverlaySetup } = await jiti.import("../extensions/fallow/ui/overlay-setup.ts");
const { overlayFrame, overlayRows } = await jiti.import("../extensions/fallow/ui/overlay-layout.ts");
const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: (value) => value };
const ready = { phase: "ready", summary: "Existing fixture installation", next: "Explicit Run only", details: [] };
const report = (count, role) => ({ title: "Original report", status: "success", stats: [], notes: [], sections: [{
	title: "Exports", role, count, items: Array.from({ length: count }, (_, i) => ({ label: `helper${i}`, path: `src/file${i}.ts`, severity: "high" })),
}] });
function create(count = 1000, role = "finding", phase = "ready", options = {}) {
	let rows = 24;
	const results = [];
	const findings = new FallowIssueNavigator(report(count, role), theme, (value) => results.push(value), () => {}, {
		optionalAnalysis: true, commandArgs: ["issues"], visibleRows: 8, informationalMode: role === "context",
	});
	const shell = new FallowOverlayShell(findings, theme, () => {}, () => rows, async () => ({ ...ready, phase }), options);
	shell.focused = true;
	return { shell, findings, results, resize: (value) => { rows = value; shell.invalidate(); } };
}
function bounded(component, width, rows, ...args) {
	const lines = component.render(width, rows, ...args);
	assert.ok(lines.length <= rows, `${lines.length} lines exceeds ${rows}`);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeds ${width} columns`);
	return lines.join("\n");
}

// No real analysis, installation or capability discovery occurs in this matrix.
describe("integrated optional-overlay UX matrix", () => {
	for (const [count, role] of [[0, "finding"], [8, "context"], [1000, "finding"]]) {
		for (const phase of ["ready", "missing", "incompatible", "corrupt", "unverified", "error"]) {
			for (const [width, rows] of [[40, 12], [64, 24], [120, 48]]) it(`${role}/${count}, ${phase}, ${width}×${rows}: navigation, viewport and state`, async () => {
				const { shell, findings, results, resize } = create(count, role, phase);
				try {
					resize(rows);
					const state = findings.snapshotState();
					for (const key of ["1", "2", "3", "o", "1"]) {
						shell.handleInput(key); await tick();
						const lines = shell.render(width);
						assert.ok(lines.length <= Math.floor(rows * .95));
						assert.ok(lines.every((line) => visibleWidth(line) <= width));
						assert.match(lines.join("\n"), /1 Findings.*2 Similar.*3 (Runtime )?Coverage/);
						assert.match(lines.join("\n"), shell.snapshotState().view ? /S Setup/ : /q close/);
					}
					assert.deepEqual(findings.snapshotState(), state); assert.deepEqual(results, []);
				} finally { shell.dispose(); }
			});
		}
	}

	it("follows the selected finding without losing the full scrollable report at 40×12", () => {
		const { shell, findings, resize } = create(); resize(12);
		for (const key of ["\x1b[F", "\x1b[A", "\x1b[A"]) {
			shell.handleInput(key);
			const state = findings.snapshotState();
			assert.match(shell.render(40).join("\n"), new RegExp(`helper${state.selectedReportIndex}`));
		}
		const before = findings.snapshotState();
		shell.handleInput("\x1b[5~"); const upper = shell.render(40).join("\n");
		shell.handleInput("\x1b[6~"); assert.notEqual(shell.render(40).join("\n"), upper);
		assert.deepEqual(findings.snapshotState(), before); shell.dispose();
	});

	it("keeps the active action-palette item visible in a compact viewport", () => {
		const { shell, findings, resize, results } = create(); resize(12);
		shell.handleInput("p");
		for (let i = 0; i < 12; i++) {
			assert.ok(shell.render(40).join("\n").includes(CURSOR_MARKER));
			shell.handleInput("\x1b[B");
		}
		const state = findings.snapshotState();
		shell.handleInput("2"); assert.equal(shell.snapshotState().view, 0);
		shell.handleInput("\x1b"); assert.deepEqual(findings.snapshotState(), state);
		assert.deepEqual(results, []); shell.dispose();
	});

	it("retains focus, Unicode paths and field traversal through shrink and recovery", async () => {
		const { shell, resize, results } = create(); shell.handleInput("2"); await tick(); shell.handleInput("s");
		for (const chunk of ["\x1b[200~", "目录/", "🙂".repeat(100), "123oSq", "\x1b[201~"]) shell.handleInput(chunk);
		const draft = shell.snapshotState().similarCode.scope;
		resize(12); assert.ok(shell.render(40).some((line) => line.includes(CURSOR_MARKER)));
		resize(8); assert.match(shell.render(20).join("\n"), /Resize/);
		for (const key of ["3", "S", "y", "\r", "a"]) shell.handleInput(key);
		assert.equal(shell.snapshotState().similarCode.scope, draft);
		resize(24); shell.render(80); shell.handleInput("\t"); shell.handleInput(".8"); shell.handleInput("\x1b[Z");
		assert.equal(shell.snapshotState().similarCode.threshold, ".8");
		shell.focused = false; assert.ok(!shell.render(80).join("\n").includes(CURSOR_MARKER));
		shell.focused = true; shell.handleInput("\x1b"); shell.handleInput("3"); shell.handleInput("2");
		assert.equal(shell.snapshotState().similarCode.scope, draft); assert.deepEqual(results, []); shell.dispose();
	});

	it("never treats fragmented clipboard data as setup consent, navigation, Run or close", async () => {
		let installs = 0;
		const { shell, results, resize } = create(1, "finding", "missing", { runSetup: async (_view, _abort, confirm) => {
			if (await confirm("Pinned fixture setup", "Source: fixture; no real install")) installs++;
			return "done";
		} });
		const paste = (chunks) => { for (const chunk of ["\x1b[200~", ...chunks, "\x1b[201~"]) shell.handleInput(chunk); };
		paste(["2", "S", "y", "\r", "q"]); assert.equal(shell.snapshotState().view, 0);
		shell.handleInput("2"); shell.handleInput("S"); await tick(); shell.render(80);
		paste(["y", "\r", "q", "x".repeat(20_000)]); assert.equal(installs, 0);
		resize(8); shell.render(20); shell.handleInput("y"); assert.equal(installs, 0);
		resize(24); shell.render(80); shell.handleInput("n"); await tick(); assert.equal(installs, 0);
		assert.deepEqual(results, []); shell.dispose();
	});

	it("reopening a result cancels a just-requested form validation instead of launching later", async () => {
		let runs = 0;
		const { shell } = create(0, "finding", "ready", { runAnalysis: async () => { runs++; throw new Error("fixture failure"); } });
		shell.handleInput("2"); await tick(); shell.handleInput("\r"); shell.handleInput("R");
		await tick(); assert.equal(runs, 0);
		shell.handleInput("\r"); await tick(); assert.equal(runs, 1);
		shell.handleInput("b"); shell.handleInput("\r"); shell.handleInput("R"); await tick(); assert.equal(runs, 1);
		assert.match(shell.render(80).join("\n"), /Run failed/); shell.dispose();
	});

	it("keeps long setup/error content scrollable with visible controls after repeated resize", async () => {
		const setup = new OverlaySetup(async (_view, _signal, confirm) => {
			await confirm("Long title ".repeat(100), "Source: fixture\n" + "long/path/".repeat(500) + "\nEND OF PREVIEW");
			throw new Error("long failure ".repeat(500) + "\x1b[2Junsafe");
		}, () => {}, () => {});
		setup.start("similar-code"); await tick();
		for (const [width, rows] of [[40, 11], [80, 22], [120, 45], [40, 11]]) {
			assert.match(bounded(setup, width, rows, []), /y explicitly/);
			setup.handleInput("\x1b[F"); assert.match(bounded(setup, width, rows, []), /END OF PREVIEW/);
		}
		setup.handleInput("n"); await tick();
		assert.match(bounded(setup, 40, 11, []), /Esc\/Backspace\/q Back to preserved form/); setup.dispose();
		const analysis = new OverlayAnalysis(async () => { throw new Error("long failure ".repeat(500) + "\x1b[2Junsafe"); }, theme, () => {}, () => {});
		analysis.start({ values: {}, commandArgs: ["similar-code"] }); await tick();
		for (const [width, rows] of [[40, 11], [80, 22], [120, 45], [40, 11]]) {
			const rendered = bounded(analysis, width, rows); assert.match(rendered, /Esc\/b form/); assert.doesNotMatch(rendered, /\x1b\[2J/);
		}
		analysis.dispose();
	});

	it("bounds chrome and follows cursor anchors with sensible unknown-terminal defaults", () => {
		assert.equal(overlayRows(NaN), 24); assert.equal(overlayRows(0), 24);
		for (const height of [1, 2, 3, 11, 22]) {
			const body = Array.from({ length: 100 }, (_, i) => `body ${i}`); body[90] += CURSOR_MARKER;
			const frame = overlayFrame(40, height, Array(20).fill("header"), body, Array(20).fill("footer"), 0);
			assert.ok(frame.lines.length <= height); assert.ok(frame.lines.some((line) => line.includes(CURSOR_MARKER)));
		}
	});
});
