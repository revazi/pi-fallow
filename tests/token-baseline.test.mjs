import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "benchmarks", "corpus.json");
const baselinePath = join(root, "benchmarks", "baselines", "v0.2.0.json");
const preOutputDetailBaselinePath = join(root, "benchmarks", "baselines", "v0.4.0-pre-output-detail.json");
const corpusText = await readFile(corpusPath, "utf8");
const corpus = JSON.parse(corpusText);
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const preOutputDetailBaseline = JSON.parse(await readFile(preOutputDetailBaselinePath, "utf8"));

describe("token benchmark baseline", () => {
	it("is tied to the frozen fixture corpus", async () => {
		assert.equal(baseline.benchmarkVersion, corpus.benchmarkVersion);
		assert.equal(baseline.corpusHash, await hashCorpus());
		assert.equal(baseline.primaryEncoding, "o200k_base");
		assert.deepEqual(baseline.tokenizers.map(({ encoding, version }) => ({ encoding, version })), [
			{ encoding: "o200k_base", version: "1.0.21" },
			{ encoding: "cl100k_base", version: "1.0.21" },
		]);
	});

	it("preserves the measured 0.2.0 before state", () => {
		assert.equal(tokens("tool-contract/active"), 2237);
		assert.equal(tokens("tool-result/no-findings"), 309);
		assert.equal(tokens("tool-result/medium-findings"), 6403);
		assert.equal(tokens("tool-result/large-findings"), 12416);
		assert.equal(tokens("tool-result/schema"), 11497);
		assert.equal(tokens("editor-prompt/medium-findings:20"), 4541);
	});

	it("records finding retention as well as token count", () => {
		const medium = measurement("tool-result/medium-findings");
		assert.equal(medium.quality.includedFindings, 40);
		assert.equal(medium.quality.requiredFieldRetentionPct, 100);

		const large = measurement("tool-result/large-findings");
		assert.equal(large.quality.expectedFindings, 300);
		assert.equal(large.quality.includedFindings, 84);
		assert.equal(large.quality.hasFullOutputReference, true);
	});

	it("preserves the immediate pre-output-detail release baseline", async () => {
		assert.equal(preOutputDetailBaseline.label, "v0.4.0-pre-output-detail");
		assert.equal(preOutputDetailBaseline.environment.gitSha, "2350b0a5f19abfa51d1fd53fa6abf7d7eb0938da");
		assert.equal(preOutputDetailBaseline.corpusHash, await hashCorpus());
		assert.equal(preOutputDetailSurfaceTokens("tool-result"), 45_104);
		assert.equal(preOutputDetailSurfaceTokens("slash-transcript"), 12_645);
		assert.equal(preOutputDetailMeasurement("tool-result/small-findings").quality.includedFindings, 5);
		assert.equal(preOutputDetailMeasurement("tool-result/medium-findings").quality.requiredFieldRetentionPct, 100);
	});
});

function measurement(key) {
	const value = baseline.measurements.find((entry) => entry.key === key);
	assert.ok(value, `Missing baseline measurement: ${key}`);
	return value;
}

function tokens(key) {
	return measurement(key).tokens.o200k_base;
}

function preOutputDetailMeasurement(key) {
	const value = preOutputDetailBaseline.measurements.find((entry) => entry.key === key);
	assert.ok(value, `Missing pre-output-detail baseline measurement: ${key}`);
	return value;
}

function preOutputDetailSurfaceTokens(surface) {
	return preOutputDetailBaseline.measurements
		.filter((entry) => entry.surface === surface)
		.reduce((total, entry) => total + entry.tokens.o200k_base, 0);
}

async function hashCorpus() {
	const hash = createHash("sha256");
	hash.update("corpus.json\0");
	hash.update(corpusText);
	for (const scenario of [...corpus.scenarios].sort((left, right) => left.fixture.localeCompare(right.fixture))) {
		hash.update(`\0${scenario.fixture}\0`);
		hash.update(await readFile(join(root, "benchmarks", scenario.fixture)));
	}
	return `sha256:${hash.digest("hex")}`;
}
