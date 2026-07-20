import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
	throw new Error("Usage: node scripts/token-benchmark-compare.mjs <before.json> <after.json>");
}

const before = JSON.parse(await readFile(resolve(beforePath), "utf8"));
const after = JSON.parse(await readFile(resolve(afterPath), "utf8"));
validateComparable(before, after);

const encoding = before.primaryEncoding;
const beforeByKey = new Map(before.measurements.map((measurement) => [measurement.key, measurement]));
const afterByKey = new Map(after.measurements.map((measurement) => [measurement.key, measurement]));
const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
const rows = [];
const surfaceTotals = new Map();
let beforeTotal = 0;
let afterTotal = 0;

for (const key of keys) {
	const left = beforeByKey.get(key);
	const right = afterByKey.get(key);
	if (!left || !right) {
		rows.push({ key, before: left?.tokens?.[encoding] ?? "missing", after: right?.tokens?.[encoding] ?? "missing", delta: "n/a", reduction: "n/a", findings: "n/a", fields: "n/a" });
		continue;
	}
	const beforeTokens = left.tokens[encoding];
	const afterTokens = right.tokens[encoding];
	beforeTotal += beforeTokens;
	afterTotal += afterTokens;
	addSurfaceTotal(surfaceTotals, left.surface, beforeTokens, afterTokens);
	rows.push({
		key,
		before: beforeTokens,
		after: afterTokens,
		delta: signed(afterTokens - beforeTokens),
		reduction: formatPercent(reductionPct(beforeTokens, afterTokens)),
		findings: `${right.quality.includedFindings}/${right.quality.expectedFindings}`,
		fields: right.quality.requiredFieldRetentionPct === null ? "n/a" : `${right.quality.requiredFieldRetentionPct}%`,
		fullOutput: right.quality.omittedFindings > 0 ? (right.quality.hasFullOutputReference ? "yes" : "no") : "n/a",
	});
}

console.log(`Pi Fallow token comparison (${encoding})`);
console.log(`Before: ${before.label} (${before.environment.gitSha})`);
console.log(`After:  ${after.label} (${after.environment.gitSha})`);
console.table([...surfaceTotals].map(([surface, totals]) => ({
	surface,
	before: totals.before,
	after: totals.after,
	delta: signed(totals.after - totals.before),
	reduction: formatPercent(reductionPct(totals.before, totals.after)),
})));
console.table(rows);
console.table([{
	before: beforeTotal,
	after: afterTotal,
	delta: signed(afterTotal - beforeTotal),
	reduction: formatPercent(reductionPct(beforeTotal, afterTotal)),
}]);

function addSurfaceTotal(totals, surface, beforeTokens, afterTokens) {
	const current = totals.get(surface) ?? { before: 0, after: 0 };
	current.before += beforeTokens;
	current.after += afterTokens;
	totals.set(surface, current);
}

function validateComparable(left, right) {
	const fields = ["benchmarkVersion", "corpusHash", "primaryEncoding"];
	const mismatches = fields.filter((field) => left[field] !== right[field]);
	if (!sameTokenizers(left.tokenizers, right.tokenizers)) mismatches.push("tokenizers");
	if (mismatches.length) throw new Error(`Incompatible benchmark artifacts: ${mismatches.join(", ")}`);
}

function sameTokenizers(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function reductionPct(beforeTokens, afterTokens) {
	return beforeTokens ? (beforeTokens - afterTokens) / beforeTokens * 100 : 0;
}

function formatPercent(value) {
	return `${value.toFixed(2)}%`;
}

function signed(value) {
	return value > 0 ? `+${value}` : String(value);
}
