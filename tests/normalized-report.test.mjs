import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { allNormalizedFallowEntries, getNormalizedFallowReport, normalizeFallowIssue } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { fallowOutputDetail } = await jiti.import("../extensions/fallow/output-detail.ts");
const { buildFallowPrompt } = await jiti.import("../extensions/fallow/prompt.ts");

function parseFindings(text) {
	return JSON.parse(text.slice("Fallow findings:\n".length));
}

function parseSummary(text) {
	return JSON.parse(text.slice("Fallow summary:\n".length));
}

describe("normalized Fallow reports", () => {
	it("retains authoritative late-entry semantics without retaining every raw object", () => {
		const entries = Array.from({ length: 12 }, (_, index) => ({
			benchmark_id: `benchmark-${index}`,
			id: `id-${index}`,
			finding_id: `finding-${index}`,
			kind: `kind-${index}`,
			type: `type-${index}`,
			issue_type: `issue-${index}`,
			rule_id: `rule-${index}`,
			export_name: `subject-${index}`,
			path: `src/file-${index}.ts`,
			line: index + 1,
			severity: "high",
			evidence: `evidence-${index}`,
			reason: `reason-${index}`,
			actions: [
				{ type: "suppress-line", description: `suppression-${index}` },
				{ type: "review", description: `preferred-${index}` },
			],
			recommendation: `recommendation-${index}`,
		}));
		const overview = buildFallowOverview({ kind: "dead-code", unused_exports: entries });
		const report = getNormalizedFallowReport(overview);
		const normalizedEntries = allNormalizedFallowEntries(report);
		const late = normalizedEntries[11];

		assert.equal(overview.sections[0].items[11].raw, undefined);
		assert.equal(normalizedEntries.filter((entry) => entry.raw !== undefined).length, 5);
		assert.deepEqual({
			role: late.role,
			section: late.section,
			type: late.type,
			id: late.id,
			severity: late.severity,
			path: late.path,
			line: late.line,
			subject: late.subject,
			evidence: late.evidence,
			action: late.action,
		}, {
			role: "finding",
			section: "Unused exports",
			type: "kind-11",
			id: "benchmark-11",
			severity: "high",
			path: "src/file-11.ts",
			line: 12,
			subject: "subject-11",
			evidence: "evidence-11",
			action: "preferred-11",
		});
	});

	it("keeps output-detail and compact prompts on the same precedence-selected fields", () => {
		const entries = Array.from({ length: 6 }, (_, index) => ({
			benchmark_id: `benchmark-${index}`,
			id: `id-${index}`,
			finding_id: `finding-${index}`,
			kind: `kind-${index}`,
			type: `type-${index}`,
			issue_type: `issue-${index}`,
			rule_id: `rule-${index}`,
			export_name: `subject-${index}`,
			path: `src/file-${index}.ts`,
			line: index + 1,
			severity: "medium",
			evidence: `evidence-${index}`,
			reason: `reason-${index}`,
			rationale: `rationale-${index}`,
			message: `message-${index}`,
			description: `description-${index}`,
			actions: [
				{ type: "suppress-file", description: `raw-first-${index}` },
				{ type: "review", description: `item-preferred-${index}` },
			],
			recommendation: `recommendation-${index}`,
			suggested_action: `suggested-${index}`,
		}));
		const overview = buildFallowOverview({ kind: "dead-code", unused_exports: entries });
		const report = getNormalizedFallowReport(overview);
		const late = allNormalizedFallowEntries(report)[5];
		const output = parseFindings(fallowOutputDetail.format("findings", "summary", overview, "/tmp/report.json").text);
		const prompt = buildFallowPrompt({
			findings: [{ sectionTitle: late.section, item: overview.sections[0].items[5], normalized: late }],
			detail: "compact",
		});

		assert.equal(late.raw, undefined);
		assert.deepEqual(output.findings[5], {
			section: "Unused exports",
			type: "kind-5",
			id: "benchmark-5",
			severity: "medium",
			location: { path: "src/file-5.ts", line: 6 },
			subject: "subject-5",
			evidence: "evidence-5",
			action: "item-preferred-5",
		});
		assert.match(prompt, /1 \| kind-5 \| medium \| src\/file-5\.ts:6 \| subject-5 \| id benchmark-5; evidence-5 \| item-preferred-5/);
		assert.doesNotMatch(prompt, /type-5|id-5|reason-5|raw-first-5|recommendation-5/);
	});

	it("preserves every raw-field fallback and preferred-action tier", () => {
		const cases = [
			{
				item: { label: "one", action: "item-action", raw: {
					kind: "kind", type: "type", issue_type: "issue", rule_id: "rule",
					benchmark_id: "benchmark", id: "id", finding_id: "finding",
					evidence: "evidence", reason: "reason", rationale: "rationale", message: "message", description: "description",
					actions: [{ description: "raw-action" }], recommendation: "recommendation", suggested_action: "suggested",
				} },
				expected: ["kind", "benchmark", "evidence", "item-action"],
			},
			{
				item: { label: "two", raw: { type: "type", id: "id", reason: "reason", actions: [{ description: "raw-action" }], recommendation: "recommendation" } },
				expected: ["type", "id", "reason", "raw-action"],
			},
			{
				item: { label: "three", raw: { issue_type: "issue", finding_id: "finding", rationale: "rationale", recommendation: "recommendation" } },
				expected: ["issue", "finding", "rationale", "recommendation"],
			},
			{
				item: { label: "four", raw: { rule_id: "rule", message: "message", suggested_action: "suggested" } },
				expected: ["rule", undefined, "message", "suggested"],
			},
			{
				item: { label: "five", raw: { description: "description" } },
				expected: ["Fallback", undefined, "description", undefined],
			},
		];

		for (const { item, expected } of cases) {
			const entry = normalizeFallowIssue("Fallback", item);
			assert.deepEqual([entry.type, entry.id, entry.evidence, entry.action], expected);
		}
	});

	it("derives finding/context counts and role filtering from the shared report", () => {
		const overview = buildFallowOverview({
			kind: "health",
			findings: [
				{ kind: "complexity", name: "one", path: "src/one.ts" },
				{ kind: "complexity", name: "two", path: "src/two.ts" },
			],
			file_scores: [
				{ path: "src/context-one.ts", maintainability_index: 90 },
				{ path: "src/context-two.ts", maintainability_index: 80 },
				{ path: "src/context-three.ts", maintainability_index: 70 },
			],
		});
		const report = getNormalizedFallowReport(overview);
		const normalizedEntries = allNormalizedFallowEntries(report);
		const summary = parseSummary(fallowOutputDetail.format("summary", "summary", overview, "/tmp/report.json").text);
		const findings = parseFindings(fallowOutputDetail.format("findings", "summary", overview, "/tmp/report.json").text);

		assert.equal(report.findingCount, 2);
		assert.equal(report.contextCount, 3);
		assert.deepEqual(normalizedEntries.map((entry) => entry.role), ["finding", "finding", "context", "context", "context"]);
		assert.equal(summary.finding_count, report.findingCount);
		assert.equal(summary.context_count, report.contextCount);
		assert.equal(findings.finding_count, report.findingCount);
		assert.equal(findings.context_count, report.contextCount);
		assert.equal(findings.findings.length, 2);
		assert.deepEqual(findings.context, []);
	});
});
