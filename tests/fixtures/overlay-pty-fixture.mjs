// Used only by overlay-pty-probe.py: native Pi TUI + deterministic local callbacks, never real setup/inference.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createJiti } from "jiti";
import { ProcessTerminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
const jiti = createJiti(import.meta.url);
const { openFallowOverviewNavigator } = await jiti.import("../../extensions/fallow/command/result-flow.ts");
const { fallowEngine } = await jiti.import("../../extensions/fallow/engine.ts");
const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal, true);
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const log = (event) => appendFileSync(process.argv[2], JSON.stringify(event) + "\n");
let mounts = 0;
let runs = 0;
let confirms = 0;
const original = { title: "PTY original report", status: "success", stats: [], notes: [], sections: [{ title: "Exports", role: "finding", count: 1000,
	items: Array.from({ length: 1000 }, (_, i) => ({ label: `helper${i}`, path: `src/file${i}.ts`, severity: "high" })),
}] };
const result = await fallowEngine.runFallowWithExecutor({ pi: {}, cwd: process.cwd(), args: ["similar-code"], timeoutSecs: 1,
	executor: async () => ({ binary: "fixture", args: [], result: { code: 0, stderr: "", stdout: JSON.stringify({ kind: "similar-code", version: "3.22.0",
		schema_version: 1, completion: { status: "complete" }, candidates: [],
	}) } }), throwOnExecutionError: false, preserveNavigatorDetails: true,
});
const ctx = { mode: "tui", cwd: process.cwd(), hasUI: true, ui: { custom: (factory, options) => new Promise((done) => {
	mounts++;
	const shell = factory(tui, theme, {}, (value) => { log({ completed: true, mounts, runs, confirms }); handle.hide(); done(value); });
	const render = shell.render.bind(shell);
	shell.render = (width) => {
		const lines = render(width);
		assert.ok(lines.length <= Math.max(1, Math.floor(terminal.rows * .95)));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		log({ width, rows: terminal.rows, state: shell.snapshotState(), text: lines.join("\n"), mounts, runs, confirms });
		return lines;
	};
	const handle = tui.showOverlay(shell, options.overlayOptions);
}) } };
const cleanup = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 25), { once: true }));
tui.start();
try {
	await openFallowOverviewNavigator(ctx, original, {
		command: "fixture issues", commandArgs: ["issues"], optionalAnalysis: true,
		checkReadiness: async () => ({ phase: "ready", summary: "Fixture: installed", next: "No real installation or inference", details: [] }),
		runSetup: async (_view, signal, confirm, progress) => {
			if (!await confirm("Fixture pinned preview", "Source: fixture\nCommand: none\nNo real installation")) return "Fixture declined";
			confirms++; progress("Fixture installing; cancellable", "Fixture output only"); await cleanup(signal); return "Fixture settled";
		},
		runAnalysis: async (_request, signal, progress) => {
			runs++; if (runs === 1) return result;
			progress("Fixture running; cancellable"); await cleanup(signal); throw new Error("Fixture cancelled");
		},
	});
} finally { tui.stop(); }
process.exit(0);
