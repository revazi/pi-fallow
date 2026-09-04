import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowHistoryComparison } = await jiti.import("../extensions/fallow/history-comparison.ts");
const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");

function historyEntry(id, overrides = {}) {
	return {
		id,
		root: "/workspace",
		command: "fallow dead-code --format json --quiet",
		comparisonKey: '["dead-code"]',
		timestamp: "2026-09-04T00:00:00.000Z",
		kind: "dead-code",
		fallowVersion: "3.21.0",
		schemaVersion: "9",
		complete: true,
		exitCode: 1,
		findingCount: 0,
		contextCount: 0,
		...overrides,
	};
}

function deadCodeOverview(exports) {
	return buildFallowOverview({
		kind: "dead-code",
		schema_version: 9,
		version: "3.21.0",
		total_issues: exports.length,
		unused_exports: exports,
	}, exports.length ? 1 : 0);
}

function compare(priorExports, currentExports, priorOverrides = {}, currentOverrides = {}) {
	return buildFallowHistoryComparison({
		prior: historyEntry("r1", priorOverrides),
		current: historyEntry("r2", currentOverrides),
		priorOverview: deadCodeOverview(priorExports),
		currentOverview: deadCodeOverview(currentExports),
	});
}

function stats(overview) {
	return Object.fromEntries(overview.stats.map(({ label, value }) => [label, value]));
}

describe("Fallow history comparison", () => {
	it("classifies new, unchanged, and resolved findings while tolerating shifted lines", () => {
		const overview = compare(
			[
				{ kind: "unused-export", path: "src/a.ts", line: 4, export_name: "same" },
				{ kind: "unused-export", path: "src/old.ts", line: 8, export_name: "resolved" },
			],
			[
				{ kind: "unused-export", path: "src/a.ts", line: 40, export_name: "same" },
				{ kind: "unused-export", path: "src/new.ts", line: 2, export_name: "added" },
			],
		);
		assert.deepEqual(stats(overview), { new: 1, unchanged: 1, resolved: 1, unavailable: 0 });
		assert.equal(overview.sections.find((section) => section.title === "Resolved findings").role, "context");
		assert.equal(overview.sections.find((section) => section.title === "Unchanged findings").items[0].line, 40);
		const report = getNormalizedFallowReport(overview);
		assert.equal(report.findingCount, 2);
		assert.equal(report.contextCount, 1);
	});

	it("does not guess path renames unless a stable report id matches", () => {
		const conservative = compare(
			[{ kind: "unused-export", path: "src/old.ts", export_name: "moved" }],
			[{ kind: "unused-export", path: "src/new.ts", export_name: "moved" }],
		);
		assert.deepEqual(stats(conservative), { new: 1, unchanged: 0, resolved: 1, unavailable: 0 });

		const stable = compare(
			[{ id: "finding-1", kind: "unused-export", path: "src/old.ts", export_name: "moved" }],
			[{ id: "finding-1", kind: "unused-export", path: "src/new.ts", export_name: "moved" }],
		);
		assert.deepEqual(stats(stable), { new: 0, unchanged: 1, resolved: 0, unavailable: 0 });
	});

	it("marks duplicate identities unavailable instead of guessing", () => {
		const duplicate = { kind: "unused-export", path: "src/a.ts", export_name: "duplicate" };
		const overview = compare([duplicate, { ...duplicate, line: 9 }], [duplicate]);
		assert.deepEqual(stats(overview), { new: 0, unchanged: 0, resolved: 0, unavailable: 3 });
		assert.equal(getNormalizedFallowReport(overview).findingCount, 0);
		assert.equal(overview.status, "warning");
		assert.match(overview.notes.join("\n"), /duplicate identities/);
	});

	it("refuses classification across incomplete or incompatible reports", () => {
		for (const [priorOverrides, currentOverrides, expected] of [
			[{ complete: false, completenessReason: "cancelled" }, {}, /incomplete/],
			[{}, { schemaVersion: "10" }, /schema versions differ/],
			[{}, { fallowVersion: "4.0.0" }, /Fallow versions differ/],
			[{}, { kind: "security" }, /report kinds differ/],
			[{}, { comparisonKey: '["dead-code","--production"]' }, /command scopes differ/],
		]) {
			const overview = compare(
				[{ kind: "unused-export", path: "src/a.ts", export_name: "same" }],
				[{ kind: "unused-export", path: "src/a.ts", export_name: "same" }],
				priorOverrides,
				currentOverrides,
			);
			assert.deepEqual(stats(overview), { new: 0, unchanged: 0, resolved: 0, unavailable: 2 });
			assert.equal(getNormalizedFallowReport(overview).findingCount, 0);
			assert.equal(overview.status, "warning");
			assert.match(overview.notes.join("\n"), expected);
		}
	});

	it("keeps a fully resolved comparison informational rather than actionable", () => {
		const overview = compare(
			[{ kind: "unused-export", path: "src/a.ts", export_name: "gone" }],
			[],
		);
		assert.deepEqual(stats(overview), { new: 0, unchanged: 0, resolved: 1, unavailable: 0 });
		assert.equal(getNormalizedFallowReport(overview).findingCount, 0);
		assert.equal(getNormalizedFallowReport(overview).contextCount, 1);
		assert.equal(overview.status, "success");
	});
});
