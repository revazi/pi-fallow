import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");
const { FallowOverlayShell } = await jiti.import("../extensions/fallow/ui/overlay-shell.ts");
const { openFallowOverviewNavigator } = await jiti.import("../extensions/fallow/command/result-flow.ts");
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

function overview(role = "finding", count = 40) {
	return {
		title: "Fallow report", status: "success", stats: [], notes: [],
		sections: [{ title: "Exports", role, count, items: Array.from({ length: count }, (_, i) => ({
			label: `helper${i}`, path: `src/file${i}.ts`, severity: "high", action: "Verify usage before removal.",
			raw: { type: "unused-export", export_name: `helper${i}` },
		})) }],
	};
}

function create(role = "finding", count = 40, checkReadiness) {
	const results = [];
	let renders = 0;
	let rows = 24;
	const findings = new FallowIssueNavigator(overview(role, count), theme, (result) => results.push(result), () => { renders++; }, {
		optionalAnalysis: true, commandArgs: ["issues"], visibleRows: 3, informationalMode: role === "context",
	});
	const shell = new FallowOverlayShell(findings, theme, () => { renders++; }, () => rows, checkReadiness);
	shell.focused = true;
	return { shell, findings, results, renders: () => renders, resize: (value) => { rows = value; } };
}

function text(shell, width = 100) { return shell.render(width).join("\n"); }

describe("persistent Fallow overlay shell", () => {
	for (const [role, count] of [["finding", 40], ["context", 4], ["finding", 0]]) {
		it(`switches views without completing the overlay for ${role}/${count} reports`, () => {
			const { shell, findings, results, renders } = create(role, count);
			const original = text(shell);
			for (const label of ["Findings", "Similar Code", "Runtime Coverage"]) assert.ok(original.includes(label));
			shell.handleInput("2");
			assert.match(text(shell), /\[2 Similar Code\]/);
			assert.equal(findings.focused, false);
			shell.handleInput("3");
			assert.match(text(shell), /\[3 Runtime Coverage\]/);
			shell.handleInput("1");
			assert.equal(findings.focused, true);
			assert.equal(text(shell), original);
			assert.deepEqual(results, []);
			assert.equal(renders(), 5);
		});
	}

	it("preserves filters, selected/expanded/marked findings, scroll, and prompt detail", () => {
		const { shell, results } = create();
		for (const key of ["/", "h", "e", "l", "p", "e", "r", "\r", "f", "v", "\x1b[F", "s", "\r", "d"]) shell.handleInput(key);
		const original = text(shell);
		assert.match(original, /earlier items/);
		assert.match(original, /helper39/);
		assert.match(original, /Verify usage before removal/);
		assert.match(original, /1 selected/);
		assert.match(original, /search: helper/);
		for (const key of ["2", "3", "1"]) shell.handleInput(key);
		assert.equal(text(shell), original);
		shell.handleInput("o");
		assert.equal(results.length, 1);
		const state = results[0].returnTo.state;
		assert.equal(state.selectedReportIndex, 39);
		assert.equal(state.scrollStart, 37);
		assert.deepEqual(state.markedReportIndices, [39]);
		assert.deepEqual(state.expandedReportIndices, [39]);
		assert.equal(state.query, "helper");
		assert.equal(state.sectionFilter, 0);
		assert.equal(state.severityFilter, "high");
		assert.equal(state.includeFullDetails, true);
	});

	it("preserves numeric search, Tab selection, and action-palette modal ownership", () => {
		const { shell, results } = create();
		shell.handleInput("/");
		shell.handleInput("2");
		assert.match(text(shell), /search: 2/);
		assert.match(text(shell), /\[1 Findings\]/);
		assert.ok(text(shell).includes(CURSOR_MARKER));
		shell.focused = false;
		assert.ok(!text(shell).includes(CURSOR_MARKER));
		shell.focused = true;
		shell.handleInput("\r");
		shell.handleInput("\t");
		assert.match(text(shell), /1 selected/);
		shell.handleInput("p");
		assert.match(text(shell), /Actions for/);
		shell.handleInput("3");
		assert.match(text(shell), /\[1 Findings\]/);
		shell.handleInput("\x1b");
		assert.doesNotMatch(text(shell), /Actions for/);
		assert.deepEqual(results, []);
	});

	it("uses Escape/Backspace for optional-view Back and q for close", () => {
		const { shell, results } = create();
		for (const back of ["\x1b", "\x7f"]) {
			shell.handleInput("2");
			shell.handleInput(back);
			assert.match(text(shell), /\[1 Findings\]/);
		}
		assert.deepEqual(results, []);
		shell.handleInput("3");
		shell.handleInput("q");
		assert.deepEqual(results, [null]);
		const other = create();
		other.shell.handleInput("\x1b");
		assert.deepEqual(other.results, [null]);
	});

	it("retains independent optional-view scroll positions with bounded responsive output", () => {
		const { shell, resize, results } = create();
		resize(14);
		shell.handleInput("2");
		const first = text(shell, 50);
		shell.handleInput("\x1b[F");
		const scrolled = text(shell, 50);
		assert.notEqual(scrolled, first);
		shell.handleInput("3");
		assert.match(text(shell, 50), /Local\/unknown-production/);
		shell.handleInput("2");
		assert.equal(text(shell, 50), scrolled);
		for (const width of [1, 20, 50, 80, 120]) {
			assert.ok(shell.render(width).every((line) => visibleWidth(line) <= width));
		}
		assert.deepEqual(shell.render(0), []);
		resize(40);
		shell.invalidate();
		assert.ok(shell.render(80).length <= 38);
		assert.deepEqual(results, []);
	});

	it("does not run finding actions from optional views and keeps the existing workflow explicit", () => {
		const { shell, results } = create();
		shell.handleInput("2");
		assert.match(text(shell), /Readiness: loading/);
		assert.match(text(shell), /Checks never install/);
		for (const key of ["e", "a", "p"]) shell.handleInput(key);
		assert.deepEqual(results, []);
		shell.handleInput("o");
		assert.deepEqual(results[0].commandArgs, ["__pi-fallow-optional-analysis"]);
		assert.deepEqual(results[0].returnTo.commandArgs, ["issues"]);
	});

	it("checks, refreshes, and expands details inside the same shell without dispatching legacy actions", async () => {
		const calls = [];
		const { shell, results } = create("finding", 0, async (view) => {
			calls.push(view);
			return { phase: "ready", summary: "Installed and verified", details: ["Location: /installed/model"], next: "No analysis run." };
		});
		assert.deepEqual(calls, []);
		shell.handleInput("2"); await tick();
		assert.match(text(shell), /Readiness: ready/);
		assert.doesNotMatch(text(shell), /Location:/);
		shell.handleInput("i");
		assert.match(text(shell), /Location: \/installed\/model/);
		shell.handleInput("r");
		assert.match(text(shell), /Readiness: loading/);
		await tick();
		for (const key of ["3", "1", "2"]) shell.handleInput(key);
		await tick();
		assert.match(text(shell), /Location:/);
		assert.deepEqual(calls, ["similar-code", "similar-code", "runtime-coverage"]);
		assert.deepEqual(results, []);
		shell.dispose();
	});

	it("aborts pending readiness synchronously when the custom UI completes", async () => {
		let signal;
		const ctx = { mode: "tui", ui: { custom: async (factory) => {
			let result;
			const shell = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { result = value; });
			shell.handleInput("2"); await tick();
			shell.handleInput("q");
			assert.equal(signal.aborted, true);
			return result;
		} } };
		await openFallowOverviewNavigator(ctx, overview(), { commandArgs: ["issues"], optionalAnalysis: true,
			checkReadiness: (_view, abort) => { signal = abort; return new Promise(() => {}); },
		});
	});

	it("mounts one custom UI and never dispatches a dialog or analysis on view changes", async () => {
		let mounts = 0;
		const ctx = { mode: "tui", ui: { custom: async (factory, options) => {
			mounts++;
			assert.equal(options.overlay, true);
			let result;
			const shell = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { result = value; });
			for (const key of ["2", "3", "1", "2", "\x1b"]) {
				shell.handleInput(key);
				shell.render(100);
				assert.equal(result, undefined);
			}
			shell.handleInput("q");
			return result;
		} } };
		assert.equal(await openFallowOverviewNavigator(ctx, overview("finding", 0), { command: "fallow", commandArgs: ["issues"], optionalAnalysis: true }), null);
		assert.equal(mounts, 1);
		for (const mode of ["rpc", "json", "print"]) {
			assert.equal(await openFallowOverviewNavigator({ ...ctx, mode }, overview(), { commandArgs: ["issues"], optionalAnalysis: true }), null);
		}
		assert.equal(mounts, 1);
	});
});
