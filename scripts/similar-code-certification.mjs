import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEvidenceSubset } from "./report-certification.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(repository, "tests/fixtures/fallow");
const executable = join(repository, "node_modules/.bin/fallow");
const certifiedModel = {
	id: "jinaai/jina-embeddings-v2-base-code",
	revision: "516f4baf13dec4ddddda8631e019b5737c8bc250",
	license: "Apache-2.0",
};

function environment(configHome) {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	assert.ok(home, "Model-backed certification requires the user's existing model cache; no home directory is available");
	const env = {
		PATH: [join(repository, "node_modules/.bin"), dirname(process.execPath)].join(delimiter),
		HOME: home,
		XDG_CONFIG_HOME: configHome,
		FALLOW_TELEMETRY: "0",
		NO_COLOR: "1",
	};
	for (const key of ["USERPROFILE", "XDG_CACHE_HOME", "LOCALAPPDATA", "APPDATA"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

function execute(args, root, env) {
	const result = spawnSync("node", [executable, ...args], {
		cwd: root, env, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, `${args.join(" ")}: terminated by a signal`);
	return result;
}

function parseSuccessful(result, label) {
	assert.equal(result.status, 0, result.stdout || result.stderr || `${label} failed`);
	const report = JSON.parse(result.stdout);
	normalize(report);
	return report;
}

function normalize(report) {
	normalizeNumericProperty(report, "elapsed_ms");
	normalizeNumericProperty(report.completion, "provider_inference_ms");
	normalizeRunIdentity(report._meta);
	return report;
}

function normalizeNumericProperty(record, key) {
	if (record && key in record) record[key] = 0;
}

function normalizeRunIdentity(meta) {
	if (meta?.telemetry?.analysis_run_id) meta.telemetry.analysis_run_id = "<RUN_ID>";
}

function jsonBytes(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function materialize(root, projectText) {
	await mkdir(join(root, "node_modules"));
	for (const [name, content] of Object.entries(JSON.parse(projectText))) {
		assert.equal(dirname(name), ".", "similar-code fixture inputs must be flat project files");
		await writeFile(join(root, name), content);
	}
}

function assertReady(status, version) {
	assert.equal(status.kind, "similar-code-status");
	assert.equal(status.version, version);
	assert.equal(status.model_ready, true, "The pinned model is not ready. This script never installs or downloads it.");
	assert.equal(status.integrity_verified, true, "The existing pinned model failed integrity verification");
	assert.equal(status.analysis_offline, true);
	assert.equal(status.model_id, certifiedModel.id);
	assert.equal(status.model_revision, certifiedModel.revision);
	assert.equal(status.license, certifiedModel.license);
}

function assertDiscovery(report) {
	assert.equal(report.kind, "similar-code");
	assert.equal(report.completion.status, "complete");
	assert.equal(report.completion.cache.status, "disabled");
	assert.equal(report.completion.cache.writes, 0);
	assert.equal(report.generation.provider.source_left_machine, false);
	assert.equal(report.candidates.length, 1, "fixture must produce one deterministic candidate");
	assert.deepEqual([report.candidates[0].left.path, report.candidates[0].right.path], ["beta.js", "alpha.js"]);
}

function assertInspection(report, candidate) {
	assert.equal(report.kind, "similar-code-inspect");
	assert.equal(report.completion.status, "complete");
	assert.equal(report.candidate.candidate_id, candidate.candidate_id);
	assert.equal(report.packet.candidate_id, candidate.candidate_id);
	assert.equal(report.packet.availability.callers, "available");
	assert.equal(report.packet.availability.deterministic_clone_coverage, "available");
	const generic = (source) => source.replace(/normalize(?:Alpha|Beta)/g, "normalizeFixture");
	assert.equal(generic(report.packet.left.source_window), generic(report.packet.right.source_window));
}

function verdictFor(candidate) {
	return {
		schema_version: "1",
		verdicts: [{
			candidate_id: candidate.candidate_id,
			review_key: candidate.review_key,
			candidate_worthy: true,
			behaviorally_equivalent: true,
			refactor_safe: false,
			outcome: "same-responsibility",
			rationale: "Fixture implementations are identical, but preserving both exported names still requires an explicit compatibility plan.",
		}],
	};
}

export async function collectSimilarCodeEvidence() {
	const projectText = await readFile(join(fixtures, "similar-code-project.json"), "utf8");
	const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
	const version = manifest.devDependencies.fallow;
	const container = await mkdtemp(join(tmpdir(), "pi-fallow-similar-certification-"));
	const root = join(container, "project");
	const config = join(container, "fallow.json");
	const candidatesPath = join(container, "candidates.json");
	const verdictsPath = join(container, "verdicts.json");
	try {
		await mkdir(root);
		await materialize(root, projectText);
		await writeFile(config, "{}\n");
		const env = environment(join(container, "config"));
		const common = ["--root", root, "--config", config];
		const statusArgs = ["similar-code", "status", "--format", "json", "--quiet"];
		const status = parseSuccessful(execute(statusArgs, root, env), "similar-code status");
		assertReady(status, version);
		status.cache_dir = "<EXISTING_MODEL_CACHE>";

		const discoveryArgs = ["similar-code", ...common, "--no-cache", "--threshold", "0.8", "--min-lines", "4", "--top", "1", "--format", "json", "--quiet"];
		const discovery = parseSuccessful(execute(discoveryArgs, root, env), "similar-code discovery");
		assertDiscovery(discovery);
		const candidateBytes = jsonBytes(discovery);
		await writeFile(candidatesPath, candidateBytes);
		const candidate = discovery.candidates[0];

		const inspectArgs = ["similar-code", ...common, "inspect", candidate.candidate_id, "--candidates", candidatesPath, "--format", "json", "--quiet"];
		const inspect = parseSuccessful(execute(inspectArgs, root, env), "similar-code inspect");
		assertInspection(inspect, candidate);

		const verdicts = verdictFor(candidate);
		const verdictBytes = jsonBytes(verdicts);
		await writeFile(verdictsPath, verdictBytes);
		const reviewArgs = ["similar-code", "review", "--candidates", candidatesPath, "--verdicts", verdictsPath, "--require-verdict-for-each-candidate", "--format", "json", "--quiet"];
		const review = parseSuccessful(execute(reviewArgs, root, env), "similar-code review");
		assert.equal(review.kind, "similar-code-review");
		assert.equal(review.completion.status, "complete");
		assert.equal(review.candidates[0].verdict_match, "candidate-id");
		assert.deepEqual(review.candidates[0].verdict, verdicts.verdicts[0]);
		assert.equal(review.review.candidates_sha256, sha256(candidateBytes));
		assert.equal(review.review.verdicts_sha256, sha256(verdictBytes));

		return {
			fallowVersion: version,
			model: certifiedModel,
			inputSha256: sha256(projectText),
			args: {
				status: ["similar-code", "status", "--format", "json", "--quiet"],
				discovery: ["similar-code", "--root", "<PROJECT>", "--config", "<EMPTY_CONFIG>", "--no-cache", "--threshold", "0.8", "--min-lines", "4", "--top", "1", "--format", "json", "--quiet"],
				inspect: ["similar-code", "--root", "<PROJECT>", "--config", "<EMPTY_CONFIG>", "inspect", candidate.candidate_id, "--candidates", "<CANDIDATES>", "--format", "json", "--quiet"],
				review: ["similar-code", "review", "--candidates", "<CANDIDATES>", "--verdicts", "<VERDICTS>", "--require-verdict-for-each-candidate", "--format", "json", "--quiet"],
			},
			inputs: { candidatesSha256: sha256(candidateBytes), verdictsSha256: sha256(verdictBytes), verdicts },
			reports: { status, discovery, inspect, review },
		};
	} finally {
		await rm(container, { recursive: true, force: true });
	}
}

async function main() {
	const evidence = await collectSimilarCodeEvidence();
	const destination = join(fixtures, `similar-code-report-${evidence.fallowVersion}.json`);
	if (process.argv[2] === "--write") {
		assert.equal(process.argv.length, 3, "Usage: similar-code-certification.mjs [--write]");
		await writeFile(destination, jsonBytes(evidence));
		console.log(`Captured complete discovery, inspect, and review evidence for ${evidence.reports.discovery.candidates.length} candidate(s).`);
		return;
	}
	assert.equal(process.argv.length, 2, "Usage: similar-code-certification.mjs [--write]");
	const frozen = JSON.parse(await readFile(destination, "utf8"));
	assertEvidenceSubset(evidence, frozen, "similar-code certification");
	console.log("Optional model-backed similar-code certification passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
