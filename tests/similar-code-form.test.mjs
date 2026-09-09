import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { validateSimilarCodeOptions, emptySimilarCodeValues } = await jiti.import("../extensions/fallow/similar-code-options.ts");
const { SimilarCodeForm } = await jiti.import("../extensions/fallow/ui/similar-code-form.ts");
const { openFallowOverviewNavigator } = await jiti.import("../extensions/fallow/command/result-flow.ts");
const { runFallowNavigatorLoop } = await jiti.import("../extensions/fallow/command/navigator-loop.ts");
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const ready = { phase: "ready", summary: "Installed", details: [], next: "No analysis run." };
const blank = emptySimilarCodeValues;
const text = (form, width = 100) => form.render(width).join("\n");
function type(form, value) { for (const character of value) form.handleInput(character); }
function field(form, key, value) {
	form.handleInput(key); form.handleInput("\x15"); type(form, value); form.handleInput("\x1b");
}

it("omits blank overrides and creates canonical, shell-free numeric argv at boundaries", async () => {
	const root = process.cwd();
	const defaults = await validateSimilarCodeOptions(root, blank());
	assert.equal(defaults.ok, true);
	assert.deepEqual(defaults.request.commandArgs, ["similar-code", "--root", root]);
	for (const [threshold, top] of [["0", "1"], ["1", "100000"], [" .5 ", "0005"]]) {
		const values = { scope: "", threshold, top };
		const result = await validateSimilarCodeOptions(root, values);
		assert.equal(result.ok, true);
		assert.deepEqual(result.request.commandArgs, ["similar-code", "--root", root, "--threshold", String(Number(threshold)), "--top", String(Number(top))]);
		assert.deepEqual(result.request.values, values, "preserve the user's entered values separately from normalized argv");
	}
});

it("rejects malformed and out-of-range numeric fields without producing any run request", async () => {
	const inputs = {
		threshold: ["-0.1", "1.01", "NaN", "Infinity", "1e-3", "0x1", "0;echo hi", ".", "+1", "1 0"],
		top: ["0", "-1", "1.2", "100001", "0x10", "1e2", "NaN", "Infinity", "1_000", "1;echo hi"],
	};
	for (const [key, values] of Object.entries(inputs)) {
		for (const value of values) {
			const result = await validateSimilarCodeOptions(process.cwd(), { ...blank(), [key]: value });
			assert.equal(result.ok, false, `${key}=${value}`);
			assert.ok(result.errors[key]); assert.equal(result.request, undefined);
		}
	}
});

it("validates existing project files and keeps spaces and shell metacharacters in a single argv token", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-form-scope-"));
	try {
		for (const name of ["file name.ts", "file;$(echo test).ts", "-flag.ts", "..safe.ts"]) {
			await writeFile(join(root, name), "export const value = 1;");
			const result = await validateSimilarCodeOptions(root, { ...blank(), scope: `.${sep}${name}` });
			assert.equal(result.ok, true, name);
			assert.deepEqual(result.request.commandArgs, ["similar-code", "--root", resolve(root), "--file", name.startsWith("-") ? `.${sep}${name}` : name]);
		}
		await mkdir(join(root, "directory"));
		for (const scope of [".", "directory", "missing.ts", "../escape.ts", root, "https://host/file.ts", "C:\\outside.ts", "\\\\host\\file", "-flag.ts", "file\x00.ts", "x".repeat(4097)]) {
			const result = await validateSimilarCodeOptions(root, { ...blank(), scope });
			assert.equal(result.ok, false, scope);
			assert.ok(result.errors.scope); assert.equal(result.request, undefined);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects symlink escapes while accepting aliases of in-project files", { skip: process.platform === "win32" }, async () => {
	const container = await mkdtemp(join(tmpdir(), "fallow-form-links-"));
	const root = join(container, "project");
	try {
		await mkdir(root); await writeFile(join(root, "inside.ts"), ""); await writeFile(join(container, "outside.ts"), "");
		await symlink(join(container, "outside.ts"), join(root, "escape.ts"));
		await symlink(join(root, "inside.ts"), join(root, "alias.ts"));
		assert.equal((await validateSimilarCodeOptions(root, { ...blank(), scope: "escape.ts" })).ok, false);
		const result = await validateSimilarCodeOptions(root, { ...blank(), scope: "alias.ts" });
		assert.equal(result.ok, true); assert.equal(result.request.commandArgs.at(-1), "inside.ts");
	} finally { await rm(container, { recursive: true, force: true }); }
});

it("edits inline with numeric/text key ownership, field traversal, IME focus, and retained drafts on Escape", () => {
	const requests = [];
	const form = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, onRun: (request) => requests.push(request) }, () => {});
	form.focused = true;
	form.handleInput("s"); type(form, "src/123qori.ts");
	assert.ok(text(form).includes(CURSOR_MARKER));
	form.focused = false; assert.ok(!text(form).includes(CURSOR_MARKER)); form.focused = true;
	form.handleInput("\t"); type(form, ".5");
	form.handleInput("\t"); type(form, "005");
	form.handleInput("\x1b[Z"); assert.match(text(form), /Threshold/);
	form.handleInput("\x1b");
	assert.deepEqual(form.snapshot(), { scope: "src/123qori.ts", threshold: ".5", top: "005" });
	assert.ok(!text(form).includes(CURSOR_MARKER)); assert.deepEqual(requests, []);
	for (const width of [1, 10, 40, 100]) assert.ok(form.render(width).every((line) => visibleWidth(line) <= width));
	assert.deepEqual(form.render(0), []);
	form.dispose();
});

it("keeps chunked paste and control text out of navigation, submission, and terminal escape rendering", () => {
	let requests = 0;
	const form = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, onRun: () => requests++ }, () => {});
	form.handleInput("s");
	for (const chunk of ["\x1b[200~src/", "\t", "\r", "123qor\x1b[2J.ts", "\x1b[201~"]) form.handleInput(chunk);
	assert.equal(form.isEditing, true); assert.equal(requests, 0);
	assert.match(form.snapshot().scope, /123qor�\[2J\.ts/);
	assert.doesNotMatch(text(form), /\x1b\[2J/);
	form.handleInput("\t");
	assert.equal(form.snapshot().threshold, "");
	form.dispose();
});

it("shows field errors, preserves invalid values, validates without running, and gates dispatch on readiness", async () => {
	const requests = [];
	let isReady = false;
	const form = new SimilarCodeForm({ root: process.cwd(), isReady: () => isReady, onRun: (request) => requests.push(request) }, () => {});
	field(form, "t", "2"); form.handleInput("\r"); await tick();
	assert.match(text(form), /Error: Use a decimal number/); assert.equal(form.snapshot().threshold, "2");
	assert.equal(requests.length, 0);
	field(form, "t", "0.5"); form.handleInput("v"); await tick();
	assert.match(text(form), /Options valid/); assert.equal(requests.length, 0);
	form.handleInput("\r"); await tick(); assert.match(text(form), /Run blocked/);
	isReady = true; form.handleInput("\r"); await tick();
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].commandArgs.slice(-2), ["--threshold", "0.5"]);
	const restored = new SimilarCodeForm({ root: process.cwd(), initialValues: form.snapshot(), isReady: () => true }, () => {});
	assert.deepEqual(restored.snapshot(), form.snapshot());
	assert.match(text(restored), /Run unavailable/);
	restored.dispose(); form.dispose();
});

it("Enter while editing only finishes and validates; a separate Enter is required to request a run", async () => {
	let requests = 0;
	const form = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, onRun: () => requests++ }, () => {});
	form.handleInput("l"); type(form, "5"); form.handleInput("\r"); await tick();
	assert.equal(form.isEditing, false); assert.equal(requests, 0); assert.match(text(form), /Options valid/);
	form.handleInput("\r"); await tick(); assert.equal(requests, 1);
	form.dispose();
});

it("ignores stale validation after edits, view changes, or disposal and rechecks readiness before dispatch", async () => {
	const pending = [];
	const requests = [];
	let isReady = true;
	const form = new SimilarCodeForm({ root: process.cwd(), isReady: () => isReady, onRun: (request) => requests.push(request),
		validate: (_root, values) => new Promise((resolve) => pending.push({ values, resolve })),
	}, () => {});
	const complete = (index) => pending[index].resolve({ ok: true, request: { values: pending[index].values, commandArgs: ["similar-code"] } });
	form.handleInput("\r"); await tick(); field(form, "t", ".8"); complete(0); await tick(); assert.equal(requests.length, 0);
	form.handleInput("\r"); await tick(); form.cancelPending(); complete(1); await tick(); assert.equal(requests.length, 0);
	form.handleInput("\r"); await tick(); isReady = false; complete(2); await tick(); assert.equal(requests.length, 0);
	assert.match(text(form), /Run blocked/);
	isReady = true; form.handleInput("\r"); await tick(); form.dispose(); complete(3); await tick(); assert.equal(requests.length, 0);
});

it("bounds validation failures and timeouts, and performs no validation after immediate close", async () => {
	let calls = 0;
	const closed = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, validate: async () => { calls++; throw new Error("unexpected"); } }, () => {});
	closed.handleInput("v"); closed.dispose(); await tick(); assert.equal(calls, 0);
	const failed = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, validate: async () => { throw new Error("\x1b[2J" + "x".repeat(4000)); } }, () => {});
	assert.equal(failed.handleInput("__proto__"), false);
	failed.handleInput("v"); await tick(); assert.match(text(failed), /Invalid options/); assert.doesNotMatch(text(failed), /\x1b\[2J/); failed.dispose();
	let complete; let requests = 0;
	const timed = new SimilarCodeForm({ root: process.cwd(), isReady: () => true, onRun: () => requests++, validationTimeoutMs: 10,
		validate: () => new Promise((resolve) => { complete = resolve; }),
	}, () => {});
	timed.handleInput("\r"); await delay(30); assert.match(text(timed), /timed out/);
	complete({ ok: true, request: { values: blank(), commandArgs: ["similar-code"] } }); await tick(); assert.equal(requests, 0);
	timed.dispose();
});

it("retains the inline form through in-place execution without input dialogs or remounts", async () => {
	let stage = 0;
	const overview = { title: "Report", status: "success", stats: [], notes: [], sections: [] };
	const ctx = { cwd: process.cwd(), mode: "tui", ui: { custom: async (factory) => {
		let result;
		const shell = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { result = value; });
		shell.focused = true;
		await tick();
		shell.handleInput("2"); await tick();
		field(shell, "t", ".7"); field(shell, "l", "005");
		for (const key of ["3", "1", "2"]) shell.handleInput(key);
		assert.deepEqual(shell.snapshotState().similarCode, { scope: "", threshold: ".7", top: "005" });
		shell.handleInput("\r"); await tick(); await tick();
		assert.equal(result, undefined, "Run must not complete the mounted overlay");
		assert.match(text(shell), /Run failed: fixture execution error/);
		shell.handleInput("\x1b");
		assert.deepEqual(shell.snapshotState().similarCode, { scope: "", threshold: ".7", top: "005" });
		shell.handleInput("q");
		return result;
	} } };
	await runFallowNavigatorLoop(["issues"], true, async (args, _remember, initialState) => {
		stage++;
		return openFallowOverviewNavigator(ctx, overview, { commandArgs: args, optionalAnalysis: true, initialState, checkReadiness: async () => ready,
			runAnalysis: async (request) => {
				assert.deepEqual(request.commandArgs, ["similar-code", "--root", process.cwd(), "--threshold", "0.7", "--top", "5"]);
				throw new Error("fixture execution error");
			},
		});
	});
	assert.equal(stage, 1);
});
