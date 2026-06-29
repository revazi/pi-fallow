import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");

describe("buildFallowOverview", () => {
	it("summarizes security findings", () => {
		const overview = buildFallowOverview({
			kind: "security",
			elapsed_ms: 12,
			security_findings: [{
				kind: "tainted-sink",
				category: "command-injection",
				cwe: 78,
				path: "src/run.ts",
				line: 10,
				severity: "medium",
				evidence: "Non-literal command passed to spawn().",
				actions: [{ type: "suppress-file", description: "Suppress with a file-level comment" }],
			}],
		});

		assert.equal(overview.title, "Fallow security");
		assert.equal(overview.status, "warning");
		assert.equal(overview.sections[0].title, "Security candidates");
		assert.deepEqual(overview.sections[0].items[0], {
			label: "tainted-sink: command-injection",
			path: "src/run.ts",
			line: 10,
			meta: "medium · CWE-78",
			action: "Suppress with a file-level comment",
			severity: "medium",
			raw: overview.sections[0].items[0].raw,
		});
	});

	it("summarizes inspect output", () => {
		const overview = buildFallowOverview({
			kind: "inspect_target",
			target: { type: "file", file: "src/a.ts" },
			identity: {
				file: "src/a.ts",
				is_reachable: true,
				export_count: 2,
				import_count: 1,
				imported_by_count: 3,
			},
			warnings: ["partial evidence"],
		});

		assert.equal(overview.title, "Fallow inspect");
		assert.deepEqual(overview.stats.slice(0, 5), [
			{ label: "target", value: "src/a.ts" },
			{ label: "reachable", value: "true" },
			{ label: "exports", value: 2 },
			{ label: "imports", value: 1 },
			{ label: "importers", value: 3 },
		]);
		assert.deepEqual(overview.notes, ["partial evidence"]);
	});

	it("summarizes decision-surface output", () => {
		const overview = buildFallowOverview({
			kind: "decision-surface",
			decisions: [{
				question: "Should this API stay public?",
				path: "src/api.ts",
				line: 20,
				expert: "architecture",
				confidence: "high",
				prompt: "Review exported API shape.",
			}],
		});

		assert.equal(overview.title, "Fallow decision surface");
		assert.equal(overview.sections[0].title, "Structural decisions");
		assert.deepEqual(overview.sections[0].items[0], {
			label: "Should this API stay public?",
			path: "src/api.ts",
			line: 20,
			meta: "architecture · high",
			action: "Review exported API shape.",
			raw: overview.sections[0].items[0].raw,
		});
	});

	it("summarizes workspace, schema, and config outputs", () => {
		const workspace = buildFallowOverview({ kind: "list-workspaces", workspace_count: 0, workspaces: [], workspace_diagnostics: [] });
		assert.equal(workspace.title, "Fallow workspaces");
		assert.deepEqual(workspace.stats, [{ label: "workspaces", value: 0 }]);

		const schema = buildFallowOverview({ name: "fallow", version: "2.103.0", commands: [{ name: "health" }], issue_types: [{}, {}] });
		assert.equal(schema.title, "Fallow schema");
		assert.deepEqual(schema.stats, [
			{ label: "version", value: "2.103.0" },
			{ label: "commands", value: 1 },
			{ label: "issue types", value: 2 },
		]);

		const config = buildFallowOverview({ entry: ["extensions/index.ts"], rules: { "unused-files": "error" }, duplicates: {}, health: {} });
		assert.equal(config.title, "Fallow config");
		assert.deepEqual(config.stats, [
			{ label: "entries", value: 1 },
			{ label: "rules", value: 1 },
		]);
	});
});
