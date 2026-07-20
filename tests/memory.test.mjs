import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const MAX_RETAINED_AMPLIFICATION = 2;
// V8 coverage retains instrumentation counters globally, so its heap delta is not a product-memory measurement.
const memoryTest = process.env.NODE_V8_COVERAGE ? it.skip : it;

const scenarios = [
	["large findings", "benchmarks/fixtures/large-findings.json"],
	["schema", "benchmarks/fixtures/schema.json"],
];

describe("Fallow retained memory", { concurrency: false }, () => {
	for (const [name, fixture] of scenarios) {
		memoryTest(`keeps ${name} below two retained full-size copies`, async () => {
			const { stdout } = await execFileAsync(
				process.execPath,
				["--expose-gc", "scripts/performance-memory-worker.mjs", fixture],
				{ cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
			);
			const measurement = JSON.parse(stdout);
			const retainedBytes = measurement.deltaWhileRetained.heapUsedBytes;
			const amplification = retainedBytes / measurement.fixtureBytes;
			assert.ok(
				amplification <= MAX_RETAINED_AMPLIFICATION,
				`${name} retained amplification ${amplification.toFixed(2)}x exceeds ${MAX_RETAINED_AMPLIFICATION}x`,
			);
		});
	}
});
