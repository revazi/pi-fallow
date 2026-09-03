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

	it("renders semantic candidates with advisory provenance and completion", () => {
		const candidate = {
			candidate_id: "sc_example",
			review_key: "scr_example",
			left: { path: "src/a.ts", name: "normalizeA", start_line: 10 },
			right: { path: "src/b.ts", name: "normalizeB", start_line: 30 },
			similarity: 0.934,
			similarity_band: "very-high",
			verification_status: "unverified",
			actions: [
				{ action: "setup", description: "Unspecified mutation guarantee" },
				{ action: "inspect", description: "Inspect source-grounded evidence", read_only: true },
			],
		};
		const overview = buildFallowOverview({
			kind: "similar-code",
			generation: {
				threshold: 0.8,
				model: {
					model_id: "local/model",
					revision: "immutable-revision",
					artifact_sha256: "artifact-digest",
					license: "Apache-2.0",
				},
				provider: {
					provider: "official-local-companion",
					companion_version: "3.21.0",
					protocol_version: 2,
					source_left_machine: false,
				},
				parameters: { parameter_sha256: "parameter-digest" },
				scope: { active: true, paths: ["src/a.ts", "src/b.ts"] },
			},
			candidates: [{
				...candidate,
				enrichment: { callers: "unavailable", runtime: "not-requested" },
			}],
			completion: {
				status: "complete",
				phases: [{ phase: "embedding", status: "complete", processed: 2, total: 2 }],
				skips: [],
				provider_inference_ms: 250,
				cache: { status: "hit" },
			},
			diagnostics: [],
		});

		assert.equal(overview.title, "Fallow similar code");
		assert.equal(overview.status, "warning");
		assert.deepEqual(overview.stats, [
			{ label: "candidates", value: 1 },
			{ label: "completion", value: "complete" },
			{ label: "threshold", value: 0.8 },
			{ label: "provider", value: "official-local-companion" },
			{ label: "companion", value: "3.21.0" },
			{ label: "protocol", value: 2 },
			{ label: "model", value: "local/model" },
			{ label: "model revision", value: "immutable-revision" },
			{ label: "model artifact", value: "artifact-digest" },
			{ label: "model license", value: "Apache-2.0" },
			{ label: "parameters", value: "parameter-digest" },
			{ label: "scope files", value: 2 },
			{ label: "provider inference", value: "250ms" },
			{ label: "cache", value: "hit" },
		]);
		assert.equal(overview.sections[0].title, "Unverified semantic candidates");
		assert.deepEqual(overview.sections[0].items[0], {
			label: "normalizeA ↔ normalizeB",
			path: "src/a.ts",
			line: 10,
			meta: "id sc_example · similarity 0.934 · very-high · right src/b.ts:30 · enrichment callers unavailable, runtime not-requested · unverified",
			action: "Inspect source-grounded evidence",
			raw: { ...candidate, enrichment: { callers: "unavailable", runtime: "not-requested" } },
		});
		assert.match(overview.notes[0], /advisory and unverified/);
		assert.match(overview.notes[1], /source did not leave the machine/);
	});

	it("renders source-grounded inspect packets and separately reviewed candidates", () => {
		const candidate = {
			candidate_id: "sc_example",
			left: { path: "src/a.ts", name: "left", start_line: 5 },
			right: { path: "src/b.ts", name: "right", start_line: 25 },
			similarity: 0.91,
			verification_status: "unverified",
		};
		const completion = { status: "complete", cache: { status: "hit" } };
		const inspect = buildFallowOverview({
			kind: "similar-code-inspect",
			generation: {},
			candidate,
			packet: {
				candidate_id: "sc_example",
				availability: { callers: "available", runtime: "unavailable" },
				left: { source_window: "function left() {}" },
			},
			completion,
			diagnostics: [],
		});
		assert.equal(inspect.title, "Fallow similar-code inspect");
		assert.equal(inspect.sections[0].title, "Inspected semantic candidate");
		assert.match(inspect.sections[0].items[0].action, /abstain when evidence is incomplete/);
		assert.match(inspect.sections[0].items[0].meta, /enrichment runtime unavailable/);
		assert.equal(inspect.sections[0].items[0].raw.packet.left.source_window, "function left() {}");

		const review = buildFallowOverview({
			kind: "similar-code-review",
			generation: {},
			review: { candidates_sha256: "candidate-input-digest", verdicts_sha256: "verdict-input-digest" },
			candidates: [{
				candidate,
				verdict: { refactor_safe: false, rationale: "Different empty-value behavior." },
				verdict_match: "review-key",
				outcome: "related-but-distinct",
			}],
			completion,
			diagnostics: [],
		});
		assert.equal(review.title, "Fallow similar-code review");
		assert.match(review.sections[0].items[0].meta, /related-but-distinct · match review-key/);
		assert.equal(review.sections[0].items[0].action, "Different empty-value behavior.");
		assert.deepEqual(review.stats.slice(-2), [
			{ label: "candidate input", value: "candidate-input-digest" },
			{ label: "verdict input", value: "verdict-input-digest" },
		]);
		assert.match(review.notes.at(-1), /separate verdict document/);
	});

	it("surfaces partial similar-code completion and bounded diagnostics", () => {
		const overview = buildFallowOverview({
			kind: "similar-code",
			generation: {},
			candidates: [],
			completion: {
				status: "partial",
				phases: [
					{ phase: "embedding", status: "timed-out", processed: 4, total: 10, reason: "provider deadline" },
				],
				skips: [{ phase: "extraction", reason: "input-limit", count: 2 }],
				cache: { status: "disabled" },
			},
			diagnostics: [
				{ domain: "provider", code: "timeout", message: "Provider timed out.", path: "src/a.ts" },
				{ domain: "extraction", code: "limit", message: "Input limit reached." },
				{ domain: "cache", code: "invalid", message: "Ignored invalid cache entry." },
				{ domain: "enrichment", code: "missing", message: "Enrichment unavailable." },
			],
		});

		assert.equal(overview.status, "warning");
		assert.match(overview.notes.join("\n"), /empty or truncated result is not conclusive/);
		assert.match(overview.notes.join("\n"), /Phase embedding: timed-out \(4\/10\) · provider deadline/);
		assert.match(overview.notes.join("\n"), /2 skipped in extraction: input-limit/);
		assert.match(overview.notes.join("\n"), /src\/a\.ts: Provider timed out/);
		assert.match(overview.notes.at(-1), /1 additional similar-code diagnostic/);
	});

	it("distinguishes similar-code readiness, missing setup, and verdict failures", () => {
		const status = buildFallowOverview({
			kind: "similar-code-status",
			model_ready: false,
			model_id: "local/model",
			model_revision: "revision",
			companion_version: "3.21.0",
			protocol_version: 2,
			license: "Apache-2.0",
			integrity_verified: false,
			download_bytes: 324329844,
			cache_dir: "/tmp/fallow/model",
			analysis_offline: true,
			problem: "the local model is not installed",
		});
		assert.equal(status.title, "Fallow similar-code status");
		assert.equal(status.status, "warning");
		assert.deepEqual(status.stats, [
			{ label: "model ready", value: "false" },
			{ label: "model", value: "local/model" },
			{ label: "revision", value: "revision" },
			{ label: "companion", value: "3.21.0" },
			{ label: "protocol", value: 2 },
			{ label: "license", value: "Apache-2.0" },
			{ label: "integrity verified", value: "false" },
			{ label: "download", value: "309.3 MiB" },
			{ label: "cache directory", value: "/tmp/fallow/model" },
		]);
		assert.match(status.notes.join("\n"), /inference runs locally/);

		const missing = buildFallowOverview({
			error: true,
			message: "the local model is not installed; run `fallow similar-code setup --local`",
			exit_code: 3,
		}, 3);
		assert.equal(missing.title, "Fallow similar-code setup required");
		assert.equal(missing.status, "error");
		assert.match(missing.notes[0], /does not download models/);

		const verdictFailure = buildFallowOverview({
			error: true,
			message: "verdict document does not match the candidate generation",
			exit_code: 2,
		}, 2);
		assert.equal(verdictFailure.title, "Fallow error");
		assert.deepEqual(verdictFailure.notes, ["verdict document does not match the candidate generation"]);
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
