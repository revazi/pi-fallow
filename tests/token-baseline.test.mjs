import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "benchmarks", "corpus.json");
const baselinePath = join(root, "benchmarks", "baselines", "v0.2.0.json");
const corpusText = await readFile(corpusPath, "utf8");
const corpus = JSON.parse(corpusText);
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

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
});

function measurement(key) {
	const value = baseline.measurements.find((entry) => entry.key === key);
	assert.ok(value, `Missing baseline measurement: ${key}`);
	return value;
}

function tokens(key) {
	return measurement(key).tokens.o200k_base;
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
