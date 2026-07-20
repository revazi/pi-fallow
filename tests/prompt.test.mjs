import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getEncoding } from "js-tiktoken";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowPrompt } = await jiti.import("../extensions/fallow/prompt.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const encoder = getEncoding("o200k_base");

const raw = {
	benchmark_id: "finding-1",
	kind: "unused-export",
	path: "src/a|b.ts",
	line: 12,
	severity: "high",
	evidence: `No callers were found. ${"Evidence ".repeat(40)}`,
	actions: [{ type: "review-finding", description: "Inspect callers and remove the export if it is unused." }],
	extra: { complete: true },
	long_detail: "x".repeat(4000),
};
const findings = [{
	sectionTitle: "Unused exports",
	item: {
		label: "helper",
		path: raw.path,
		line: raw.line,
		severity: raw.severity,
		meta: "public export",
		action: raw.actions[0].description,
		raw,
	},
}];

describe("buildFallowPrompt", () => {
	it("builds a compact prompt with the coding-agent essentials", () => {
		const prompt = buildFallowPrompt({
			findings,
			detail: "compact",
			command: "fallow dead-code --format json --quiet",
			fullOutputPath: "/tmp/pi-fallow/report.json",
		});

		assert.match(prompt, /Prompt detail: compact/);
		assert.match(prompt, /Selected findings: 1/);
		assert.match(prompt, /unused-export/);
		assert.match(prompt, /high/);
		assert.match(prompt, /src\/a\\\|b\.ts:12/);
		assert.match(prompt, /id finding-1/);
		assert.match(prompt, /No callers were found/);
		assert.match(prompt, /Inspect callers and remove the export/);
		assert.match(prompt, /Complete Fallow report: \/tmp\/pi-fallow\/report\.json/);
		assert.match(prompt, /…/);
		assert.doesNotMatch(prompt, /Full raw finding JSON/);
		assert.doesNotMatch(prompt, /"complete": true/);
	});

	it("adds complete raw JSON only in full mode", () => {
		const compact = buildFallowPrompt({ findings, detail: "compact" });
		const full = buildFallowPrompt({ findings, detail: "full" });

		assert.match(full, /Prompt detail: full/);
		assert.match(full, /Full raw finding JSON/);
		assert.match(full, /"benchmark_id": "finding-1"/);
		assert.match(full, /"complete": true/);
		assert.ok(full.includes(`"long_detail": "${"x".repeat(4000)}"`));
		assert.ok(full.length > compact.length);
	});

	it("keeps the 300-finding compact prompt below its regression budget", async () => {
		const report = JSON.parse(await readFile(new URL("../benchmarks/fixtures/large-findings.json", import.meta.url), "utf8"));
		const overview = buildFallowOverview(report, 0, { includeAllRaw: true });
		const allFindings = overview.sections.flatMap((section) => section.items.map((item) => ({ sectionTitle: section.title, item })));
		const options = { findings: allFindings, command: "fallow dead-code --format json --quiet", fullOutputPath: "/tmp/PI_FALLOW_FULL_OUTPUT.json" };
		const compact = buildFallowPrompt({ ...options, detail: "compact" });
		const full = buildFallowPrompt({ ...options, detail: "full" });
		const compactTokens = encoder.encode(compact).length;
		const fullTokens = encoder.encode(full).length;

		assert.equal(allFindings.length, 300);
		assert.ok(compactTokens <= 17_000, `compact prompt uses ${compactTokens} tokens`);
		assert.ok(fullTokens > compactTokens * 3, `full prompt uses ${fullTokens} versus ${compactTokens} compact tokens`);
	});

	it("keeps unknown finding data usable and surfaces hydration warnings", () => {
		const prompt = buildFallowPrompt({
			findings: [{ sectionTitle: "Unknown", item: { label: "unknown finding", raw: { message: "Review this value" } } }],
			detail: "compact",
			hydrationWarning: "Complete report could not be loaded.",
		});

		assert.match(prompt, /## Unknown/);
		assert.match(prompt, /1 \| Unknown \| unknown \| unknown \| unknown finding/);
		assert.match(prompt, /Review this value/);
		assert.match(prompt, /Report detail warning: Complete report could not be loaded\./);
	});
});
