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

	it("classifies file scores and hotspots as informational context", () => {
		const overview = buildFallowOverview({
			kind: "health",
			findings: [],
			file_scores: [
				{ path: "src/healthy.ts", maintainability_index: 95, lines: 20, dead_code_ratio: 0, crap_max: 1 },
				{ path: "src/risky.ts", maintainability_index: 55, lines: 200, dead_code_ratio: 0.2, crap_max: 25 },
			],
			hotspots: [{ path: "src/busy.ts", score: 30, commits: 12, lines_added: 100, lines_deleted: 50 }],
		});

		assert.equal(overview.status, "success");
		assert.deepEqual(overview.sections.map((section) => [section.title, section.role, section.items.length]), [
			["Worst file scores", "context", 2],
			["Hotspots", "context", 1],
		]);
	});

	it("keeps every finding available to the navigator", () => {
		const unusedExports = Array.from({ length: 40 }, (_, index) => ({
			export_name: `unused_${index}`,
			path: `src/file-${index}.ts`,
			line: index + 1,
		}));
		const overview = buildFallowOverview({ kind: "dead-code", total_issues: unusedExports.length, unused_exports: unusedExports });

		assert.equal(overview.sections[0].count, 40);
		assert.equal(overview.sections[0].items.length, 40);
		assert.equal(overview.sections[0].items[39].path, "src/file-39.ts");
		assert.equal(overview.sections[0].items[0].raw, unusedExports[0]);
		assert.equal(overview.sections[0].items[39].raw, undefined);
	});

	it("summarizes exact-symbol impact and warns on incomplete evidence", () => {
		const overview = buildFallowOverview({
			kind: "impact",
			target: { path: "src/api.ts", exported_name: "Client" },
			identity: { completeness: "unavailable" },
			assertion: "no-consumers-found",
			status: "unavailable",
			confidence: "unavailable",
			total_direct_consumer_count: 0,
			total_affected_file_count: 0,
			total_targeted_test_count: 0,
		});

		assert.equal(overview.title, "Fallow symbol impact");
		assert.deepEqual(overview.stats, [
			{ label: "target", value: "src/api.ts:Client" },
			{ label: "status", value: "unavailable" },
			{ label: "confidence", value: "unavailable" },
			{ label: "direct consumers", value: 0 },
			{ label: "affected files", value: 0 },
			{ label: "targeted tests", value: 0 },
		]);
		assert.match(overview.notes[0], /do not treat it as exact delete-safety evidence/);
	});

	it("keeps complete symbol-impact evidence navigable without classifying it as findings", () => {
		const overview = buildFallowOverview({
			kind: "impact",
			target: { path: "src/api.ts", exported_name: "Client" },
			assertion: "consumers-found",
			status: "complete",
			confidence: "high",
			direct_consumers: [{ path: "src/consumer.ts", relation: "direct-value-consumer", distance: 1 }],
			total_direct_consumer_count: 1,
			affected_files: [{ path: "src/app.ts", relation: "transitive-consumer", distance: 2, via: ["src/consumer.ts"] }],
			total_affected_file_count: 1,
			targeted_tests: [{ path: "test/api.test.ts", relation: "targeted-test", distance: 1 }],
			total_targeted_test_count: 1,
		});

		assert.equal(overview.title, "Fallow symbol impact");
		assert.equal(overview.status, "success");
		assert.deepEqual(overview.sections.map((section) => [section.title, section.role, section.items[0].path]), [
			["Direct consumers", "context", "src/consumer.ts"],
			["Affected files", "context", "src/app.ts"],
			["Targeted tests", "context", "test/api.test.ts"],
		]);
		assert.equal(overview.sections[1].items[0].meta, "distance 2 · via src/consumer.ts");
		assert.deepEqual(overview.sections[0].items[0].raw, {
			path: "src/consumer.ts", relation: "direct-value-consumer", distance: 1,
		});
	});

	it("surfaces type-aware completeness and advisory coupling metadata", () => {
		const overview = buildFallowOverview({
			kind: "health",
			findings: [],
			summary: { files_analyzed: 2 },
			_meta: {
				type_aware: {
					identity: { completeness: "partial" },
					protocol_version: 6,
					type_coupling: {
						status: "partial",
						files: [{
							path: "src/api.ts",
							public_api_depends_on: 1,
							public_api_depends_on_files: ["src/model.ts"],
							public_types_used_by: 0,
						}],
					},
				},
			},
		});

		assert.deepEqual(overview.stats, [
			{ label: "files analyzed", value: "2" },
			{ label: "type-aware", value: "partial" },
			{ label: "semantic protocol", value: 6 },
			{ label: "type coupling", value: "partial" },
			{ label: "coupled files", value: 1 },
		]);
		assert.deepEqual(overview.sections.map((section) => [section.title, section.role]), [["Type coupling", "context"]]);
		assert.deepEqual(overview.sections[0].items[0], {
			label: "public-signature coupling",
			path: "src/api.ts",
			meta: "depends on 1 · used by 0",
			action: "depends on src/model.ts",
			raw: {
				path: "src/api.ts",
				public_api_depends_on: 1,
				public_api_depends_on_files: ["src/model.ts"],
				public_types_used_by: 0,
			},
		});
		assert.deepEqual(overview.notes, [
			"Type-coupling evidence is advisory and does not change the health score.",
			"Type-aware evidence is partial; review omissions and abstentions before relying on semantic conclusions.",
		]);
	});

	it("renders execution errors without a contradictory no-issues note", () => {
		const overview = buildFallowOverview({ error: true, message: "missing required issue type", exit_code: 2 }, 2);

		assert.equal(overview.title, "Fallow error");
		assert.equal(overview.status, "error");
		assert.deepEqual(overview.sections, []);
		assert.deepEqual(overview.notes, ["missing required issue type"]);
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
