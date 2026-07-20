import type { FallowIssueLine } from "./types";

export type FallowPromptDetail = "compact" | "full";

export interface FallowPromptFinding {
	sectionTitle: string;
	item: FallowIssueLine;
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
	const compactFindings = buildCompactFindings(options.findings);
	const fullDetails = options.detail === "full" ? buildFullFindingDetails(options.findings) : undefined;
	return [header, compactFindings, fullDetails].filter(Boolean).join("\n\n");
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

function buildCompactFindings(findings: FallowPromptFinding[]): string {
	const lines = [
		`Selected findings: ${findings.length}`,
		"Columns: # | type | severity | location | subject | evidence/details | suggested action",
	];
	let currentSection: string | undefined;
	for (const [index, finding] of findings.entries()) {
		if (finding.sectionTitle !== currentSection) {
			currentSection = finding.sectionTitle;
			lines.push(`## ${escapeCompactCell(currentSection)}`);
		}
		lines.push(buildCompactFindingLine(finding, index));
	}
	return lines.join("\n");
}

function buildCompactFindingLine(finding: FallowPromptFinding, index: number): string {
	const { item } = finding;
	const raw = asRecord(item.raw);
	const evidence = compactText(findingEvidence(raw), MAX_COMPACT_EVIDENCE_CHARS);
	const action = compactText(findingAction(item, raw), MAX_COMPACT_ACTION_CHARS);
	const details = joinDistinct([
		compactIdentifier(findingIdentifier(raw), evidence, action),
		compactText(item.meta, MAX_COMPACT_DETAILS_CHARS),
		evidence,
	]);
	const cells = [
		String(index + 1),
		findingType(raw, finding.sectionTitle),
		findingSeverity(item, raw),
		findingLocation(item),
		item.label,
		textOrDash(details),
		textOrDash(action),
	];
	return cells.map(escapeCompactCell).join(" | ");
}

function findingLocation(item: FallowIssueLine): string {
	if (!item.path) return "unknown";
	return item.line ? `${item.path}:${item.line}` : item.path;
}

function findingSeverity(item: FallowIssueLine, raw: Record<string, any> | undefined): string {
	return item.severity ?? stringValue(recordValue(raw, "severity")) ?? "unknown";
}

function textOrDash(value: string | undefined): string {
	return value || "-";
}

function buildFullFindingDetails(findings: FallowPromptFinding[]): string {
	const blocks = findings.map((finding, index) => {
		const raw = finding.item.raw ?? normalizedFindingFallback(finding);
		return [`### ${index + 1}. ${finding.sectionTitle}: ${finding.item.label}`, "```json", safeJson(raw), "```"].join("\n");
	});
	return ["## Full raw finding JSON", ...blocks].join("\n\n");
}

function normalizedFindingFallback(finding: FallowPromptFinding): Record<string, unknown> {
	return {
		section: finding.sectionTitle,
		label: finding.item.label,
		path: finding.item.path,
		line: finding.item.line,
		severity: finding.item.severity,
		details: finding.item.meta,
		action: finding.item.action,
	};
}

function findingType(raw: Record<string, any> | undefined, fallback: string): string {
	return firstString(recordValues(raw, ["kind", "type", "issue_type", "rule_id"])) ?? fallback;
}

function findingIdentifier(raw: Record<string, any> | undefined): string | undefined {
	return firstString(recordValues(raw, ["benchmark_id", "id", "finding_id"]));
}

function compactIdentifier(identifier: string | undefined, evidence: string | undefined, action: string | undefined): string | undefined {
	if (!identifier) return undefined;
	if (evidence?.includes(identifier) || action?.includes(identifier)) return undefined;
	return `id ${identifier}`;
}

function findingEvidence(raw: Record<string, any> | undefined): string | undefined {
	return firstText(recordValues(raw, ["evidence", "reason", "rationale", "message", "description"]));
}

function findingAction(item: FallowIssueLine, raw: Record<string, any> | undefined): string | undefined {
	if (item.action) return item.action;
	const action = firstRawAction(raw);
	if (action) return action;
	return firstText(recordValues(raw, ["recommendation", "suggested_action"]));
}

function firstRawAction(raw: Record<string, any> | undefined): string | undefined {
	for (const action of arrayValue(raw, "actions")) {
		const text = firstText(recordValues(asRecord(action), ["description", "type"]));
		if (text) return text;
	}
	return undefined;
}

function firstString(values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function firstText(values: unknown[]): string | undefined {
	for (const value of values) {
		const text = valueAsText(value);
		if (text) return text;
	}
	return undefined;
}

function valueAsText(value: unknown): string | undefined {
	if (!isPresentValue(value)) return undefined;
	return typeof value === "string" ? value : safeJson(value);
}

function stringValue(value: unknown): string | undefined {
	return isPresentValue(value) ? String(value) : undefined;
}

function isPresentValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function recordValues(raw: Record<string, any> | undefined, keys: string[]): unknown[] {
	return keys.map((key) => recordValue(raw, key));
}

function recordValue(raw: Record<string, any> | undefined, key: string): unknown {
	return raw ? raw[key] : undefined;
}

function arrayValue(raw: Record<string, any> | undefined, key: string): unknown[] {
	const value = recordValue(raw, key);
	return Array.isArray(value) ? value : [];
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

function asRecord(value: unknown): Record<string, any> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
