import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { assertEvidenceSubset } from "../scripts/report-certification.mjs";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
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

	it("preserves complete sidecar JSON through existing parsing and bounded storage", async () => {
		const parsed = parseJson(JSON.stringify(frozen.report), "");
		assert.equal(parsed.parsed, true);
		assert.deepEqual(parsed.data, frozen.report);
		const result = await formatToolOutput(parsed, "/fixture", frozen.exitCode, true, "findings");
		try {
			assert.ok(result.fullOutputPath);
			assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), frozen.report);
			assert.ok(result.text.includes(result.fullOutputPath));
			assert.ok(result.text.length < 12_000);
		} finally {
			if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
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
