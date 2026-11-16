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
	const newIssuesCount = resolveIssueCount(root);
	return {
		baseRef,
		gate: gate ?? "new-only",
		changedFilesCount: resolveNumericField(root, ["changed_files_count", "changedFilesCount", "changed_file_count", "changedFileCount"]),
		newIssuesCount,
		passed: resolveVerdict(root, exitCode),
		topAffectedFiles: countTopFiles(findings),
		severityBuckets: findings.length ? countSeverityBuckets(findings) : [],
	};
}

function resolveVerdict(root: Record<string, any> | undefined, exitCode: number): boolean | undefined {
	if (exitCode !== 0) return false;
	const verdicts = new Map<unknown, boolean>([["pass", true], ["warn", true], ["fail", false]]);
	return verdicts.get(root?.verdict);
}

function attributionCount(root: Record<string, any> | undefined): number | undefined {
	const attribution = asRecord(root?.attribution);
	const keys = ["dead_code_introduced", "complexity_introduced", "duplication_introduced", "styling_introduced", "diff_risk_introduced"];
	if (!attribution || !keys.every((key) => Number.isSafeInteger(attribution[key]) && attribution[key] >= 0)) return undefined;
	return keys.reduce((sum, key) => sum + attribution[key], 0);
}

function validCount(value: unknown): number | undefined {
	const count = toNumber(value);
	if (count === undefined || !Number.isSafeInteger(count) || count < 0) return undefined;
	return count;
}

function explicitIssueCount(root: Record<string, any>): number | undefined {
	return validCount(root.new_issues_count) ?? validCount(root.newIssuesCount);
}

function resolveIssueCount(root: Record<string, any> | undefined): number | undefined {
	if (!root) return undefined;
	return attributionCount(root) ?? explicitIssueCount(root);
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
