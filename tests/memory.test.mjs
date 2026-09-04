import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RETAINED_AMPLIFICATION = 2;
// V8 coverage retains instrumentation counters globally, so its heap delta is not a product-memory measurement.
const memoryTest = process.env.NODE_V8_COVERAGE ? it.skip : it;

const scenarios = [
	["large findings", "benchmarks/fixtures/large-findings.json"],
	["large normalized findings", "benchmarks/fixtures/large-findings.json", "findings", 2.1],
	["schema", "benchmarks/fixtures/schema.json"],
];

describe("Fallow retained memory", { concurrency: false }, () => {
	for (const [name, fixture, outputDetail, configuredMax] of scenarios) {
		const maxRetainedAmplification = configuredMax ?? DEFAULT_MAX_RETAINED_AMPLIFICATION;
		memoryTest(`keeps ${name} below ${maxRetainedAmplification}x retained amplification`, async () => {
			const { stdout } = await execFileAsync(
				process.execPath,
				["--expose-gc", "scripts/performance-memory-worker.mjs", fixture, ...(outputDetail ? [outputDetail] : [])],
				{ cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
			);
			const measurement = JSON.parse(stdout);
			const retainedBytes = measurement.deltaWhileRetained.heapUsedBytes;
			const amplification = retainedBytes / measurement.fixtureBytes;
			assert.ok(
				amplification <= maxRetainedAmplification,
				`${name} retained amplification ${amplification.toFixed(2)}x exceeds ${maxRetainedAmplification}x`,
			);
		});
	}

	memoryTest("keeps bounded history metadata below 0.25x a large report", async () => {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--expose-gc", "scripts/history-memory-worker.mjs", "benchmarks/fixtures/large-findings.json"],
			{ cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
		);
		const measurement = JSON.parse(stdout);
		assert.equal(measurement.entryCount, 1);
		assert.ok(
			measurement.retainedHistoryBytes / measurement.fixtureBytes <= 0.25,
			`history retained ${measurement.retainedHistoryBytes} bytes for a ${measurement.fixtureBytes}-byte report`,
		);
	});
});
