import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { buildFallowPrSummary } = await jiti.import("../extensions/fallow/pr-summary/build.ts");
const { findValue, toNumber, collectFindingLikeObjects, countTopFiles, countSeverityBuckets } = await jiti.import("../extensions/fallow/pr-summary/findings.ts");

test("PR summary finds nested metadata and aggregates distinct paths and severities", () => {
 const findings = [
  { severity: " HIGH ", path: "a.ts", file: "a.ts", instances: [{ path: "b.ts" }, null] },
  { severity: "high", filename: "a.ts", imported_from: [{ file: "b.ts" }] },
  { severity: "", source: "c.ts", target: "d.ts" },
  { severity: "custom", path: "e.ts" },
 ];
 const data = { meta: [{ base_ref: "main", gate: "new-only", changed_files_count: "3" }], findings };
 data.self = data;
 const summary = buildFallowPrSummary(data, ["fallow", "audit"], 0);
 assert.equal(summary.baseRef, "main");
 assert.equal(summary.changedFilesCount, 3);
 assert.deepEqual(summary.topAffectedFiles, ["a.ts (2)", "b.ts (2)", "c.ts", "d.ts", "e.ts"]);
 assert.deepEqual(summary.severityBuckets, [{ severity: "high", count: 2 }, { severity: "unknown", count: 1 }, { severity: "custom", count: 1 }]);
 assert.equal(collectFindingLikeObjects(data).length, 4);
 assert.equal(findValue(data, ["missing"]), undefined);
 assert.equal(findValue({ nested: { value: 1 } }, ["value"], 0), undefined);
});

test("PR summary counts only valid explicit or complete attribution totals", () => {
 const args = ["audit", "--base=branch", "--gate=new-only"];
 const attribution = { dead_code_introduced: 1, complexity_introduced: 2, duplication_introduced: 0, styling_introduced: 0, diff_risk_introduced: 1 };
 assert.equal(buildFallowPrSummary({ attribution, new_issues_count: 99, verdict: "warn" }, args, 0).newIssuesCount, 4);
 assert.equal(buildFallowPrSummary({ attribution: { ...attribution, complexity_introduced: -1 }, new_issues_count: "4" }, args, 0).newIssuesCount, 4);
 assert.equal(buildFallowPrSummary({ new_issues_count: -1, newIssuesCount: "1.5" }, args, 0).newIssuesCount, undefined);
 assert.equal(buildFallowPrSummary({}, ["audit"], 0), undefined);
 assert.equal(buildFallowPrSummary({}, ["health", "--base=main"], 0), undefined);
 assert.equal(buildFallowPrSummary(null, args, 1).passed, false);
 assert.equal(toNumber(" "), undefined);
 assert.equal(toNumber(Infinity), undefined);
 assert.equal(toNumber("NaN"), undefined);
 assert.deepEqual(countTopFiles([{ instances: "not an array" }]), []);
 assert.deepEqual(countSeverityBuckets([{ severity: "z" }, { severity: "z" }, { severity: "other" }]), [{ severity: "z", count: 2 }, { severity: "other", count: 1 }]);
});
