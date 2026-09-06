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
		const partialProject = await readFile(new URL("./fixtures/fallow/report-partial-project.json", import.meta.url));
		assert.equal(frozen.version, manifest.devDependencies.fallow);
		assert.equal(frozen.inputSha256.base, createHash("sha256").update(project).digest("hex"));
		assert.equal(frozen.inputSha256.typeAwarePartial, createHash("sha256").update(partialProject).digest("hex"));
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
		assert.equal(report.contextCount, 4);
		assert.ok(allNormalizedFallowEntries(report).every((entry) => entry.role === "context"));
	});

	it("normalizes real duplication and security candidates as advisory findings", () => {
		const cases = [
			["dupes", "clone-a.js", "clone #1", /clone-b\.js:1/],
			["security", "security.js", "tainted-sink: command-injection", /file-level comment/],
		];
		for (const [id, path, subject, action] of cases) {
			const view = overview(id);
			const report = getNormalizedFallowReport(view);
			assert.equal(view.status, "warning", id);
			assert.equal(report.findingCount, 1, id);
			const [entry] = allNormalizedFallowEntries(report);
			assert.equal(entry.path, path, id);
			assert.equal(entry.subject, subject, id);
			assert.match(entry.action, action, id);
		}
		const candidate = frozen.reports.security.report.security_findings[0];
		assert.equal(candidate.source_backed, true);
		assert.equal(candidate.reachability.taint_confidence, "arg-level");
		assert.equal(candidate.candidate.sink.cwe, 78);
		assert.equal(candidate.taint_flow.path.intra_module, true);
		assert.equal(frozen.reports.security.report.attack_surface.length, 1);
	});

	it("keeps combined child findings deterministic without folding security into bare analysis", () => {
		const view = overview("combined");
		const report = getNormalizedFallowReport(view);
		const entries = allNormalizedFallowEntries(report);
		assert.equal(view.title, "Fallow full analysis");
		assert.equal(report.findingCount, 2);
		assert.equal(report.contextCount, 4);
		assert.deepEqual(entries.filter((entry) => entry.role === "finding").map((entry) => [entry.section, entry.path]), [
			["Dead code · Unused exports", "lib.js"],
			["Dupes · Clone groups", "clone-a.js"],
		]);
		assert.equal("security_findings" in frozen.reports.combined.report, false);
	});

	it("retains real unavailable type-aware evidence as explicitly advisory", async () => {
		const evidence = frozen.reports["type-aware-unavailable"];
		const typeAware = evidence.report._meta.type_aware;
		assert.equal(typeAware.executed, true);
		assert.equal(typeAware.identity.completeness, "unavailable");
		assert.equal(typeAware.type_coupling.status, "unavailable");
		assert.equal(typeAware.type_coupling.omissions[0].reason_code, "no-project");
		const view = overview("type-aware-unavailable");
		assert.match(view.notes.join("\n"), /advisory/);
		assert.match(view.notes.join("\n"), /evidence is unavailable/);
		const result = await formatToolOutput(parseJson(JSON.stringify(evidence.report), ""), "/fixture", 0, true, "findings");
		try {
			assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), evidence.report);
		} finally {
			await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
		}
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

	it("retains real partial type-aware evidence from one complete and one blocked project", async () => {
		const evidence = frozen.reports["type-aware-partial"];
		const typeAware = evidence.report._meta.type_aware;
		assert.equal(typeAware.executed, true);
		assert.equal(typeAware.identity.completeness, "partial");
		assert.equal(typeAware.type_coupling.status, "partial");
		assert.equal(typeAware.type_coupling.omissions[0].reason_code, "blocking-diagnostics");
		assert.deepEqual(typeAware.projects.map((project) => project.status), ["unavailable", "complete"]);
		const result = await formatToolOutput(parseJson(JSON.stringify(evidence.report), ""), "/fixture", 0, true, "findings");
		try {
			assert.match(result.overview.notes.join("\n"), /advisory/);
			assert.match(result.overview.notes.join("\n"), /evidence is partial/);
			assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), evidence.report);
		} finally {
			await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
		}
	});

	it("identifies selected report schema and actionable-field drift, while accepting additive fields", () => {
		for (const [change, message] of [
			[(data) => { data.reports["dead-code"].report.schema_version = 99; }, /dead-code.report.schema_version/],
			[(data) => { delete data.reports["dead-code"].report.unused_exports[0].path; }, /unused_exports.0.path/],
			[(data) => { data.reports.health.report.findings = null; }, /health.report.findings/],
			[(data) => { delete data.reports.dupes.report.clone_groups[0].instances[0].file; }, /dupes.report.clone_groups.0.instances.0.file/],
			[(data) => { data.reports.security.report.security_findings[0].candidate.sink.cwe = 0; }, /security.report.security_findings.0.candidate.sink.cwe/],
			[(data) => { data.reports["type-aware-unavailable"].report._meta.type_aware.identity.completeness = "complete"; }, /type-aware-unavailable.*completeness/],
			[(data) => { data.reports["type-aware-partial"].report._meta.type_aware.projects[0].status = "complete"; }, /type-aware-partial.*projects.0.status/],
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
