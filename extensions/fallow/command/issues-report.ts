import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../data";

export interface FallowChildExecution {
	binary: string;
	args: string[];
	result: ExecResult;
}

export interface ParsedChildReport {
	label: "combined" | "security";
	execution: FallowChildExecution;
	report?: Record<string, any>;
	parseFailed: boolean;
}

interface ProjectIssueSections {
	check?: Record<string, any>;
	dupes?: Record<string, any>;
	health?: Record<string, any>;
	security?: Record<string, any>;
	securityFindings: any[];
}

interface ProjectIssueCounts {
	code: number;
	security: number;
	total: number;
}

export function buildFallowProjectIssuesReport(
	combinedInput: Record<string, any> | undefined,
	securityInput: Record<string, any> | undefined,
	sources: ParsedChildReport[] = [],
): Record<string, any> {
	const combined = combinedInput ?? {};
	const security = securityInput ?? {};
	const sections = collectProjectIssueSections(combined, security);
	const counts = countProjectIssues(sections);
	const failures = sourceFailures(sources);
	return {
		kind: "project-issues",
		schema_version: firstDefined(combined.schema_version, security.schema_version),
		version: firstDefined(combined.version, security.version),
		elapsed_ms: numericValue(combined.elapsed_ms) + numericValue(security.elapsed_ms),
		total_issues: counts.total,
		summary: projectIssueSummary(counts),
		health_score: combined.health_score,
		check: sections.check,
		dupes: sections.dupes,
		health: sections.health,
		security: sections.security,
		security_findings: sections.securityFindings,
		...aggregateError(failures),
		_meta: buildAggregateMetadata(combined, security),
	};
}

function collectProjectIssueSections(combined: Record<string, any>, security: Record<string, any>): ProjectIssueSections {
	return {
		check: compactIssueArrays(selectRecord(combined, "check", "dead_code")),
		dupes: compactIssueArrays(selectRecord(combined, "dupes", "duplication")),
		health: compactHealthIssueReport(asRecord(combined.health)),
		security: compactSecurityIssueReport(security),
		securityFindings: arrayValue(security.security_findings),
	};
}

function selectRecord(root: Record<string, any>, primary: string, fallback: string): Record<string, any> | undefined {
	return asRecord(root[primary]) ?? asRecord(root[fallback]);
}

function countProjectIssues(sections: ProjectIssueSections): ProjectIssueCounts {
	const code = deadCodeIssueCount(sections.check) + duplicationIssueCount(sections.dupes) + healthIssueCount(sections.health);
	const security = sections.securityFindings.length;
	return { code, security, total: code + security };
}

function duplicationIssueCount(report: Record<string, any> | undefined): number {
	return arrayValue(report?.clone_groups).length;
}

function healthIssueCount(report: Record<string, any> | undefined): number {
	return arrayValue(report?.findings).length + arrayValue(report?.targets).length;
}

function projectIssueSummary(counts: ProjectIssueCounts): Record<string, number> {
	return { total_issues: counts.total, code_issues: counts.code, security_candidates: counts.security };
}

function aggregateError(failures: string[]): Record<string, unknown> {
	if (!failures.length) return {};
	return { error: true, message: `Project issue aggregation was incomplete: ${failures.join("; ")}` };
}

function compactIssueArrays(report: Record<string, any> | undefined): Record<string, any> | undefined {
	if (!report) return undefined;
	return Object.fromEntries(Object.entries(report).filter(([, value]) => keepIssueReportField(value)));
}

function keepIssueReportField(value: unknown): boolean {
	if (!Array.isArray(value)) return true;
	return value.length > 0;
}

function compactHealthIssueReport(report: Record<string, any> | undefined): Record<string, any> | undefined {
	if (!report) return undefined;
	const { file_scores: _fileScores, hotspots: _hotspots, hotspot_summary: _hotspotSummary, target_thresholds: _targetThresholds, ...issues } = report;
	return compactIssueArrays(issues);
}

function compactSecurityIssueReport(report: Record<string, any>): Record<string, any> {
	const {
		security_findings: _securityFindings,
		unresolved_callee_diagnostics: _unresolvedDiagnostics,
		_meta: _metadata,
		...context
	} = report;
	return compactIssueArrays(context) ?? {};
}

function deadCodeIssueCount(report: Record<string, any> | undefined): number {
	if (!report) return 0;
	if (typeof report.total_issues === "number") return report.total_issues;
	return Object.values(report).reduce((count: number, value) => count + arrayLength(value), 0);
}

function arrayLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function arrayValue(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function numericValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstDefined(primary: unknown, fallback: unknown): unknown {
	return primary ?? fallback;
}

function sourceFailures(sources: ParsedChildReport[]): string[] {
	return sources.flatMap(sourceFailure);
}

function sourceFailure(source: ParsedChildReport): string[] {
	const result = source.execution.result;
	if (result.killed) return [`${source.label} analysis was cancelled`];
	if (result.code >= 2) return [`${source.label} analysis exited ${result.code}`];
	if (source.parseFailed) return [`${source.label} analysis did not return structured JSON`];
	return [];
}

function buildAggregateMetadata(combined: Record<string, any>, security: Record<string, any>): Record<string, any> {
	const combinedMeta = asRecord(combined._meta) ?? {};
	return {
		...combinedMeta,
		project_issues: {
			analyses: ["dead-code", "dupes", "health", "security"],
			security: security._meta,
			omitted_informational_context: omittedHealthContext(combined),
		},
	};
}

function omittedHealthContext(combined: Record<string, any>): Record<string, number> {
	const health = asRecord(combined.health) ?? {};
	return {
		file_scores: arrayValue(health.file_scores).length,
		hotspots: arrayValue(health.hotspots).length,
	};
}

export function buildAggregateExecutionResult(report: Record<string, any>, sources: ParsedChildReport[]): ExecResult {
	const killed = sources.some((source) => source.execution.result.killed);
	const fatalCode = sources.reduce(maxFatalSourceCode, 0);
	const code = aggregateExitCode(killed, fatalCode, Number(report.total_issues));
	const stderr = sources.map(sourceStderr).filter(Boolean).join("\n");
	return { stdout: JSON.stringify(report), stderr, code, killed };
}

function maxFatalSourceCode(code: number, source: ParsedChildReport): number {
	if (source.parseFailed) return Math.max(code, 2);
	const sourceCode = source.execution.result.code;
	return Math.max(code, sourceCode >= 2 ? sourceCode : 0);
}

function aggregateExitCode(killed: boolean, fatalCode: number, totalIssues: number): number {
	if (killed) return 130;
	if (fatalCode) return fatalCode;
	return totalIssues > 0 ? 1 : 0;
}

function sourceStderr(source: ParsedChildReport): string {
	return source.execution.result.stderr.trim();
}
