import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatToolOutput, parseJson } = await jiti.import("../extensions/fallow/output.ts");

describe("parseJson", () => {
	it("parses direct JSON from stdout", () => {
		const result = parseJson('{"kind":"health","total_issues":0}', "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { kind: "health", total_issues: 0 });
	});

	it("extracts embedded JSON from noisy output", () => {
		const result = parseJson('starting fallow\n{"kind":"dead-code","summary":{"unused_files":0}}\nfinished', "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { kind: "dead-code", summary: { unused_files: 0 } });
		assert.equal(result.raw, '{"kind":"dead-code","summary":{"unused_files":0}}');
	});

	it("falls back to stderr JSON", () => {
		const result = parseJson("", '{"error":true,"message":"bad args"}');

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { error: true, message: "bad args" });
	});

	it("keeps raw stdout and stderr when no JSON is available", () => {
		const result = parseJson("plain output", "warning text");

		assert.deepEqual(result, {
			parsed: false,
			raw: "plain output\n[stderr]\nwarning text",
		});
	});
});

describe("formatToolOutput", () => {
	it("builds structured summaries and overview data for parsed output", async () => {
		const parsed = parseJson(JSON.stringify({
			kind: "dead-code",
			total_issues: 0,
			summary: { unused_files: 0 },
			unused_files: [],
		}), "");

		const result = await formatToolOutput(parsed, process.cwd(), 0);

		assert.equal(result.summary, 'total_issues: 0\nsummary: {"unused_files":0}\nunused_files: 0');
		assert.equal(result.overview?.title, "Fallow");
		assert.equal(result.overview?.status, "success");
		assert.equal(result.truncated, false);
		assert.match(result.text, /^Fallow summary:\ntotal_issues: 0/m);
		assert.match(result.text, /Raw JSON:\n{/);
	});

	it("uses raw output when no structured JSON is available", async () => {
		const result = await formatToolOutput({ parsed: false, raw: "plain fallow output" }, process.cwd(), 1);

		assert.equal(result.summary, "No structured summary available.");
		assert.equal(result.overview, undefined);
		assert.match(result.text, /Raw output:\nplain fallow output/);
	});
});
