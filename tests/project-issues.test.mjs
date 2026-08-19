import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowProjectIssues } = await jiti.import("../extensions/fallow/command/issues.ts");
const {
	buildReport: buildFallowProjectIssuesReport,
	partitionArgs: partitionFallowProjectIssueArgs,
	runCommands: runFallowProjectIssueCommands,
} = fallowProjectIssues;
const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");

function combinedReport() {
	return {
		kind: "combined",
		schema_version: 7,
		version: "fixture",
		elapsed_ms: 20,
		check: {
			total_issues: 1,
			summary: { total_issues: 1, unused_exports: 1 },
			unused_exports: [{ kind: "unused-export", export_name: "orphan", path: "src/dead.ts" }],
		},
		dupes: {
			clone_groups: [{ instances: [{ file: "src/a.ts", start_line: 2 }, { file: "src/b.ts", start_line: 3 }], line_count: 5, token_count: 40 }],
			stats: { clone_groups: 1 },
		},
		health: {
			findings: [{ kind: "complexity", name: "hard", path: "src/hard.ts", cyclomatic: 21 }],
			file_scores: [{ path: "src/healthy.ts", maintainability_index: 99, lines: 10, dead_code_ratio: 0, crap_max: 1 }],
			hotspots: [{ path: "src/busy.ts", score: 20, commits: 5 }],
			summary: { files_analyzed: 5, functions_above_threshold: 1 },
		},
	};
}

function cleanCombinedReport() {
	const report = combinedReport();
	report.check = { total_issues: 0, summary: { total_issues: 0, unused_exports: 0 }, unused_exports: [] };
	report.dupes = { clone_groups: [], stats: { clone_groups: 0 } };
	report.health.findings = [];
	report.health.summary.functions_above_threshold = 0;
	return report;
}

function securityReport() {
	return {
		kind: "security",
		schema_version: 7,
		version: "fixture",
		elapsed_ms: 5,
		security_findings: [{ kind: "tainted-sink", category: "command-injection", path: "src/run.ts", line: 7, severity: "high" }],
		summary: { finding_count: 1 },
	};
}

function cleanSecurityReport() {
	return { ...securityReport(), security_findings: [], summary: { finding_count: 0 } };
}

function execution(stdout, code = 0) {
	return { stdout: JSON.stringify(stdout), stderr: "", code, killed: false };
}

describe("project issue aggregation", () => {
	it("combines code-quality and security findings while omitting per-file health context", () => {
		const report = buildFallowProjectIssuesReport(combinedReport(), securityReport());
		const overview = buildFallowOverview(report);
		const normalized = getNormalizedFallowReport(overview);

		assert.equal(report.kind, "project-issues");
		assert.equal(report.total_issues, 4);
		assert.equal(report.health.file_scores, undefined);
		assert.equal(report.health.hotspots, undefined);
		assert.equal(report.security.security_findings, undefined);
		assert.equal(overview.title, "Fallow project issues");
		assert.equal(normalized.findingCount, 4);
		assert.equal(normalized.contextCount, 0);
		assert.deepEqual(overview.sections.map((section) => section.title), [
			"Dead code · Unused exports",
			"Dupes · Clone groups",
			"Health · Complexity findings",
			"Security candidates",
		]);
		assert.match(overview.notes[0], /not confirmed vulnerabilities/);
	});

	it("does not fall back to listing every health file when the project has no issues", () => {
		const report = buildFallowProjectIssuesReport(cleanCombinedReport(), cleanSecurityReport());
		const overview = buildFallowOverview(report);
		const normalized = getNormalizedFallowReport(overview);

		assert.equal(report.total_issues, 0);
		assert.deepEqual(overview.sections, []);
		assert.equal(normalized.entryCount, 0);
		assert.equal(overview.status, "success");
	});

	it("partitions curated options across combined and security analyses", () => {
		assert.deepEqual(partitionFallowProjectIssueArgs([
			"--changed-since", "main", "--score", "--surface", "--type-aware-project=tsconfig.json",
		]), {
			combined: ["--changed-since", "main", "--score", "--type-aware-project=tsconfig.json"],
			security: ["--changed-since", "main", "--surface"],
		});
		assert.throws(() => partitionFallowProjectIssueArgs(["--file-scores"]), /does not support/);
		assert.throws(() => partitionFallowProjectIssueArgs(["--workspace"]), /requires a value/);
	});

	it("runs the combined and security analyses sequentially and returns one synthetic report", async () => {
		const calls = [];
		const executeChild = async (_pi, args) => {
			calls.push(args);
			const isSecurity = args[0] === "security";
			return {
				binary: "/fixture/fallow",
				args,
				result: execution(isSecurity ? securityReport() : combinedReport(), isSecurity ? 0 : 1),
			};
		};

		const aggregate = await runFallowProjectIssueCommands({}, ["--score", "--surface"], "/project", undefined, 10, executeChild);
		assert.deepEqual(calls, [
			["--format", "json", "--quiet", "--score"],
			["security", "--format", "json", "--quiet", "--surface"],
		]);
		assert.equal(aggregate.binary, "/fallow");
		assert.deepEqual(aggregate.args, ["issues", "--score", "--surface"]);
		assert.equal(aggregate.result.code, 1);
		assert.equal(JSON.parse(aggregate.result.stdout).total_issues, 4);
	});

	it("marks an unstructured child report as an incomplete aggregate", async () => {
		const executeChild = async (_pi, args) => ({
			binary: "/fixture/fallow",
			args,
			result: args[0] === "security"
				? { stdout: "not json", stderr: "", code: 0, killed: false }
				: execution(combinedReport()),
		});
		const aggregate = await runFallowProjectIssueCommands({}, [], "/project", undefined, 10, executeChild);
		const report = JSON.parse(aggregate.result.stdout);
		assert.equal(aggregate.result.code, 2);
		assert.equal(report.error, true);
		assert.match(report.message, /security analysis did not return structured JSON/);
	});

	it("keeps current and future summary-backed dead-code categories navigable", () => {
		const overview = buildFallowOverview({
			kind: "dead-code",
			total_issues: 2,
			summary: { total_issues: 2, route_collisions: 1, future_framework_issues: 1 },
			route_collisions: [{ path: "src/routes/a.ts", kind: "route-collision" }],
			future_framework_issues: [{ path: "src/future.ts", kind: "future-framework-issue" }],
		});
		assert.deepEqual(overview.sections.map((section) => section.title), ["Route collisions", "Future framework issues"]);
	});
});
