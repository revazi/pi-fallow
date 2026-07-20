import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEncoding } from "js-tiktoken";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowToolContract: tool } = await jiti.import("../extensions/fallow/contract.ts");
const encoder = getEncoding("o200k_base");

describe("fallow_run compact contract", () => {
	it("exposes only the compact public parameters", () => {
		assert.deepEqual(Object.keys(tool.parameters.properties), [
			"command", "args", "root", "timeoutSecs", "detail",
		]);
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(tool.promptSnippet, undefined);
		assert.equal(tool.promptGuidelines, undefined);
	});

	it("stays below the fixed contract token budget", () => {
		const contract = JSON.stringify(tool, null, 2);
		const tokens = encoder.encode(contract).length;
		assert.ok(tokens <= 350, `contract uses ${tokens} tokens`);
	});
});
