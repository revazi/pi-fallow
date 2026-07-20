import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";
import { createFallowBenchmarkProject, runFixtureEngine } from "./benchmark-utils.mjs";

const fixtureArg = process.argv[2];
if (!fixtureArg) throw new Error("A fixture path is required.");
const fixturePath = resolve(fixtureArg);
if (typeof global.gc !== "function") throw new Error("Run the memory worker with --expose-gc.");

const jiti = createJiti(import.meta.url);
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const fixtureText = await readFile(fixturePath, "utf8");
const projectDir = await createFallowBenchmarkProject("pi-fallow-memory-");
forceGc();
const before = memorySnapshot();
let result = await runFixture(fixtureText, projectDir);
forceGc();
const retained = memorySnapshot();
const fullOutputPath = result.formatted.fullOutputPath;
result = undefined;
forceGc();
const released = memorySnapshot();

await cleanup(projectDir, fullOutputPath);
process.stdout.write(JSON.stringify({
	fixtureBytes: Buffer.byteLength(fixtureText),
	before,
	retained,
	released,
	deltaWhileRetained: memoryDelta(before, retained),
	deltaAfterRelease: memoryDelta(before, released),
	maxRssBytes: process.resourceUsage().maxRSS * 1024,
}));

function runFixture(fixtureText, cwd) {
	const scenario = { args: ["dead-code", "--format", "json", "--quiet"], exitCode: 0 };
	return runFixtureEngine(fallowEngine, { scenario, fixtureText, cwd });
}

function forceGc() {
	for (let iteration = 0; iteration < 3; iteration++) global.gc();
}

function memorySnapshot() {
	const usage = process.memoryUsage();
	return {
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers,
	};
}

function memoryDelta(beforeValue, afterValue) {
	return Object.fromEntries(Object.keys(beforeValue).map((key) => [key, afterValue[key] - beforeValue[key]]));
}

async function cleanup(projectDir, fullOutputPath) {
	await rm(projectDir, { recursive: true, force: true });
	if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
}
