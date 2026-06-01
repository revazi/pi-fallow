// fallow-ignore-file unused-export
import type { FallowPrSummary, FallowSummaryLine, FallowSummaryLines } from "./types";

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function flagValue(args: string[], flag: string): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === flag) return args[index + 1];
		if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
}

function normalizeArgs(args: string[]): string[] {
	const fallowIndex = args.indexOf("fallow");
	return fallowIndex >= 0 ? args.slice(fallowIndex + 1) : args;
}

function findValue(root: unknown, keys: string[], maxDepth = 6): unknown {
	const seen = new Set<unknown>();
	const targetKeys = new Set(keys);
	const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];

	while (stack.length) {
		const { value, depth } = stack.pop()!;
		if (!canTraverseValue(value, depth, maxDepth, seen)) continue;
		seen.add(value);
		const targetValue = extractTargetValue(value, targetKeys, keys);
		if (targetValue !== undefined) return targetValue;
		pushChildrenToStack(stack, value, depth);
	}
	return undefined;
}

function extractTargetValue(value: unknown, targetKeys: Set<string>, keys: string[]): unknown {
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (!targetKeys.has(key)) continue;
		const valueAtKey = record[key];
		if (valueAtKey !== undefined) return valueAtKey;
	}
	return undefined;
}

function pushChildrenToStack(
	stack: Array<{ value: unknown; depth: number }>,
	value: unknown,
	depth: number,
): void {
	if (Array.isArray(value)) {
		for (const child of value) {
			stack.push({ value: child, depth: depth + 1 });
		}
		return;
	}
	for (const [, child] of Object.entries(value as Record<string, unknown>)) {
		stack.push({ value: child, depth: depth + 1 });
	}
}

function canTraverseValue(value: unknown, depth: number, maxDepth: number, seen: Set<unknown>): value is Record<string, any> | unknown[] {
	return depth <= maxDepth && value !== null && typeof value === "object" && !seen.has(value);
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return normalizeFiniteNumber(value);
	if (typeof value === "string") return parseNumericString(value);
	return undefined;
}

function normalizeFiniteNumber(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

function parseNumericString(value: string): number | undefined {
	if (!value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function collectFindingLikeObjects(root: unknown, maxDepth = 7): Record<string, any>[] {
	const findings: Record<string, any>[] = [];
	const seen = new Set<unknown>();
	const issueArrayKeys = new Set([
		"findings",
		"issues",
		"new_issues",
		"violations",
		"unused_files",
		"unused_exports",
		"unused_dependencies",
		"unused_types",
		"clone_groups",
	]);

	const stack: Array<{ value: unknown; depth: number; parentKey?: string }> = [{ value: root, depth: 0 }];
	while (stack.length) {
		const { value, depth, parentKey } = stack.pop()!;
		if (!canTraverseValue(value, depth, maxDepth, seen)) continue;
		seen.add(value);

		if (Array.isArray(value)) {
			collectFromArrayItems(value, parentKey, issueArrayKeys, findings);
			value.forEach((item) => stack.push({ value: item, depth: depth + 1, parentKey }));
			continue;
		}

		Object.entries(value).forEach(([key, child]) => {
			stack.push({ value: child, depth: depth + 1, parentKey: key });
		});
	}
	return findings;
}

function collectFromArrayItems(
	items: unknown[],
	parentKey: string | undefined,
	issueKeySet: Set<string>,
	findings: Record<string, any>[],
): void {
	if (!parentKey || !issueKeySet.has(parentKey)) return;
	items.forEach((item) => {
		const record = asRecord(item);
		if (record) findings.push(record);
	});
}

function addPathsFromEntries(paths: Set<string>, entries: unknown): void {
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		appendEntryPaths(paths, asRecord(entry));
	}
}

function appendEntryPaths(paths: Set<string>, record: Record<string, any> | undefined): void {
	if (!record) return;
	if (typeof record.path === "string") paths.add(record.path);
	if (typeof record.file === "string") paths.add(record.file);
}

function pathsFromFinding(finding: Record<string, any>): string[] {
	const paths = new Set<string>();
	for (const key of ["path", "file", "filename", "source", "target"]) {
		if (typeof finding[key] === "string") paths.add(finding[key]);
	}
	addPathsFromEntries(paths, finding.imported_from);
	addPathsFromEntries(paths, finding.instances);
	return [...paths];
}

function countTopFiles(findings: Record<string, any>[]): string[] {
	const counts = new Map<string, number>();
	for (const finding of findings) {
		for (const path of pathsFromFinding(finding)) counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([path, count]) => count > 1 ? `${path} (${count})` : path);
}

function countSeverityBuckets(findings: Record<string, any>[]): Array<{ severity: string; count: number }> {
	const counts = new Map<string, number>();
	for (const finding of findings) {
		const severity = resolveSeverity(finding.severity);
		counts.set(severity, (counts.get(severity) ?? 0) + 1);
	}
	const sorted = [...counts.entries()].sort((left, right) => compareSeverityBuckets(left, right));
	return sorted.map(([severity, count]) => ({ severity, count }));
}

function resolveSeverity(value: unknown): string {
	const severity = String(value ?? "unknown").toLowerCase().trim();
	return severity || "unknown";
}

const severityOrder = ["critical", "high", "medium", "low", "info", "warning", "error", "unknown"];

function compareSeverityBuckets(left: [string, number], right: [string, number]): number {
	const [severityLeft, countLeft] = left;
	const [severityRight, countRight] = right;
	const aIndex = severityOrder.indexOf(severityLeft);
	const bIndex = severityOrder.indexOf(severityRight);
	if (aIndex !== bIndex) return normalizeSeverityIndex(aIndex) - normalizeSeverityIndex(bIndex);
	return countRight - countLeft;
}

function normalizeSeverityIndex(index: number): number {
	return index === -1 ? severityOrder.length : index;
}

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

function isPrAuditCommand(args: string[]): boolean {
	return args.includes("audit");
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
function severityLine(summary: FallowPrSummary): FallowSummaryLine | undefined {
	if (!summary.severityBuckets || !summary.severityBuckets.length) return undefined;
	const text = summary.severityBuckets
		.map((entry) => `${entry.severity}: ${entry.count}`)
		.join(", ");
	if (!text) return undefined;
	return { tone: "muted", text: `Severity: ${text}` };
}

function buildTopAffectedLine(summary: FallowPrSummary): FallowSummaryLine | undefined {
	if (!summary.topAffectedFiles.length) return undefined;
	return { tone: "muted", text: `Top affected files: ${summary.topAffectedFiles.join(", ")}` };
}

export function formatFallowPrSummary(summary: FallowPrSummary | undefined): FallowSummaryLines | undefined {
	if (!summary) return undefined;
	const lines: FallowSummaryLine[] = [];
	lines.push({ tone: summary.passed ? "success" : "warning", text: `PR audit: ${summary.passed ? "PASS" : "FAIL"}` });
	addPrSummaryLine(lines, "Base ref", summary.baseRef);
	addPrSummaryLine(lines, "Changed files", summary.changedFilesCount);
	addPrSummaryLine(lines, "New issues", summary.newIssuesCount);
	addOptionalLine(lines, severityLine(summary));
	addOptionalLine(lines, buildTopAffectedLine(summary));
	return { lines };
}

function addPrSummaryLine(lines: FallowSummaryLine[], label: string, value: string | number | undefined): void {
	lines.push({ tone: "dim", text: `${label}: ${value ?? "unknown"}` });
}

function addOptionalLine(lines: FallowSummaryLine[], value: FallowSummaryLine | undefined): void {
	if (value) lines.push(value);
}