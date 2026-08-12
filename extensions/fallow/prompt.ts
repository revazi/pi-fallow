import { normalizeFallowIssue, type NormalizedFallowEntry } from "./normalized-report";
import type { FallowIssueLine } from "./types";

export type FallowPromptDetail = "compact" | "full";

export interface FallowPromptFinding {
	sectionTitle: string;
	item: FallowIssueLine;
	normalized?: NormalizedFallowEntry;
}

interface FallowPromptOptions {
	findings: FallowPromptFinding[];
	detail: FallowPromptDetail;
	command?: string;
	fullOutputPath?: string;
	hydrationWarning?: string;
}

const MAX_COMPACT_EVIDENCE_CHARS = 64;
const MAX_COMPACT_ACTION_CHARS = 64;
const MAX_COMPACT_DETAILS_CHARS = 160;

export function buildFallowPrompt(options: FallowPromptOptions): string {
	const header = buildPromptHeader(options);
	const findings = options.findings.map(resolvePromptFinding);
	const compactFindings = buildCompactFindings(findings);
	const fullDetails = options.detail === "full" ? buildFullFindingDetails(findings) : undefined;
	return [header, compactFindings, fullDetails].filter(Boolean).join("\n\n");
}

function resolvePromptFinding(finding: FallowPromptFinding): NormalizedFallowEntry {
	return finding.normalized ?? normalizeFallowIssue(finding.sectionTitle, finding.item);
}

function buildPromptHeader(options: FallowPromptOptions): string {
	return [
		"Please work on the following selected Fallow findings.",
		"",
		"Additional instructions from user:",
		"<!-- Add your comments here before submitting to Pi. -->",
		"",
		"Default task: Inspect the referenced code, decide whether to fix, refactor, delete, add tests, or suppress intentionally, then make the appropriate changes. Rerun the relevant Fallow command after changes.",
		`Prompt detail: ${options.detail}`,
		options.command ? `Fallow command: ${options.command}` : undefined,
		options.fullOutputPath ? `Complete Fallow report: ${options.fullOutputPath}` : undefined,
		options.hydrationWarning ? `Report detail warning: ${options.hydrationWarning}` : undefined,
	].filter((part) => part !== undefined).join("\n");
}

function buildCompactFindings(findings: NormalizedFallowEntry[]): string {
	const lines = [
		`Selected findings: ${findings.length}`,
		"Columns: # | type | severity | location | subject | evidence/details | suggested action",
	];
	let currentSection: string | undefined;
	for (const [index, finding] of findings.entries()) {
		if (finding.section !== currentSection) {
			currentSection = finding.section;
			lines.push(`## ${escapeCompactCell(currentSection)}`);
		}
		lines.push(buildCompactFindingLine(finding, index));
	}
	return lines.join("\n");
}

function buildCompactFindingLine(finding: NormalizedFallowEntry, index: number): string {
	const evidence = compactText(finding.evidence, MAX_COMPACT_EVIDENCE_CHARS);
	const action = compactText(finding.action, MAX_COMPACT_ACTION_CHARS);
	const details = joinDistinct([
		compactIdentifier(finding.id, evidence, action),
		compactText(finding.details, MAX_COMPACT_DETAILS_CHARS),
		evidence,
	]);
	const cells = [
		String(index + 1),
		finding.type,
		finding.severity ?? "unknown",
		findingLocation(finding),
		finding.subject,
		textOrDash(details),
		textOrDash(action),
	];
	return cells.map(escapeCompactCell).join(" | ");
}

function findingLocation(finding: NormalizedFallowEntry): string {
	if (!finding.path) return "unknown";
	return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

function textOrDash(value: string | undefined): string {
	return value || "-";
}

function buildFullFindingDetails(findings: NormalizedFallowEntry[]): string {
	const blocks = findings.map((finding, index) => {
		const raw = finding.raw ?? normalizedFindingFallback(finding);
		return [`### ${index + 1}. ${finding.section}: ${finding.subject}`, "```json", safeJson(raw), "```"].join("\n");
	});
	return ["## Full raw finding JSON", ...blocks].join("\n\n");
}

function normalizedFindingFallback(finding: NormalizedFallowEntry): Record<string, unknown> {
	return {
		section: finding.section,
		label: finding.subject,
		path: finding.path,
		line: finding.line,
		severity: finding.severity,
		details: finding.details,
		action: finding.action,
	};
}

function compactIdentifier(identifier: string | undefined, evidence: string | undefined, action: string | undefined): string | undefined {
	if (!identifier) return undefined;
	if (evidence?.includes(identifier) || action?.includes(identifier)) return undefined;
	return `id ${identifier}`;
}

function compactText(value: string | undefined, maxChars: number): string | undefined {
	if (!value || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function joinDistinct(values: Array<string | undefined>): string {
	return [...new Set(values.filter(Boolean) as string[])].join("; ");
}

function escapeCompactCell(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
