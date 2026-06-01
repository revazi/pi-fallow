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
	const visit = (value: unknown, depth: number): unknown => {
		if (depth > maxDepth || value === null || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		if (!Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			for (const key of keys) {
				if (record[key] !== undefined) return record[key];
			}
			for (const child of Object.values(record)) {
				const found = visit(child, depth + 1);
				if (found !== undefined) return found;
			}
			return undefined;
		}
		for (const child of value) {
			const found = visit(child, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(root, 0);
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
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

	const visit = (value: unknown, depth: number, parentKey?: string) => {
		if (depth > maxDepth || value === null || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				if (parentKey && issueArrayKeys.has(parentKey)) {
					const record = asRecord(item);
					if (record) findings.push(record);
				}
				visit(item, depth + 1, parentKey);
			}
			return;
		}
		const record = value as Record<string, unknown>;
		for (const [key, child] of Object.entries(record)) visit(child, depth + 1, key);
	};

	visit(root, 0);
	return findings;
}

function addPathsFromEntries(paths: Set<string>, entries: unknown): void {
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		const record = asRecord(entry);
		if (!record) continue;
		if (typeof record.path === "string") paths.add(record.path);
		if (typeof record.file === "string") paths.add(record.file);
	}
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
		const severity = String(finding.severity ?? "unknown").toLowerCase().trim() || "unknown";
		counts.set(severity, (counts.get(severity) ?? 0) + 1);
	}
	const order = ["critical", "high", "medium", "low", "info", "warning", "error", "unknown"];
	const sorted = [...counts.entries()].sort((left, right) => {
		const [severityLeft, countLeft] = left;
		const [severityRight, countRight] = right;
		const aIndex = order.indexOf(severityLeft);
		const bIndex = order.indexOf(severityRight);
		if (aIndex !== bIndex) return (aIndex === -1 ? order.length : aIndex) - (bIndex === -1 ? order.length : bIndex);
		return countRight - countLeft;
	});
	return sorted.map(([severity, count]) => ({ severity, count }));
}

export function buildFallowPrSummary(data: unknown, args: string[], exitCode: number): FallowPrSummary | undefined {
	const normalizedArgs = normalizeArgs(args);
	if (!normalizedArgs.includes("audit")) return undefined;

	const root = asRecord(data);
	const baseRef = flagValue(normalizedArgs, "--base")
		?? (findValue(root, ["base_ref", "baseRef", "base"]) as string | undefined);
	const gate = flagValue(normalizedArgs, "--gate")
		?? (findValue(root, ["gate"]) as string | undefined);
	if (gate !== "new-only" && !baseRef) return undefined;

	const findings = collectFindingLikeObjects(root);
	const changedFilesCount = toNumber(findValue(root, ["changed_files_count", "changedFilesCount", "changed_file_count", "changedFileCount"]));
	const explicitIssueCount = toNumber(findValue(root, ["new_issues_count", "newIssuesCount", "new_issues", "total_issues", "totalIssues"]));
	const newIssuesCount = explicitIssueCount ?? findings.length;
	const passed = exitCode === 0 && newIssuesCount === 0;
	const severityBuckets = findings.length ? countSeverityBuckets(findings) : [];

	return {
		baseRef,
		gate: gate ?? "new-only",
		changedFilesCount,
		newIssuesCount,
		passed,
		topAffectedFiles: countTopFiles(findings),
		severityBuckets,
	};
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
	lines.push({ tone: "dim", text: `Base ref: ${summary.baseRef ?? "unknown"}` });
	lines.push({ tone: "dim", text: `Changed files: ${summary.changedFilesCount ?? "unknown"}` });
	lines.push({ tone: "dim", text: `New issues: ${summary.newIssuesCount}` });
	const severitySummaryLine = severityLine(summary);
	if (severitySummaryLine) lines.push(severitySummaryLine);
	const topAffected = buildTopAffectedLine(summary);
	if (topAffected) lines.push(topAffected);
	return { lines };
}
