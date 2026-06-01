import type { FallowPrSummary, FallowSummaryLine, FallowSummaryLines } from "../types";

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
