import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { getEncoding } from "js-tiktoken";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseJson } = await jiti.import("../extensions/fallow/json.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
const { fallowOutputDetail } = await jiti.import("../extensions/fallow/output-detail.ts");
const FALLOW_DETAIL_BUDGETS = fallowOutputDetail.budgets;
const DETAIL_TOKEN_REGRESSION_TARGETS = { summary: 1_200, findings: 2_200 };
const tokenizers = {
	o200k_base: getEncoding("o200k_base"),
	cl100k_base: getEncoding("cl100k_base"),
};

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

function detailedReport(count = 1) {
	return {
		kind: "dead-code",
		total_issues: count,
		summary: { unused_exports: count },
		unused_exports: Array.from({ length: count }, (_, index) => ({
			benchmark_id: `finding-${index}`,
			kind: "unused-export",
			export_name: `unusedExport${index}`,
			path: `src/generated/file-${index}.ts`,
			line: index + 1,
			severity: index % 2 ? "medium" : "high",
			evidence: `No reachable consumer was found for unusedExport${index}.`,
			actions: [
				{ type: "suppress-line", description: `Suppress unusedExport${index}.` },
				{ type: "remove-export", description: `Remove unusedExport${index}.` },
			],
			long_detail: "x".repeat(2_000),
		})),
	};
}

async function removeFullOutput(result) {
	if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
}

function assertWithinDetailBudgets(detail, text) {
	const budget = FALLOW_DETAIL_BUDGETS[detail];
	assert.ok(text.length <= budget.characters, `${detail} output exceeded its character budget.`);
	for (const [encoding, tokenizer] of Object.entries(tokenizers)) {
		assert.ok(tokenizer.encode(text).length <= budget.tokens[encoding], `${detail} output exceeded its ${encoding} token budget.`);
	}
}

function assertWithinTokenRegressionTarget(detail, text) {
	for (const [encoding, tokenizer] of Object.entries(tokenizers)) {
		assert.ok(
			tokenizer.encode(text).length <= DETAIL_TOKEN_REGRESSION_TARGETS[detail],
			`${detail} output exceeded its ${encoding} token regression target.`,
		);
	}
}

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

	it("preserves complete JSON for TUI navigator prompts", async () => {
		const report = {
			kind: "dead-code",
			total_issues: 12,
			unused_exports: Array.from({ length: 12 }, (_, index) => ({
				export_name: `unused_${index}`,
				path: `src/file-${index}.ts`,
				line: index + 1,
				evidence: `Complete evidence ${index}`,
			})),
		};
		const parsed = parseJson(JSON.stringify(report), "");
		const withoutNavigator = await formatToolOutput(parsed, process.cwd(), 1);
		const result = await formatToolOutput(parsed, process.cwd(), 1, true);

		assert.equal(withoutNavigator.fullOutputPath, undefined);
		try {
			assert.equal(result.truncated, false);
			assert.ok(result.fullOutputPath);
			assert.equal(await readFile(result.fullOutputPath, "utf8"), JSON.stringify(report, null, 2));
			assert.equal(result.overview.sections[0].items.length, 12);
		} finally {
			if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
		}
	});

	it("saves even a small finding report when the TUI prompt may need full details", async () => {
		const report = { kind: "dead-code", total_issues: 1, unused_exports: [{ export_name: "helper", path: "src/a.ts" }] };
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 1, true);

		try {
			assert.equal(result.truncated, false);
			assert.ok(result.fullOutputPath);
			assert.equal(await readFile(result.fullOutputPath, "utf8"), JSON.stringify(report, null, 2));
		} finally {
			if (result.fullOutputPath) await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
		}
	});

	it("formats structured CLI argument errors without claiming there are no issues", async () => {
		const report = { error: true, message: "missing required issue type", exit_code: 2 };
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 2);

		assert.equal(result.overview.title, "Fallow error");
		assert.deepEqual(result.overview.notes, ["missing required issue type"]);
		assert.match(result.summary, /error: missing required issue type/);
		assert.doesNotMatch(result.text, /No issues found/);
	});

	it("uses raw output when no structured JSON is available", async () => {
		const result = await formatToolOutput({ parsed: false, raw: "plain fallow output" }, process.cwd(), 1);

		assert.equal(result.summary, "No structured summary available.");
		assert.equal(result.overview, undefined);
		assert.match(result.text, /Raw output:\nplain fallow output/);
	});

	it("returns bounded summary status and counts while retaining the complete report", async () => {
		const report = detailedReport(20);
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 1, false, "summary");
		try {
			assert.match(result.text, /^Fallow summary:/);
			const payload = JSON.parse(result.text.slice("Fallow summary:\n".length));
			assert.equal(payload.status, "warning");
			assert.equal(payload.finding_count, 20);
			assert.equal(payload.complete_output_path, result.fullOutputPath);
			assert.doesNotMatch(result.text, /unusedExport0/);
			assert.ok(result.fullOutputPath);
			assert.equal(await readFile(result.fullOutputPath, "utf8"), JSON.stringify(report, null, 2));
			assertWithinDetailBudgets("summary", result.text);
			assertWithinTokenRegressionTarget("summary", result.text);
		} finally {
			await removeFullOutput(result);
		}
	});

	it("reports different statuses for the same summary body at different exit codes", async () => {
		const parsed = parseJson(JSON.stringify({ kind: "health", findings: [], summary: { files_analyzed: 1 } }), "");
		const success = await formatToolOutput(parsed, process.cwd(), 0, false, "summary");
		const warning = await formatToolOutput(parsed, process.cwd(), 1, false, "summary");
		try {
			const successPayload = JSON.parse(success.text.slice("Fallow summary:\n".length));
			const warningPayload = JSON.parse(warning.text.slice("Fallow summary:\n".length));
			assert.equal(successPayload.status, "success");
			assert.equal(warningPayload.status, "warning");
			assert.equal(successPayload.finding_count, warningPayload.finding_count);
		} finally {
			await removeFullOutput(success);
			await removeFullOutput(warning);
		}
	});

	it("truncates oversized summaries within both regression budgets", async () => {
		const report = { kind: "health", summary: { diagnostic: "x".repeat(20_000) } };
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 0, false, "summary");
		try {
			const payload = JSON.parse(result.text.slice("Fallow summary:\n".length));
			assert.equal(result.truncated, true);
			assert.equal(payload.summary_truncated, true);
			assert.equal(payload.status, "success");
			assert.equal(payload.finding_count, 0);
			assertWithinDetailBudgets("summary", result.text);
			assertWithinTokenRegressionTarget("summary", result.text);
		} finally {
			await removeFullOutput(result);
		}
	});

	it("returns bounded normalized findings with locations, evidence, and actions", async () => {
		const report = detailedReport(100);
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 1, false, "findings");
		try {
			assert.match(result.text, /^Fallow findings:/);
			const payload = JSON.parse(result.text.slice("Fallow findings:\n".length));
			assert.equal(payload.detail, "findings");
			assert.equal(payload.finding_count, 100);
			assert.ok(payload.included_findings > 0);
			assert.ok(payload.omitted_findings > 0);
			assert.deepEqual(payload.findings[0], {
				section: "Unused exports",
				type: "unused-export",
				id: "finding-0",
				severity: "high",
				location: { path: "src/generated/file-0.ts", line: 1 },
				subject: "unusedExport0",
				evidence: "No reachable consumer was found for unusedExport0.",
				action: "Remove unusedExport0.",
			});
			assert.deepEqual(payload.findings[5], {
				section: "Unused exports",
				type: "unused-export",
				id: "finding-5",
				severity: "medium",
				location: { path: "src/generated/file-5.ts", line: 6 },
				subject: "unusedExport5",
				evidence: "No reachable consumer was found for unusedExport5.",
				action: "Remove unusedExport5.",
			});
			assert.equal(payload.complete_output_path, result.fullOutputPath);
			assert.doesNotMatch(result.text, /long_detail/);
			assert.equal(result.truncated, true);
			assert.equal(result.overview.sections[0].items[5].raw, undefined);
			assert.equal(await readFile(result.fullOutputPath, "utf8"), JSON.stringify(report, null, 2));
			assertWithinDetailBudgets("findings", result.text);
			assertWithinTokenRegressionTarget("findings", result.text);
		} finally {
			await removeFullOutput(result);
		}
	});

	it("returns normalized context when an informational report has no actionable findings", async () => {
		const report = {
			kind: "health",
			findings: [],
			file_scores: [{ path: "src/risky.ts", maintainability_index: 51, lines: 200, dead_code_ratio: 0.1, crap_max: 20 }],
		};
		const result = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 0, false, "findings");
		try {
			const payload = JSON.parse(result.text.slice("Fallow findings:\n".length));
			assert.equal(payload.finding_count, 0);
			assert.equal(payload.context_count, 1);
			assert.equal(payload.included_context, 1);
			assert.equal(payload.context[0].location.path, "src/risky.ts");
		} finally {
			await removeFullOutput(result);
		}
	});

	it("keeps multilingual summary and findings output valid and within both hard budgets", () => {
		const overview = {
			title: "漢".repeat(2_000),
			status: "warning",
			stats: Array.from({ length: 20 }, (_, index) => ({ label: `stat-${index}`, value: "漢".repeat(500) })),
			sections: [],
			notes: Array.from({ length: 20 }, () => "漢".repeat(1_000)),
		};
		for (const detail of ["summary", "findings"]) {
			const result = fallowOutputDetail.format(detail, "漢".repeat(20_000), overview, "/tmp/fallow-output.json");
			const payload = JSON.parse(result.text.slice(`Fallow ${detail}:\n`.length));
			assert.equal(payload.complete_output_path, "/tmp/fallow-output.json");
			assertWithinDetailBudgets(detail, result.text);
		}
	});

	it("keeps raw detail backward compatible and uses raw text for execution errors", async () => {
		const report = detailedReport(1);
		const raw = await formatToolOutput(parseJson(JSON.stringify(report), ""), process.cwd(), 1, false, "raw");
		assert.match(raw.text, /Raw JSON:/);
		assert.match(raw.text, /long_detail/);
		assert.equal(raw.fullOutputPath, undefined);

		const summary = await formatToolOutput({ parsed: false, raw: "plain execution failure" }, process.cwd(), 2, false, "summary");
		try {
			assert.doesNotMatch(summary.text, /plain execution failure/);
			assert.match(summary.errorText, /Raw output:\nplain execution failure/);
			assert.equal(await readFile(summary.fullOutputPath, "utf8"), "plain execution failure");
		} finally {
			await removeFullOutput(summary);
		}
	});
});
