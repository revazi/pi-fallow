import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const jiti = createJiti(import.meta.url);
const { fallowProjectIssues } = await jiti.import("../extensions/fallow/command/issues.ts");
const {
	buildReport: buildFallowProjectIssuesReport,
	partitionArgs: partitionFallowProjectIssueArgs,
	runCommands: runFallowProjectIssueCommands,
} = fallowProjectIssues;
const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { formatToolOutput } = await jiti.import("../extensions/fallow/output.ts");
const { buildFallowTranscriptContent } = await jiti.import("../extensions/fallow/command/transcript.ts");

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
			targets: [{ path: "src/shared.ts", category: "split_high_impact", recommendation: "Split shared module" }],
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
	it("projects only enforced warning/failure gates and judgeable baseline advisories", async () => {
		const evidence = JSON.parse(await readFile(new URL("./fixtures/fallow/reports-3.43.1.json", import.meta.url), "utf8"));
		const combined = structuredClone(evidence.reports.combined.report);
		const security = structuredClone(evidence.reports.security.report);
		assert.deepEqual(buildFallowProjectIssuesReport(combined, security).decision_notes, []);
		// Synthetic mutations of genuine captures, not wire captures.
		combined.gate_outcomes = {
			"new-gate": { status: "warn", enforced: true, observed: "SECRET_GATE" },
			"pass-gate": { status: "pass", enforced: true },
			"ignored-gate": { status: "fail", enforced: false },
			"unknown-gate": { status: "future", enforced: true },
		};
		security.gate_outcomes = { security: { status: "fail", enforced: true } };
		combined.check.baseline_staleness = { change_scoped: false, gate_trips: true, stale: false, entries: ["SECRET_BASELINE"] };
		combined.dupes.baseline_staleness = { change_scoped: true, gate_trips: true };
		combined.health.baseline_staleness = { stale: true };
		security.config = { token: "SECRET_CONFIG" };
		const report = buildFallowProjectIssuesReport(combined, security);
		assert.deepEqual(report.decision_notes, [
			"Gate new-gate (combined): warn; enforced.",
			"Gate security (security): fail; enforced.",
			"Baseline advisory (dead-code): stale; excluded from issue counts.",
		]);
		const overview = buildFallowOverview(report);
		assert.equal(getNormalizedFallowReport(overview).findingCount, report.total_issues);
		assert.ok(overview.notes.includes(report.decision_notes[0]));
		const formatted = await formatToolOutput({ parsed: true, data: report, raw: "" }, "/tmp", 0, true, "raw");
		for (const navigator of [true, false]) {
			const transcript = buildFallowTranscriptContent("", formatted.summary, formatted.text, navigator);
			assert.match(transcript, /Gate new-gate \(combined\): warn; enforced/);
			assert.match(transcript, /Baseline advisory/);
			assert.doesNotMatch(transcript, /SECRET_|pass-gate|ignored-gate/);
		}
		assert.match(await readFile(formatted.fullOutputPath, "utf8"), /SECRET_BASELINE/);
		delete combined.gate_outcomes;
		delete security.gate_outcomes;
		delete combined.check.baseline_staleness;
		assert.deepEqual(buildFallowProjectIssuesReport(combined, security).decision_notes, []);
	});

	it("bounds gate notes and distinguishes an unrecognised baseline from narrowed staleness", () => {
		const combined = cleanCombinedReport();
		combined.gate_outcomes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`gate-${i}`, { status: "fail", enforced: true }]));
		combined.check.baseline_staleness = { change_scoped: true, unrecognised_format: true, gate_trips: true };
		combined.dupes.baseline_staleness = { change_scoped: true, stale: true };
		const report = buildFallowProjectIssuesReport(combined, cleanSecurityReport());
		assert.equal(report.decision_notes.length, 9);
		assert.match(report.decision_notes[8], /unrecognised format/);
		assert.equal(report.total_issues, 0);
	});

	it("combines code-quality and security findings while omitting per-file health context", () => {
		const report = buildFallowProjectIssuesReport(combinedReport(), securityReport());
		const overview = buildFallowOverview(report);
		const normalized = getNormalizedFallowReport(overview);

		assert.equal(report.kind, "project-issues");
		assert.equal(report.total_issues, 4);
		assert.equal(report.health.file_scores, undefined);
		assert.equal(report.health.hotspots, undefined);
		assert.equal(report.health.targets, undefined);
		assert.equal(report.security.security_findings, undefined);
		assert.equal(report._meta.project_issues.omitted_informational_context.refactoring_targets, 1);
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
		assert.match(overview.notes[1], /1 advisory health refactoring target/);
	});

	it("does not fall back to listing every health file when the project has no issues", () => {
		const report = buildFallowProjectIssuesReport(cleanCombinedReport(), cleanSecurityReport());
		const overview = buildFallowOverview(report);
		const normalized = getNormalizedFallowReport(overview);

		assert.equal(report.total_issues, 0);
		assert.deepEqual(overview.sections, []);
		assert.equal(normalized.entryCount, 0);
		assert.equal(overview.status, "success");
		assert.match(overview.notes.join("\n"), /1 advisory health refactoring target/);
	});

	it("partitions curated options across combined and security analyses", () => {
		assert.deepEqual(partitionFallowProjectIssueArgs([
			"--changed-since", "main", "--score", "--surface", "--type-aware-project=tsconfig.json",
			"--runtime-coverage", "coverage.json", "--min-invocations-hot=500",
		]), {
			combined: ["--changed-since", "main", "--score", "--type-aware-project=tsconfig.json"],
			security: [
				"--changed-since", "main", "--surface", "--runtime-coverage", "coverage.json", "--min-invocations-hot=500",
			],
		});
		assert.throws(() => partitionFallowProjectIssueArgs(["--file-scores"]), /does not support/);
		assert.throws(() => partitionFallowProjectIssueArgs(["--workspace"]), /requires a value/);
	});

	it("runs the combined and security analyses concurrently and returns one deterministic report", async () => {
		const calls = [];
		let active = 0;
		let maxActive = 0;
		const executeChild = async (_pi, args) => {
			calls.push(args);
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setImmediate(resolve));
			active--;
			const isSecurity = args[0] === "security";
			return {
				binary: "/fixture/fallow",
				args,
				result: execution(isSecurity ? securityReport() : combinedReport(), isSecurity ? 0 : 1),
			};
		};

		const commandArgs = [
			"--score", "--surface", "--runtime-coverage", "coverage.json", "--min-invocations-hot", "500",
		];
		const aggregate = await runFallowProjectIssueCommands({}, commandArgs, "/project", undefined, 10, executeChild);
		assert.deepEqual(calls, [
			["--format", "json", "--quiet", "--score"],
			[
				"security", "--format", "json", "--quiet", "--surface",
				"--runtime-coverage", "coverage.json", "--min-invocations-hot", "500",
			],
		]);
		assert.equal(maxActive, 2);
		assert.equal(aggregate.binary, "/fallow");
		assert.deepEqual(aggregate.args, ["issues", ...commandArgs]);
		assert.equal(aggregate.result.code, 1);
		assert.equal(JSON.parse(aggregate.result.stdout).total_issues, 4);
	});

	it("cancels an in-flight sibling after post-combined cancellation", async () => {
		const controller = new AbortController();
		let calls = 0;
		const executeChild = async (_pi, args, _cwd, signal) => {
			calls++;
			if (args[0] !== "security") {
				controller.abort();
				return { binary: "/fixture/fallow", args, result: execution(cleanCombinedReport()) };
			}
			assert.equal(signal.aborted, true);
			return { binary: "/fixture/fallow", args, result: { stdout: "", stderr: "", code: 130, killed: true } };
		};

		const aggregate = await runFallowProjectIssueCommands(
			{}, [], "/project", controller.signal, 10, executeChild,
		);
		const report = JSON.parse(aggregate.result.stdout);
		assert.equal(calls, 2);
		assert.equal(aggregate.result.code, 130);
		assert.equal(aggregate.result.killed, true);
		assert.equal(report.error, true);
		assert.match(report.message, /security analysis was cancelled/);
	});

	it("retains the sequential schedule for reproducible benchmark comparisons", async () => {
		const controller = new AbortController();
		let calls = 0;
		const executeChild = async (_pi, args) => {
			calls++;
			controller.abort();
			return { binary: "/fixture/fallow", args, result: execution(cleanCombinedReport()) };
		};

		const aggregate = await runFallowProjectIssueCommands(
			{}, [], "/project", controller.signal, 10, executeChild, "sequential",
		);
		assert.equal(calls, 1);
		assert.equal(aggregate.result.code, 130);
		assert.match(JSON.parse(aggregate.result.stdout).message, /security analysis was cancelled/);
	});

	it("cancels the sibling before propagating a child executor failure", async () => {
		let securityStarted = false;
		let securityCancelled = false;
		const executeChild = async (_pi, args, _cwd, signal) => {
			if (args[0] !== "security") {
				await new Promise((resolve) => setImmediate(resolve));
				throw new Error("combined launch failed");
			}
			securityStarted = true;
			return new Promise((resolve) => signal.addEventListener("abort", () => {
				securityCancelled = true;
				resolve({ binary: "/fixture/fallow", args, result: { stdout: "", stderr: "", code: 130, killed: true } });
			}, { once: true }));
		};

		await assert.rejects(
			runFallowProjectIssueCommands({}, [], "/project", undefined, 10, executeChild),
			/combined launch failed/,
		);
		assert.equal(securityStarted, true);
		assert.equal(securityCancelled, true);
	});

	it("keeps combined and security child failures explicit", async () => {
		for (const failedLabel of ["combined", "security"]) {
			const executeChild = async (_pi, args) => {
				const label = args[0] === "security" ? "security" : "combined";
				const report = label === "security" ? cleanSecurityReport() : cleanCombinedReport();
				return { binary: "/fixture/fallow", args, result: execution(report, label === failedLabel ? 2 : 0) };
			};
			const aggregate = await runFallowProjectIssueCommands({}, [], "/project", undefined, 10, executeChild);
			const report = JSON.parse(aggregate.result.stdout);
			assert.equal(aggregate.result.code, 2);
			assert.equal(report.error, true);
			assert.match(report.message, new RegExp(`${failedLabel} analysis exited 2`));
		}
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
