import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEncoding } from "js-tiktoken";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowToolContract: tool } = await jiti.import("../extensions/fallow/contract.ts");
const tokenizers = ["o200k_base", "cl100k_base"].map((name) => [name, getEncoding(name)]);

describe("fallow_run compact contract", () => {
	it("exposes only the compact public parameters", () => {
		assert.deepEqual(Object.keys(tool.parameters.properties), [
			"command", "args", "root", "timeoutSecs", "detail",
		]);
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(tool.parameters.properties.detail.default, "findings");
		assert.match(tool.promptSnippet, /Fallow project analysis/);
		assert.deepEqual(tool.promptGuidelines, [
			"Use fallow_run inspect or trace-symbol before deletion; incomplete type-aware evidence is advisory.",
			"Use fallow_run fix-preview before fix-apply; apply only user-requested changes.",
			"Use fallow_run detail summary or findings routinely; use raw only for necessary diagnostics.",
		]);
		assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes("fallow_run")));
		assert.match(tool.description, /type-aware impact/);
	});

	it("keeps measured prompt guidance within its fixed token budget", () => {
		const contract = JSON.stringify(tool, null, 2);
		const { promptSnippet: _snippet, promptGuidelines: _guidelines, ...withoutGuidance } = tool;
		const baseContract = JSON.stringify(withoutGuidance, null, 2);
		for (const [name, tokenizer] of tokenizers) {
			const totalTokens = tokenizer.encode(contract).length;
			const guidanceTokens = totalTokens - tokenizer.encode(baseContract).length;
			assert.ok(totalTokens <= 440, `${name} contract uses ${totalTokens} tokens`);
			assert.ok(guidanceTokens <= 90, `${name} guidance adds ${guidanceTokens} tokens`);
		}
	});
});
