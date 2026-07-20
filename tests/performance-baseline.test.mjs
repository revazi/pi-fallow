import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await readFile(join(root, "benchmarks", "baselines", "performance-v0.2.0.json"), "utf8"));
const byKey = new Map(baseline.measurements.map((measurement) => [measurement.key, measurement]));

describe("performance benchmark baseline", () => {
	it("records runner, processing, Git, memory, and cold/warm metrics", () => {
		assert.ok(measurement("runner/system-direct-fallow"));
		assert.ok(measurement("runner/system-resolution"));
		assert.ok(measurement("processing/schema"));
		assert.ok(measurement("git/autocomplete-refs"));
		assert.ok(measurement("git/base-detection"));
		assert.ok(measurement("memory/large-findings"));
		assert.ok(measurement("runner/configured-fallow-bin").coldStats.wallMs.median > 0);
		assert.ok(measurement("runner/configured-fallow-bin").warm.wallMs.median > 0);
	});

	it("captures the current runner and Git overhead findings", () => {
		const direct = measurement("runner/system-direct-fallow");
		const npx = measurement("runner/system-resolution");
		assert.equal(npx.resolvedBinary, "npx");
		assert.ok(npx.warm.wallMs.median > direct.warm.wallMs.median);
		assert.equal(measurement("git/autocomplete-refs").subprocessesPerColdInvocation, 1);
		assert.equal(measurement("git/base-detection").subprocessesPerInvocation, 3);
	});

	it("records retained-memory scaling independently from process RSS", () => {
		const medium = measurement("memory/medium-findings");
		const large = measurement("memory/large-findings");
		assert.ok(large.retained.heapUsedBytes.median > medium.retained.heapUsedBytes.median);
		assert.ok(large.maxRssBytes.median > 0);
		assert.ok(Number.isFinite(large.retainedHeapAmplification));
	});
});

function measurement(key) {
	const value = byKey.get(key);
	assert.ok(value, `Missing performance baseline measurement: ${key}`);
	return value;
}
