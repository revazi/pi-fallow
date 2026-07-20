import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");

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

	it("accepts embedded object and array root values", () => {
		for (const expected of [{}, [], [true, false, null, -1, 0, "value"], { nested: [1, 2] }]) {
			const result = parseJson(`prefix ${JSON.stringify(expected)} suffix`, "");
			assert.equal(result.parsed, true);
			assert.deepEqual(result.data, expected);
		}
	});

	it("handles nested structures, quoted braces, and escaped string characters", () => {
		const expected = {
			kind: "inspect",
			message: 'quoted } ] { [ and " characters with a trailing \\\\',
			nested: { items: [{ value: 1 }, { value: 2 }] },
		};
		const encoded = JSON.stringify(expected);
		const result = parseJson(`log prefix {not-json}\n${encoded}\nlog suffix`, "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, expected);
		assert.equal(result.raw, encoded);
	});

	it("skips malformed balanced and mismatched candidates before valid JSON", () => {
		const result = parseJson('log {not-json} mismatch {] then [{"kind":"health","total_issues":0}] done', "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, [{ kind: "health", total_issues: 0 }]);
	});

	it("recovers when noisy quoted text contains an unmatched opening brace", () => {
		const result = parseJson('log "message {not json" then {"kind":"health"} done', "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { kind: "health" });
	});

	it("preserves the last complete embedded document without parsing overlapping suffixes", () => {
		const second = { kind: "audit", message: "second" };
		const result = parseJson(`prefix {"kind":"health","message":"first"} middle ${JSON.stringify(second)} suffix`, "");

		assert.deepEqual(result.data, second);
		assert.equal(result.raw, JSON.stringify(second));
	});

	it("can recover JSON split across stdout and stderr", () => {
		const result = parseJson('prefix {"kind":', '"health","total_issues":0} suffix');

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { kind: "health", total_issues: 0 });
	});

	it("scans deeply nested noisy JSON without retrying overlapping suffixes", () => {
		const depth = 800;
		const nested = `${'{"child":'.repeat(depth)}0${"}".repeat(depth)}`;
		const result = parseJson(`prefix ${nested} suffix {"kind":"health"}`, "");

		assert.equal(result.parsed, true);
		assert.deepEqual(result.data, { kind: "health" });
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
		assert.match(result.text, /Raw JSON:\n{\n  "kind": "dead-code"/);
	});

	it("uses raw output when no structured JSON is available", async () => {
		const result = await formatToolOutput({ parsed: false, raw: "plain fallow output" }, process.cwd(), 1);

		assert.equal(result.summary, "No structured summary available.");
		assert.equal(result.overview, undefined);
		assert.match(result.text, /Raw output:\nplain fallow output/);
	});
});
