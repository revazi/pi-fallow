import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowPrSummary } = await jiti.import("../extensions/fallow/pr-summary/build.ts");
const { formatFallowPrSummary } = await jiti.import("../extensions/fallow/pr-summary/format.ts");
const evidence = JSON.parse(await readFile(new URL("./fixtures/fallow/audit-projection-3.42.0.json", import.meta.url), "utf8"));
const args = ["audit", "--base", "HEAD", "--gate", "new-only"];

test("real audit attribution distinguishes inherited findings from introduced findings", () => {
	const inherited = buildFallowPrSummary(evidence.inherited, args, 0);
	assert.equal(inherited.passed, true);
	assert.equal(inherited.newIssuesCount, 0);
	const introduced = buildFallowPrSummary(evidence.new, args, 1);
	assert.equal(introduced.passed, false);
	assert.equal(introduced.newIssuesCount, 1);
	assert.deepEqual(evidence.new.dead_code.unused_exports.map((item) => item.introduced), [false, true]);
});

test("brief's zero exit does not hide its failing structured verdict", () => {
	const summary = buildFallowPrSummary(evidence.brief, [...args, "--brief"], 0);
	assert.equal(summary.passed, false);
	assert.equal(summary.newIssuesCount, 1);
	assert.match(formatFallowPrSummary(summary).lines[0].text, /FAIL/);
});

test("unknown attribution and verdict are not converted into zero or a pass", () => {
	const summary = buildFallowPrSummary({ total_issues: 12 }, args, 0);
	assert.equal(summary.newIssuesCount, undefined);
	assert.equal(summary.passed, undefined);
	assert.match(formatFallowPrSummary(summary).lines[0].text, /UNKNOWN/);
	assert.equal(buildFallowPrSummary({ verdict: "warn" }, args, 0).passed, true);
	assert.equal(buildFallowPrSummary({ verdict: "pass" }, args, 2).passed, false);
});
