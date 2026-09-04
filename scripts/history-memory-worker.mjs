import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";
import { createFallowBenchmarkProject, runFixtureEngine } from "./benchmark-utils.mjs";

const fixtureArg = process.argv[2];
if (!fixtureArg) throw new Error("A fixture path is required.");
if (typeof global.gc !== "function") throw new Error("Run the memory worker with --expose-gc.");

const jiti = createJiti(import.meta.url);
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const { createFallowHistoryState, recordFallowHistory, resetFallowHistory } = await jiti.import("../extensions/fallow/history.ts");
const fixtureText = await readFile(resolve(fixtureArg), "utf8");
const projectDir = await createFallowBenchmarkProject("pi-fallow-history-memory-");
const pi = { exec: async () => ({ code: 128, stdout: "", stderr: "", killed: false }) };
const state = createFallowHistoryState();

await warmHistoryPath(fixtureText);
forceGc();
const before = process.memoryUsage().heapUsed;
let result = await runReport(fixtureText);
const fullOutputPath = result.formatted.fullOutputPath;
await recordFallowHistory(pi, state, projectDir, result);
result = undefined;
forceGc();
const after = process.memoryUsage().heapUsed;

await rm(projectDir, { recursive: true, force: true });
if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
process.stdout.write(JSON.stringify({
	fixtureBytes: Buffer.byteLength(fixtureText),
	retainedHistoryBytes: after - before,
	entryCount: state.entries.length,
}));

async function warmHistoryPath(text) {
	let warmup = await runReport(text);
	const path = warmup.formatted.fullOutputPath;
	await recordFallowHistory(pi, state, projectDir, warmup);
	warmup = undefined;
	resetFallowHistory(state);
	if (path) await rm(dirname(path), { recursive: true, force: true });
}

function runReport(text) {
	return runFixtureEngine(fallowEngine, {
		scenario: { args: ["dead-code", "--format", "json", "--quiet"], exitCode: 1 },
		fixtureText: text,
		cwd: projectDir,
		preserveNavigatorDetails: true,
	});
}

function forceGc() {
	for (let iteration = 0; iteration < 3; iteration++) global.gc();
}
