import { asRecord } from "../data";

export { asRecord } from "../data";

export function findValue(root: unknown, keys: string[], maxDepth = 6): unknown {
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

export function toNumber(value: unknown): number | undefined {
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

export function collectFindingLikeObjects(root: unknown, maxDepth = 7): Record<string, any>[] {
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

export function countTopFiles(findings: Record<string, any>[]): string[] {
	const counts = new Map<string, number>();
	for (const finding of findings) {
		for (const path of pathsFromFinding(finding)) counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([path, count]) => count > 1 ? `${path} (${count})` : path);
}

export function countSeverityBuckets(findings: Record<string, any>[]): Array<{ severity: string; count: number }> {
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
