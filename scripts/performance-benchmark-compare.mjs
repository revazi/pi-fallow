import { indexMeasurements, readArtifactPair } from "./benchmark-utils.mjs";

const [before, after] = await readArtifactPair(
	process.argv.slice(2),
	"Usage: node scripts/performance-benchmark-compare.mjs <before.json> <after.json>",
);
validateComparable(before, after);
warnForEnvironmentChanges(before.environment, after.environment);

const { beforeByKey, afterByKey } = indexMeasurements(before, after);
const timingRows = [];
const memoryRows = [];

for (const key of [...beforeByKey.keys()].sort()) {
	const left = beforeByKey.get(key);
	const right = afterByKey.get(key);
	if (!right) continue;
	if (left.category === "memory") memoryRows.push(compareMemory(key, left, right));
	else timingRows.push(compareTiming(key, left, right));
}

console.log(`Pi Fallow performance comparison`);
console.log(`Before: ${before.label} (${before.environment.gitSha})`);
console.log(`After:  ${after.label} (${after.environment.gitSha})`);
console.log("Warm timing (lower is better):");
console.table(timingRows);
console.log("Retained heap (lower is better):");
console.table(memoryRows);

function compareTiming(key, beforeValue, afterValue) {
	const beforeMedian = beforeValue.warm.wallMs.median;
	const afterMedian = afterValue.warm.wallMs.median;
	return {
		key,
		beforeMedianMs: beforeMedian,
		afterMedianMs: afterMedian,
		deltaMs: signed(round(afterMedian - beforeMedian)),
		reduction: formatPercent(reductionPct(beforeMedian, afterMedian)),
		beforeP95Ms: beforeValue.warm.wallMs.p95,
		afterP95Ms: afterValue.warm.wallMs.p95,
	};
}

function compareMemory(key, beforeValue, afterValue) {
	const beforeHeap = beforeValue.retained.heapUsedBytes.median;
	const afterHeap = afterValue.retained.heapUsedBytes.median;
	return {
		key,
		beforeHeapKB: round(beforeHeap / 1024),
		afterHeapKB: round(afterHeap / 1024),
		deltaKB: signed(round((afterHeap - beforeHeap) / 1024)),
		reduction: formatPercent(reductionPct(beforeHeap, afterHeap)),
		beforeAmplification: beforeValue.retainedHeapAmplification,
		afterAmplification: afterValue.retainedHeapAmplification,
	};
}

function validateComparable(left, right) {
	const mismatches = [
		["benchmarkVersion", left.benchmarkVersion, right.benchmarkVersion],
		["config", JSON.stringify(left.config), JSON.stringify(right.config)],
	].filter(([, beforeValue, afterValue]) => beforeValue !== afterValue);
	if (mismatches.length) throw new Error(`Incompatible performance artifacts: ${mismatches.map(([name]) => name).join(", ")}`);
}

function warnForEnvironmentChanges(left, right) {
	const fields = ["node", "platform", "arch", "cpuModel", "logicalCpuCount"];
	const changes = fields.filter((field) => left[field] !== right[field]);
	if (changes.length) console.warn(`Warning: environment differs for ${changes.join(", ")}; timing comparisons may be noisy.`);
}

function reductionPct(beforeValue, afterValue) {
	return beforeValue ? (beforeValue - afterValue) / beforeValue * 100 : 0;
}

function formatPercent(value) {
	return `${value.toFixed(2)}%`;
}

function signed(value) {
	return value > 0 ? `+${value}` : String(value);
}

function round(value) {
	return Math.round(value * 100) / 100;
}
