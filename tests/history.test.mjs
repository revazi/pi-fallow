import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	FALLOW_HISTORY_LIMIT,
	createFallowHistoryState,
	findFallowHistoryEntry,
	getFallowHistoryArtifactStatus,
	listFallowHistory,
	readFallowHistoryArtifact,
	recordFallowHistory,
	resetFallowHistory,
} = await jiti.import("../extensions/fallow/history.ts");

const head = "0123456789abcdef0123456789abcdef01234567";
const pi = { exec: async () => ({ code: 0, stdout: `${head}\n`, stderr: "", killed: false }) };

function scopeDigest(args) {
	return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

function fakeResult(reportPath, overrides = {}) {
	return {
		binary: "fallow",
		args: ["dead-code", "--format", "json", "--quiet"],
		execution: { code: 1, killed: false },
		reportMetadata: {
			kind: "dead-code",
			fallowVersion: "3.21.0",
			schemaVersion: "9",
			complete: true,
		},
		formatted: {
			fullOutputPath: reportPath,
			overview: {
				title: "Dead code",
				status: "warning",
				stats: [],
				sections: [{ title: "Unused exports", items: [{ label: "oldExport", path: "src/a.ts", line: 4 }] }],
				notes: [],
			},
		},
		...overrides,
	};
}

describe("Fallow session history", () => {
	it("records bounded metadata and validates retained artifacts without retaining reports", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-history-"));
		const reportPath = join(directory, "report.json");
		await writeFile(reportPath, JSON.stringify({ kind: "dead-code" }));
		try {
			const state = createFallowHistoryState();
			const result = fakeResult(reportPath);
			for (let index = 0; index < FALLOW_HISTORY_LIMIT + 2; index++) {
				await recordFallowHistory(pi, state, "/workspace/a", result);
			}
			assert.equal(state.entries.length, FALLOW_HISTORY_LIMIT);
			assert.equal(state.entries[0].id, "r3");
			assert.equal(state.entries.at(-1).id, "r22");
			assert.equal(state.entries.at(-1).gitHead, head);
			assert.equal(state.entries.at(-1).comparisonKey, scopeDigest(["dead-code"]));
			assert.equal(state.entries.at(-1).findingCount, 1);
			assert.equal("overview" in state.entries.at(-1), false);
			assert.equal(await getFallowHistoryArtifactStatus(state.entries.at(-1)), "available");
			assert.equal(await readFallowHistoryArtifact(state.entries.at(-1)), JSON.stringify({ kind: "dead-code" }));
			await recordFallowHistory(pi, state, "/workspace/a", result, ["r3"]);
			assert.equal(state.entries.length, FALLOW_HISTORY_LIMIT);
			assert.ok(state.entries.some(({ id }) => id === "r3"));
			assert.equal(state.entries.some(({ id }) => id === "r4"), false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("isolates roots, reports drift and expiry, and resets at session boundaries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-history-boundary-"));
		const reportPath = join(directory, "report.json");
		await writeFile(reportPath, "{}\n");
		try {
			const state = createFallowHistoryState();
			const entry = await recordFallowHistory(pi, state, "/workspace/a", fakeResult(reportPath));
			assert.deepEqual(listFallowHistory(state, "/workspace/b"), []);
			assert.equal(findFallowHistoryEntry(state, "/workspace/b", entry.id), undefined);
			await writeFile(reportPath, "{\"changed\":true}\n");
			assert.equal(await getFallowHistoryArtifactStatus(entry), "drifted");
			await assert.rejects(() => readFallowHistoryArtifact(entry), /drifted/);
			await rm(reportPath, { force: true });
			assert.equal(await getFallowHistoryArtifactStatus(entry), "missing");
			resetFallowHistory(state);
			assert.deepEqual(state, { nextId: 1, entries: [] });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("records incomplete execution metadata and survives unavailable Git identity", async () => {
		const state = createFallowHistoryState();
		const noGit = { exec: async () => ({ code: 128, stdout: "", stderr: "not git", killed: false }) };
		const result = fakeResult(undefined, {
			args: ["-y", "fallow", "dead-code", "--trace", "src/a.ts:oldExport", "--format", "json", "--quiet"],
			execution: { code: 2, killed: false },
			reportMetadata: { complete: false, completenessReason: "exit-2" },
			formatted: { overview: undefined },
		});
		const entry = await recordFallowHistory(
			noGit,
			state,
			"/workspace",
			result,
			[],
			["dead-code", "--trace", "src/a.ts:oldExport", "--format", "json", "--quiet"],
		);
		assert.equal(entry.complete, false);
		assert.equal(entry.completenessReason, "exit-2");
		assert.equal(entry.comparisonKey, scopeDigest(["dead-code", "--trace", "src/a.ts:oldExport"]));
		assert.match(entry.command, /--trace src\/a\.ts:oldExport/);
		assert.equal(entry.gitHead, undefined);
		assert.equal(await getFallowHistoryArtifactStatus(entry), "not-retained");
	});
});
