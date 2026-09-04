import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeFallowHistoryCommand } = await jiti.import("../extensions/fallow/command/history.ts");
const { createFallowHistoryState } = await jiti.import("../extensions/fallow/history.ts");

function report(exports) {
	return JSON.stringify({
		kind: "dead-code",
		schema_version: 9,
		version: "3.21.0",
		total_issues: exports.length,
		unused_exports: exports,
	});
}

function entry(id, root, reportPath, text, findingCount) {
	return {
		id,
		root,
		command: "fallow dead-code --format json --quiet",
		comparisonKey: '["dead-code"]',
		timestamp: "2026-09-04T00:00:00.000Z",
		gitHead: "0123456789abcdef0123456789abcdef01234567",
		kind: "dead-code",
		fallowVersion: "3.21.0",
		schemaVersion: "9",
		complete: true,
		exitCode: findingCount ? 1 : 0,
		findingCount,
		contextCount: 0,
		reportPath,
		reportSha256: createHash("sha256").update(text).digest("hex"),
		reportBytes: Buffer.byteLength(text),
	};
}

function harness(mode) {
	const calls = { messages: [], notifications: [], custom: 0 };
	return {
		calls,
		pi: { sendMessage(message) { calls.messages.push(message); } },
		ctx: {
			cwd: "/workspace",
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			ui: {
				notify(message, level) { calls.notifications.push({ message, level }); },
				custom() {
					calls.custom++;
					if (mode !== "tui") throw new Error(`custom UI used in ${mode}`);
					return Promise.resolve(null);
				},
			},
		},
	};
}

describe("Fallow history command", () => {
	it("lists bounded project history in TUI, RPC, print, and JSON modes without custom UI", async () => {
		const state = createFallowHistoryState();
		state.entries.push({
			id: "r1", root: "/workspace", command: "fallow health", comparisonKey: '["health"]', timestamp: "2026-09-04T00:00:00.000Z",
			complete: true, exitCode: 0, findingCount: 0, contextCount: 0,
		});
		state.entries.push({
			id: "r2", root: "/other", command: "fallow security", comparisonKey: '["security"]', timestamp: "2026-09-04T00:00:00.000Z",
			complete: true, exitCode: 0, findingCount: 0, contextCount: 0,
		});
		for (const mode of ["tui", "rpc", "print", "json"]) {
			const { pi, ctx, calls } = harness(mode);
			await executeFallowHistoryCommand(pi, ctx, state, ["history"]);
			assert.equal(calls.custom, 0);
			assert.equal(calls.messages.length, 1);
			assert.match(calls.messages[0].content, /r1/);
			assert.doesNotMatch(calls.messages[0].content, /r2/);
			if (mode === "json") {
				const payload = JSON.parse(calls.messages[0].content);
				assert.equal(payload.kind, "pi-fallow-history");
				assert.equal(payload.entries.length, 1);
			}
		}
	});

	it("reopens retained reports only through TUI custom UI", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-history-command-"));
		const text = report([{ kind: "unused-export", path: "src/a.ts", line: 3, export_name: "oldExport" }]);
		const reportPath = join(directory, "report.json");
		await writeFile(reportPath, text);
		try {
			for (const mode of ["tui", "rpc", "print", "json"]) {
				const state = createFallowHistoryState();
				state.entries.push(entry("r1", "/workspace", reportPath, text, 1));
				const { pi, ctx, calls } = harness(mode);
				await executeFallowHistoryCommand(pi, ctx, state, ["history", "open", "r1"]);
				assert.equal(calls.custom, mode === "tui" ? 1 : 0);
				assert.equal(calls.messages.length, 1);
				if (mode === "json") assert.equal(JSON.parse(calls.messages[0].content).kind, "pi-fallow-history-open");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("compares retained reports and keeps resolved findings informational", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-history-compare-"));
		const priorText = report([{ kind: "unused-export", path: "src/a.ts", line: 3, export_name: "gone" }]);
		const currentText = report([]);
		const priorPath = join(directory, "prior.json");
		const currentPath = join(directory, "current.json");
		await Promise.all([writeFile(priorPath, priorText), writeFile(currentPath, currentText)]);
		try {
			const state = createFallowHistoryState();
			state.entries.push(entry("r1", "/workspace", priorPath, priorText, 1));
			state.entries.push(entry("r2", "/workspace", currentPath, currentText, 0));
			const { pi, ctx, calls } = harness("json");
			await executeFallowHistoryCommand(pi, ctx, state, ["history", "compare", "r1", "r2"]);
			assert.equal(calls.custom, 0);
			const payload = JSON.parse(calls.messages[0].content);
			assert.deepEqual(Object.fromEntries(payload.stats.map(({ label, value }) => [label, value])), {
				new: 0, unchanged: 0, resolved: 1, unavailable: 0,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not reveal cross-project ids and clears metadata without deleting reports", async () => {
		const state = createFallowHistoryState();
		state.entries.push({
			id: "r1", root: "/other", command: "fallow health", comparisonKey: '["health"]', timestamp: "2026-09-04T00:00:00.000Z",
			complete: true, exitCode: 0, findingCount: 0, contextCount: 0,
		});
		const rpc = harness("rpc");
		await executeFallowHistoryCommand(rpc.pi, rpc.ctx, state, ["history", "open", "r1"]);
		assert.match(rpc.calls.notifications[0].message, /unavailable, expired, or belongs/);
		assert.equal(rpc.calls.messages.length, 0);

		state.entries.push({
			id: "r2", root: "/workspace", command: "fallow dead-code", comparisonKey: '["dead-code"]', timestamp: "2026-09-04T00:00:00.000Z",
			complete: true, exitCode: 0, findingCount: 0, contextCount: 0,
		});
		await executeFallowHistoryCommand(rpc.pi, rpc.ctx, state, ["history", "clear"]);
		assert.deepEqual(state.entries.map(({ id }) => id), ["r1"]);
		assert.match(rpc.calls.messages.at(-1).content, /Report files were not deleted/);

		state.entries.push({
			id: "r3", root: "/workspace", command: "fallow health", comparisonKey: '["health"]',
			timestamp: "2026-09-04T00:00:00.000Z", complete: true, exitCode: 0, findingCount: 0, contextCount: 0,
		});
		const json = harness("json");
		await executeFallowHistoryCommand(json.pi, json.ctx, state, ["history", "clear"]);
		assert.deepEqual(JSON.parse(json.calls.messages[0].content), {
			kind: "pi-fallow-history-cleared", removed: 1, reportsDeleted: false,
		});
	});
});
