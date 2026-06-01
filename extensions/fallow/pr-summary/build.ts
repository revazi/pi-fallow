import type { FallowPrSummary } from "../types";
import { flagValue, isPrAuditCommand, normalizeArgs } from "./args";
import { asRecord, collectFindingLikeObjects, countSeverityBuckets, countTopFiles, findValue, toNumber } from "./findings";

export function buildFallowPrSummary(data: unknown, args: string[], exitCode: number): FallowPrSummary | undefined {
	const normalizedArgs = normalizeArgs(args);
	if (!isPrAuditCommand(normalizedArgs)) return undefined;
	const root = asRecord(data);
	const { baseRef, gate } = resolvePrMetadata(normalizedArgs, root);
	if (!shouldBuildPrSummary(gate, baseRef)) return undefined;
	return buildPrSummaryFromFindings(root, exitCode, baseRef, gate);
}

function resolvePrMetadata(
	args: string[],
	root: Record<string, any> | undefined,
): { baseRef: string | undefined; gate: string | undefined } {
	return {
		baseRef: resolvePrBaseRef(args, root),
		gate: resolvePrGate(args, root),
	};
}

function buildPrSummaryFromFindings(
	root: Record<string, any> | undefined,
	exitCode: number,
	baseRef: string | undefined,
	gate: string | undefined,
): FallowPrSummary {
	const findings = collectFindingLikeObjects(root);
	const newIssuesCount = resolveIssueCount(root, findings);
	return {
		baseRef,
		gate: gate ?? "new-only",
		changedFilesCount: resolveNumericField(root, ["changed_files_count", "changedFilesCount", "changed_file_count", "changedFileCount"]),
		newIssuesCount,
		passed: exitCode === 0 && newIssuesCount === 0,
		topAffectedFiles: countTopFiles(findings),
		severityBuckets: findings.length ? countSeverityBuckets(findings) : [],
	};
}

function resolveIssueCount(root: Record<string, any> | undefined, findings: Record<string, any>[]): number {
	const explicitIssueCount = resolveNumericField(root, ["new_issues_count", "newIssuesCount", "new_issues", "total_issues", "totalIssues"]);
	return explicitIssueCount ?? findings.length;
}

function resolvePrBaseRef(args: string[], root: Record<string, any> | undefined): string | undefined {
	const commandBase = flagValue(args, "--base");
	if (commandBase) return commandBase;
	return findValue(root, ["base_ref", "baseRef", "base"]) as string | undefined;
}

function resolvePrGate(args: string[], root: Record<string, any> | undefined): string | undefined {
	const commandGate = flagValue(args, "--gate");
	if (commandGate) return commandGate;
	return findValue(root, ["gate"]) as string | undefined;
}

function shouldBuildPrSummary(gate: string | undefined, baseRef: string | undefined): boolean {
	return gate === "new-only" || !!baseRef;
}

function resolveNumericField(root: Record<string, any> | undefined, keys: string[]): number | undefined {
	if (!root) return undefined;
	return toNumber(findValue(root, keys));
}
