import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { assertEvidenceSubset } from "../scripts/report-certification.mjs";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { getNormalizedFallowReport, allNormalizedFallowEntries } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { buildFallowPrompt } = await jiti.import("../extensions/fallow/prompt.ts");
const frozen = JSON.parse(await readFile(new URL("./fixtures/fallow/coverage-report-3.21.0.json", import.meta.url), "utf8"));

function changedEvidence(change) {
	const evidence = structuredClone(frozen);
	change(evidence);
	return evidence;
}

describe("optional fallow-cov certification", () => {
	it("binds a real V8 capture to pinned Fallow, Node, sidecar, license, and source input", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		const project = await readFile(new URL("./fixtures/fallow/coverage-project.json", import.meta.url));
		assert.equal(frozen.fallowVersion, manifest.devDependencies.fallow);
		assert.equal(frozen.nodeMajor, 24);
		assert.deepEqual(frozen.sidecar, {
			package: "@fallow-cli/fallow-cov",
			version: "0.4.1",
			license: "SEE LICENSE IN LICENSE",
		});
		assert.equal(manifest.devDependencies["@fallow-cli/fallow-cov"], undefined);
		assert.match(manifest.scripts["smoke:fallow-cov"], /--ignore-scripts/);
		assert.match(manifest.scripts["smoke:fallow-cov"], /@fallow-cli\/fallow-cov@0\.4\.1/);
		assert.match(manifest.scripts["check:publish"], /smoke:fallow-cov/);
		assert.equal(frozen.inputSha256, createHash("sha256").update(project).digest("hex"));
		assertEvidenceSubset(frozen, frozen);
	});

	it("captures successful local coverage with observed and tracked-cold functions", () => {
		const report = frozen.report;
		const runtime = report.runtime_coverage;
		assert.equal(frozen.exitCode, 0);
		assert.equal(report.kind, "coverage-analyze");
		assert.equal(report.schema_version, "2");
		assert.equal(runtime.schema_version, "1");
		assert.equal(runtime.verdict, "cold-code-detected");
		assert.deepEqual(runtime.signals, ["cold-code-detected"]);
		assert.deepEqual({
			dataSource: runtime.summary.data_source,
			tracked: runtime.summary.functions_tracked,
			hit: runtime.summary.functions_hit,
			unhit: runtime.summary.functions_unhit,
			untracked: runtime.summary.functions_untracked,
			coverage: runtime.summary.coverage_percent,
		}, { dataSource: "local", tracked: 2, hit: 1, unhit: 1, untracked: 0, coverage: 50 });
		assert.equal(runtime.provenance.data_source, "local");
		assert.equal(runtime.provenance.is_production, "unknown");
	});

	it("retains actionable cold-code evidence and its uncertainty discriminators", () => {
		const [finding] = frozen.report.runtime_coverage.findings;
		assert.equal(finding.path, "target.js");
		assert.equal(finding.function, "cold");
		assert.equal(finding.line, 4);
		assert.equal(finding.verdict, "safe_to_delete");
		assert.equal(finding.invocations, 0);
		assert.equal(finding.confidence, "medium");
		assert.equal(finding.evidence.v8_tracking, "tracked");
		assert.equal(finding.discriminators.tracking_state, "never_called");
		assert.equal(finding.discriminators.meets_observation_volume, false);
		assert.equal(finding.actions[0].auto_fixable, false);
		assert.equal(frozen.report.runtime_coverage.actionable, true);
	});

	it("normalizes actionable findings separately from runtime context", () => {
		const overview = buildFallowOverview(frozen.report, frozen.exitCode);
		const normalized = getNormalizedFallowReport(overview);
		const entries = allNormalizedFallowEntries(normalized);
		assert.equal(overview.title, "Fallow runtime coverage");
		assert.equal(overview.status, "warning");
		assert.equal(normalized.findingCount, 1);
		assert.equal(normalized.contextCount, 3);
		assert.deepEqual(entries.map((entry) => [entry.role, entry.section, entry.subject]), [
			["finding", "Runtime coverage findings", "cold"],
			["context", "Runtime blast radius", "observed"],
			["context", "Runtime blast radius", "cold"],
			["context", "Runtime importance", "observed"],
		]);
		assert.equal(entries[0].type, "safe_to_delete");
		assert.equal(entries[0].id, "fallow:prod:c26fb3c4");
		assert.match(entries[0].details, /volume 3\/5000 \(below floor\)/);
		assert.match(entries[0].evidence, /"v8_tracking":"tracked"/);
		assert.match(entries[0].action, /Below the confidence floor—not proof of unused or delete safety/);
		assert.match(overview.notes.join("\n"), /not deletion authorization/);
		assert.match(overview.notes.join("\n"), /production origin is unknown/);
	});

	it("does not turn unavailable coverage into delete-safety evidence", () => {
		const report = structuredClone(frozen.report);
		Object.assign(report.runtime_coverage, { verdict: "unknown", actionable: false });
		Object.assign(report.runtime_coverage.findings[0], {
			verdict: "coverage_unavailable", confidence: "none", invocations: null,
			actions: [{ type: "review-runtime", description: "Collect a broader capture.", auto_fixable: false }],
		});
		const finding = allNormalizedFallowEntries(getNormalizedFallowReport(buildFallowOverview(report, 0)))[0];
		assert.match(finding.action, /^Coverage is unavailable; do not infer/);
		assert.match(finding.action, /Suggested action: Collect a broader capture/);
	});

	it("keeps clean runtime context informational", () => {
		const report = structuredClone(frozen.report);
		Object.assign(report.runtime_coverage, {
			verdict: "clean", signals: [], findings: [], actionable: true,
			hot_paths: [{ id: "fallow:hot:1", path: "target.js", function: "observed", line: 1, end_line: 1, invocations: 3, percentile: 100 }],
		});
		const normalized = getNormalizedFallowReport(buildFallowOverview(report, 0));
		assert.equal(normalized.status, "success");
		assert.equal(normalized.findingCount, 0);
		assert.equal(normalized.contextCount, 4);
		assert.equal(allNormalizedFallowEntries(normalized)[0].section, "Runtime hot paths");
	});

	it("keeps a non-actionable empty capture explicit instead of claiming no issues", () => {
		const report = structuredClone(frozen.report);
		Object.assign(report.runtime_coverage, {
			verdict: "unknown", signals: [], findings: [], blast_radius: [], importance: [],
			actionable: false, actionability_verdict: "insufficient_evidence", actionability_reason: "No tracked functions.",
		});
		Object.assign(report.runtime_coverage.summary, {
			functions_tracked: 0, functions_hit: 0, functions_unhit: 0, functions_untracked: 2, coverage_percent: 0,
		});
		const overview = buildFallowOverview(report, 0);
		const normalized = getNormalizedFallowReport(overview);
		assert.equal(overview.title, "Fallow runtime coverage");
		assert.equal(overview.status, "warning");
		assert.equal(normalized.findingCount, 0);
		assert.equal(normalized.contextCount, 0);
		assert.match(overview.notes.join("\n"), /not actionable: No tracked functions/);
		assert.doesNotMatch(overview.notes.join("\n"), /No issues found/);
	});

	it("bounds capture warnings and marks stale, low-quality evidence", () => {
		const report = structuredClone(frozen.report);
		report.runtime_coverage.summary.capture_quality.lazy_parse_warning = true;
		report.runtime_coverage.summary.capture_quality.untracked_ratio_percent = 42;
		report.runtime_coverage.provenance.stale = true;
		report.runtime_coverage.warnings = Array.from({ length: 5 }, (_, index) => ({ code: `w${index}`, message: `warning ${index}` }));
		const overview = buildFallowOverview(report, 0);
		assert.equal(overview.status, "warning");
		assert.match(overview.notes.join("\n"), /42% of functions were untracked/);
		assert.match(overview.notes.join("\n"), /evidence is stale/);
		assert.match(overview.notes.join("\n"), /warning 2/);
		assert.doesNotMatch(overview.notes.join("\n"), /warning 3/);
		assert.match(overview.notes.join("\n"), /2 additional runtime coverage warning/);
	});

	it("preserves health identity when runtime coverage is nested in a health report", () => {
		const health = {
			kind: "health", findings: [], summary: { files_analyzed: 1 },
			runtime_coverage: structuredClone(frozen.report.runtime_coverage),
		};
		const overview = buildFallowOverview(health, 0);
		assert.equal(overview.title, "Fallow health");
		assert.equal(getNormalizedFallowReport(overview).findingCount, 1);
	});

	it("preserves complete sidecar JSON through existing parsing and bounded storage", async () => {
		const parsed = parseJson(JSON.stringify(frozen.report), "");
		assert.equal(parsed.parsed, true);
		assert.deepEqual(parsed.data, frozen.report);
		const [result, summaryResult, rawResult] = await Promise.all([
			formatToolOutput(parsed, "/fixture", frozen.exitCode, true, "findings"),
			formatToolOutput(parsed, "/fixture", frozen.exitCode, true, "summary"),
			formatToolOutput(parsed, "/fixture", frozen.exitCode, true, "raw"),
		]);
		try {
			for (const output of [result, summaryResult, rawResult]) {
				assert.ok(output.fullOutputPath);
				assert.deepEqual(JSON.parse(await readFile(output.fullOutputPath, "utf8")), frozen.report);
			}
			assert.ok(result.text.includes(result.fullOutputPath));
			assert.ok(result.text.length < 12_000);
			assert.match(summaryResult.text, /^Fallow summary:\n/);
			assert.match(summaryResult.text, /"finding_count":1/);
			assert.match(summaryResult.text, /"context_count":3/);
			assert.match(rawResult.text, /"runtime_coverage"/);
			const detail = JSON.parse(result.text.slice("Fallow findings:\n".length));
			assert.equal(detail.finding_count, 1);
			assert.equal(detail.context_count, 3);
			assert.equal(detail.findings[0].type, "safe_to_delete");
			assert.equal(detail.findings[0].location.path, "target.js");
			assert.match(detail.findings[0].details, /tracking never_called/);
			const normalized = getNormalizedFallowReport(result.overview);
			const finding = allNormalizedFallowEntries(normalized)[0];
			const prompt = buildFallowPrompt({ findings: [{ sectionTitle: finding.section, item: result.overview.sections[0].items[0], normalized: finding }], detail: "compact" });
			assert.match(prompt, /safe_to_delete.*target\.js:4.*cold/);
			assert.match(prompt, /below floor/);
			assert.match(prompt, /Below the confidence floor—not proof of unused or delete safety/);
		} finally {
			for (const path of new Set([result.fullOutputPath, summaryResult.fullOutputPath, rawResult.fullOutputPath])) {
				if (path) await rm(dirname(path), { recursive: true, force: true });
			}
		}
	});

	it("detects selected contract drift while allowing additive fields", () => {
		for (const [change, expected] of [
			[(data) => { data.report.schema_version = "3"; }, /report.schema_version/],
			[(data) => { data.report.runtime_coverage.summary.functions_hit = 2; }, /summary.functions_hit/],
			[(data) => { delete data.report.runtime_coverage.findings[0].path; }, /findings.0.path/],
			[(data) => { data.report.runtime_coverage.findings[0].actions[0].auto_fixable = true; }, /actions.0.auto_fixable/],
			[(data) => { data.report.runtime_coverage.findings[0].discriminators.tracking_state = "untracked"; }, /tracking_state/],
		]) assert.throws(() => assertEvidenceSubset(changedEvidence(change), frozen), expected);
		const additive = changedEvidence((data) => {
			data.report.runtime_coverage.future_context = { note: "additional evidence" };
			data.report.runtime_coverage.findings[0].future_discriminator = true;
		});
		assertEvidenceSubset(additive, frozen);
	});
});
