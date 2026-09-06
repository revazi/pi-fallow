import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { assertEvidenceSubset, projectHelp } from "../scripts/report-certification.mjs";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { getNormalizedFallowReport, allNormalizedFallowEntries } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
const frozen = JSON.parse(await readFile(new URL("./fixtures/fallow/reports-3.21.0.json", import.meta.url), "utf8"));

function overview(id) {
	const evidence = frozen.reports[id];
	return buildFallowOverview(evidence.report, evidence.exitCode);
}

function mutateEvidence(change) {
	const actual = structuredClone(frozen);
	change(actual);
	return actual;
}

describe("captured report and nested-command certification", () => {
	it("binds offline evidence to the pinned version and reproducible project input", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		const project = await readFile(new URL("./fixtures/fallow/report-project.json", import.meta.url));
		assert.equal(frozen.version, manifest.devDependencies.fallow);
		assert.equal(frozen.inputSha256, createHash("sha256").update(project).digest("hex"));
		assertEvidenceSubset(frozen, frozen);
	});

	it("preserves every captured JSON document through parsing and complete-output storage", async () => {
		for (const [id, evidence] of Object.entries(frozen.reports)) {
			const parsed = parseJson(JSON.stringify(evidence.report), "");
			assert.equal(parsed.parsed, true, id);
			assert.deepEqual(parsed.data, evidence.report, id);
			const result = await formatToolOutput(parsed, "/fixture", evidence.exitCode, true, "findings");
			try {
				assert.ok(result.fullOutputPath, id);
				assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), evidence.report, id);
				assert.ok(result.text.includes(result.fullOutputPath), id);
				assert.ok(result.text.length < 12_000, `${id}: bounded model output`);
			} finally {
				if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
			}
		}
	});

	it("normalizes real actionable export evidence without treating exit 1 as a crash", () => {
		const view = overview("dead-code");
		const report = getNormalizedFallowReport(view);
		assert.equal(view.status, "warning");
		assert.equal(report.findingCount, 1);
		const [entry] = allNormalizedFallowEntries(report);
		assert.equal(entry.path, "lib.js");
		assert.equal(entry.line, 2);
		assert.equal(entry.subject, "unused");
		assert.equal(entry.action, "Remove the unused export from the public API");
		assert.match(view.notes.join("\n"), /not a crashed command/);
	});

	it("keeps informational health scores out of empty finding counts", () => {
		const view = overview("health");
		const report = getNormalizedFallowReport(view);
		assert.equal(view.status, "success");
		assert.equal(report.findingCount, 0);
		assert.equal(report.contextCount, 1);
		assert.equal(allNormalizedFallowEntries(report)[0].role, "context");
	});

	it("retains pinned-model readiness and missing-input errors without proposing automatic setup", () => {
		const status = overview("similar-status");
		assert.equal(status.status, "warning");
		assert.ok(status.stats.some((stat) => stat.label === "revision" && stat.value === frozen.reports["similar-status"].report.model_revision));
		const missing = overview("similar-missing-model");
		assert.equal(missing.status, "error");
		assert.match(missing.notes.join("\n"), /does not download models/);
		for (const id of ["coverage-missing-value", "inspect-missing-inputs", "review-missing-inputs"]) {
			const view = overview(id);
			assert.equal(view.status, "error", id);
			assert.match(view.notes.join("\n"), /required/, id);
			assert.doesNotMatch(view.notes.join("\n"), /No issues found/, id);
		}
	});

	it("retains synthetic partial semantic evidence injected into a captured health report", async () => {
		// Synthetic mutation, NOT evidence of a real companion/inference run.
		const report = structuredClone(frozen.reports.health.report);
		report._meta.type_aware = {
			executed: true, identity: { completeness: "partial" },
			type_coupling: { status: "partial", diagnostics: [{ message: "Fixture-only missing project" }] },
		};
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), "/fixture", 0, true, "findings");
		try {
			assert.match(result.overview.notes.join("\n"), /advisory/);
			assert.match(result.overview.notes.join("\n"), /evidence is partial/);
			assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), report);
		} finally {
			await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
		}
	});

	it("identifies selected report schema and actionable-field drift, while accepting additive fields", () => {
		for (const [change, message] of [
			[(data) => { data.reports["dead-code"].report.schema_version = 99; }, /dead-code.report.schema_version/],
			[(data) => { delete data.reports["dead-code"].report.unused_exports[0].path; }, /unused_exports.0.path/],
			[(data) => { data.reports.health.report.findings = null; }, /health.report.findings/],
			[(data) => { data.reports["similar-status"].report.model_ready = true; }, /similar-status.report.model_ready/],
		]) assert.throws(() => assertEvidenceSubset(mutateEvidence(change), frozen), message);
		const additive = mutateEvidence((data) => {
			data.reports["dead-code"].report.future_field = { explanation: "additional evidence" };
			data.help["similar-inspect"].options["--future-optional"] = "boolean";
		});
		assertEvidenceSubset(additive, frozen);
	});

	it("checks required nested usage and flag arity without claiming successful analysis", () => {
		assert.match(frozen.help["similar-inspect"].requiredUsage, /<CANDIDATE_ID> --candidates <PATH>/);
		assert.match(frozen.help["similar-review"].requiredUsage, /--candidates <PATH> --verdicts <PATH>/);
		assert.equal(frozen.help["coverage-analyze"].options["--runtime-coverage"], "<PATH>");
		for (const change of [
			(data) => { data.help["coverage-analyze"].requiredUsage += " --new-input <PATH>"; },
			(data) => { data.help["similar-review"].options["--verdicts"] = "boolean"; },
			(data) => { delete data.help["similar-inspect"].options["--candidates"]; },
		]) assert.throws(() => assertEvidenceSubset(mutateEvidence(change), frozen), /help\./);
		assert.deepEqual(projectHelp("Usage: fallow fixture [OPTIONS] <TARGET>\n  -q, --quiet  Quiet\n      --input <PATH>  Input\n      --save [<PATH>]  Optional value\n"), {
			requiredUsage: "Usage: fallow fixture <TARGET>",
			options: { "--quiet": "boolean", "--input": "<PATH>", "--save": "[<PATH>]" },
		});
		assert.throws(() => projectHelp("no usage"), /missing Usage/);
	});
});
