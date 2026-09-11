import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { assertEvidenceSubset } from "../scripts/report-certification.mjs";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { allNormalizedFallowEntries, getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
const frozen = JSON.parse(await readFile(new URL("./fixtures/fallow/similar-code-report-3.22.0.json", import.meta.url), "utf8"));

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function overview(id) {
	return buildFallowOverview(frozen.reports[id], 0);
}

function mutate(change) {
	const evidence = structuredClone(frozen);
	change(evidence);
	return evidence;
}

describe("model-backed similar-code certification", () => {
	it("binds evidence to the pinned Fallow, model, input, and immutable review documents", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		const project = await readFile(new URL("./fixtures/fallow/similar-code-project.json", import.meta.url));
		assert.equal(frozen.fallowVersion, manifest.devDependencies.fallow);
		assert.equal(manifest.scripts["smoke:fallow-similar"], "node scripts/similar-code-certification.mjs");
		assert.doesNotMatch(manifest.scripts["check:publish"], /smoke:fallow-similar/);
		assert.equal(frozen.inputSha256, sha256(project));
		assert.deepEqual(frozen.model, {
			id: "jinaai/jina-embeddings-v2-base-code",
			revision: "516f4baf13dec4ddddda8631e019b5737c8bc250",
			license: "Apache-2.0",
		});
		assert.equal(frozen.reports.status.model_ready, true);
		assert.equal(frozen.reports.status.integrity_verified, true);
		assert.equal(frozen.reports.status.analysis_offline, true);
		assert.equal(frozen.reports.status.cache_dir, "<EXISTING_MODEL_CACHE>");
		assert.equal(frozen.inputs.candidatesSha256, sha256(jsonBytes(frozen.reports.discovery)));
		assert.equal(frozen.inputs.verdictsSha256, sha256(jsonBytes(frozen.inputs.verdicts)));
		assert.equal(frozen.reports.review.review.candidates_sha256, frozen.inputs.candidatesSha256);
		assert.equal(frozen.reports.review.review.verdicts_sha256, frozen.inputs.verdictsSha256);
	});

	it("records complete local inference without embedding-cache writes or setup commands", () => {
		assert.ok(frozen.args.discovery.includes("--no-cache"));
		assert.ok(Object.values(frozen.args).flat().every((token) => token !== "setup" && token !== "cache"));
		for (const id of ["discovery", "inspect", "review"]) {
			const report = frozen.reports[id];
			assert.equal(report.completion.status, "complete", id);
			assert.equal(report.completion.cache.status, "disabled", id);
			assert.equal(report.completion.cache.writes, 0, id);
			assert.equal(report.generation.provider.source_left_machine, false, id);
			assert.equal(report.generation.model.model_id, frozen.model.id, id);
			assert.equal(report.generation.model.revision, frozen.model.revision, id);
		}
	});

	it("preserves discovery, source-grounded inspect, and separate review semantics", () => {
		const discovery = frozen.reports.discovery;
		assert.equal(discovery.candidates.length, 1);
		const candidate = discovery.candidates[0];
		assert.deepEqual([candidate.left.path, candidate.right.path], ["beta.js", "alpha.js"]);
		assert.equal(candidate.verification_status, "unverified");
		assert.ok(candidate.similarity >= 0.8);

		const inspect = frozen.reports.inspect;
		assert.equal(inspect.candidate.candidate_id, candidate.candidate_id);
		assert.equal(inspect.packet.candidate_id, candidate.candidate_id);
		assert.equal(inspect.packet.availability.callers, "available");
		assert.equal(inspect.packet.availability.deterministic_clone_coverage, "available");
		assert.match(inspect.packet.left.source_window, /function normalizeBeta/);
		assert.match(inspect.packet.right.source_window, /function normalizeAlpha/);

		const reviewed = frozen.reports.review.candidates[0];
		assert.equal(reviewed.candidate.candidate_id, candidate.candidate_id);
		assert.equal(reviewed.verdict_match, "candidate-id");
		assert.equal(reviewed.outcome, "same-responsibility");
		assert.equal(reviewed.verdict.behaviorally_equivalent, true);
		assert.equal(reviewed.verdict.refactor_safe, false);
		assert.match(reviewed.verdict.rationale, /compatibility plan/);
	});

	it("normalizes all three specialized layouts into actionable, advisory views", () => {
		const status = overview("status");
		assert.equal(status.title, "Fallow similar-code status");
		assert.equal(status.status, "success");
		assert.ok(status.stats.some((entry) => entry.label === "integrity verified" && entry.value === "true"));

		const discovery = overview("discovery");
		const discoveryReport = getNormalizedFallowReport(discovery);
		assert.equal(discovery.title, "Fallow similar code");
		assert.equal(discoveryReport.findingCount, 1);
		assert.match(discovery.notes.join("\n"), /advisory and unverified/);
		assert.match(discovery.notes.join("\n"), /source did not leave the machine/);
		const [candidate] = allNormalizedFallowEntries(discoveryReport);
		assert.equal(candidate.path, "beta.js");
		assert.match(candidate.details, /right alpha\.js:1/);

		const inspect = overview("inspect");
		assert.equal(inspect.title, "Fallow similar-code inspect");
		assert.equal(inspect.sections[0].title, "Inspected semantic candidate");
		assert.match(inspect.sections[0].items[0].action, /abstain/);
		assert.equal(inspect.sections[0].items[0].raw.packet.left.source_window, frozen.reports.inspect.packet.left.source_window);

		const review = overview("review");
		assert.equal(review.title, "Fallow similar-code review");
		assert.equal(review.sections[0].title, "Reviewed semantic candidates");
		assert.match(review.sections[0].items[0].meta, /same-responsibility · match candidate-id/);
		assert.match(review.sections[0].items[0].action, /compatibility plan/);
		assert.match(review.notes.at(-1), /separate verdict document/);
	});

	it("round-trips every complete report through bounded output and readable full-report retention", async () => {
		for (const [id, report] of Object.entries(frozen.reports)) {
			const parsed = parseJson(JSON.stringify(report), "");
			assert.equal(parsed.parsed, true, id);
			const result = await formatToolOutput(parsed, "/fixture", 0, true, "findings");
			try {
				assert.ok(result.fullOutputPath, id);
				assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), report, id);
				assert.ok(result.text.includes(result.fullOutputPath), id);
				assert.ok(result.text.length < 12_000, `${id}: bounded model output`);
			} finally {
				if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
			}
		}
	});

	it("detects selected incompatible drift while allowing additive report fields", () => {
		for (const [change, expected] of [
			[(data) => { data.reports.status.integrity_verified = false; }, /status.integrity_verified/],
			[(data) => { data.reports.discovery.schema_version = "2"; }, /discovery.schema_version/],
			[(data) => { data.reports.discovery.generation.model.revision = "changed"; }, /discovery.generation.model.revision/],
			[(data) => { delete data.reports.discovery.candidates[0].left.source_sha256; }, /left.source_sha256/],
			[(data) => { data.reports.inspect.packet.availability.callers = "unavailable"; }, /inspect.packet.availability.callers/],
			[(data) => { data.reports.review.candidates[0].verdict.refactor_safe = true; }, /review.candidates.0.verdict.refactor_safe/],
			[(data) => { data.reports.review.review.verdicts_sha256 = "changed"; }, /review.review.verdicts_sha256/],
		]) assert.throws(() => assertEvidenceSubset(mutate(change), frozen), expected);
		const additive = mutate((data) => {
			data.reports.discovery.future_evidence = { compatible: true };
			data.reports.inspect.packet.future_context = [];
		});
		assertEvidenceSubset(additive, frozen);
	});
});
