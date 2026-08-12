import { Buffer } from "node:buffer";
import { entriesForFallowRole, getNormalizedFallowReport, type NormalizedFallowEntry, type NormalizedFallowReport } from "./normalized-report";
import type { FallowOutputDetail, FallowOverview } from "./types";

const FALLOW_DETAIL_BUDGETS = {
	summary: { characters: 4_096, tokens: { o200k_base: 4_000, cl100k_base: 4_000 } },
	findings: { characters: 6_000, tokens: { o200k_base: 6_000, cl100k_base: 6_000 } },
} as const;

type DetailBudget = (typeof FALLOW_DETAIL_BUDGETS)[keyof typeof FALLOW_DETAIL_BUDGETS];
type NormalizedStat = { label: string; value: string | number };

interface DetailFormatResult {
	text: string;
	truncated: boolean;
}

interface NormalizedFinding {
	section: string;
	type: string;
	id?: string;
	severity?: string;
	location?: { path: string; line?: number };
	subject: string;
	details?: string;
	evidence?: string;
	action?: string;
}

interface SummaryPayload {
	detail: "summary";
	title: string;
	status: "success" | "warning" | "error";
	summary: string;
	summary_truncated: boolean;
	finding_count: number;
	context_count: number;
	stat_count: number;
	included_stats: number;
	omitted_stats: number;
	stats: NormalizedStat[];
	note_count: number;
	included_notes: number;
	omitted_notes: number;
	notes: string[];
	complete_output_path: string;
}

interface FindingsPayload {
	detail: "findings";
	title: string;
	status: "success" | "warning" | "error";
	summary: string;
	stats: NormalizedStat[];
	finding_count: number;
	included_findings: number;
	omitted_findings: number;
	findings: NormalizedFinding[];
	context_count: number;
	included_context: number;
	omitted_context: number;
	context: NormalizedFinding[];
	notes: string[];
	complete_output_path: string;
}

const SUMMARY_HEADER = "Fallow summary:\n";
const FINDINGS_HEADER = "Fallow findings:\n";
const MAX_FINDINGS_SUMMARY_CHARS = 1_000;
const MAX_STAT_VALUE_CHARS = 200;
const MAX_NOTE_CHARS = 300;
const MAX_SECTION_CHARS = 160;
const MAX_TYPE_CHARS = 160;
const MAX_ID_CHARS = 240;
const MAX_PATH_CHARS = 500;
const MAX_SUBJECT_CHARS = 300;
const MAX_DETAILS_CHARS = 700;
const MAX_EVIDENCE_CHARS = 1_000;
const MAX_ACTION_CHARS = 500;
const MAX_STATS = 12;
const MAX_NOTES = 6;

function formatSelectedOutputDetail(
	detail: Exclude<FallowOutputDetail, "raw">,
	summary: string,
	overview: FallowOverview | undefined,
	fullOutputPath: string,
): DetailFormatResult {
	const report = overview ? getNormalizedFallowReport(overview) : undefined;
	if (detail === "summary") return formatSummaryDetail(summary, report, fullOutputPath);
	return formatFindingsDetail(summary, report, fullOutputPath);
}

function formatSummaryDetail(
	summary: string,
	report: NormalizedFallowReport | undefined,
	fullOutputPath: string,
): DetailFormatResult {
	const payload = createSummaryPayload(summary, report, fullOutputPath);
	const initiallyTruncated = isSummaryPayloadTruncated(payload);
	fitSummaryPayload(payload, summary);
	return { text: renderSummary(payload), truncated: initiallyTruncated || isSummaryPayloadTruncated(payload) };
}

function createSummaryPayload(
	summary: string,
	report: NormalizedFallowReport | undefined,
	fullOutputPath: string,
): SummaryPayload {
	const metadata = buildSummaryMetadata(report);
	const compactSummary = compactText(summary, MAX_FINDINGS_SUMMARY_CHARS);
	return {
		detail: "summary",
		title: metadata.title,
		status: metadata.status,
		summary: compactSummary,
		summary_truncated: compactSummary !== summary,
		finding_count: metadata.findingCount,
		context_count: metadata.contextCount,
		stat_count: metadata.statCount,
		included_stats: metadata.stats.length,
		omitted_stats: metadata.statCount - metadata.stats.length,
		stats: metadata.stats,
		note_count: metadata.noteCount,
		included_notes: metadata.notes.length,
		omitted_notes: metadata.noteCount - metadata.notes.length,
		notes: metadata.notes,
		complete_output_path: fullOutputPath,
	};
}

function buildSummaryMetadata(report: NormalizedFallowReport | undefined) {
	if (!report) {
		return { title: "Fallow", status: "warning" as const, findingCount: 0, contextCount: 0, statCount: 0, stats: [], noteCount: 0, notes: [] };
	}
	return {
		title: normalizeTitle(report),
		status: report.status,
		findingCount: report.findingCount,
		contextCount: report.contextCount,
		statCount: report.stats.length,
		stats: normalizeStats(report),
		noteCount: report.notes.length,
		notes: normalizeNotes(report),
	};
}

function fitSummaryPayload(payload: SummaryPayload, originalSummary: string): void {
	trimSummaryNotes(payload);
	payload.summary = fitStringToBudget(
		payload.summary,
		0,
		(candidate) => renderSummary({ ...payload, summary: candidate, summary_truncated: candidate !== originalSummary }),
		FALLOW_DETAIL_BUDGETS.summary,
	);
	payload.summary_truncated = payload.summary !== originalSummary;
	trimSummaryStats(payload);
	payload.title = fitStringToBudget(
		payload.title,
		1,
		(candidate) => renderSummary({ ...payload, title: candidate }),
		FALLOW_DETAIL_BUDGETS.summary,
	);
}

function trimSummaryNotes(payload: SummaryPayload): void {
	while (!withinBudget(renderSummary(payload), FALLOW_DETAIL_BUDGETS.summary) && payload.notes.length) {
		payload.notes.pop();
		updateSummaryCounts(payload);
	}
}

function trimSummaryStats(payload: SummaryPayload): void {
	while (!withinBudget(renderSummary(payload), FALLOW_DETAIL_BUDGETS.summary) && payload.stats.length) {
		payload.stats.pop();
		updateSummaryCounts(payload);
	}
}

function updateSummaryCounts(payload: SummaryPayload): void {
	payload.included_stats = payload.stats.length;
	payload.omitted_stats = payload.stat_count - payload.included_stats;
	payload.included_notes = payload.notes.length;
	payload.omitted_notes = payload.note_count - payload.included_notes;
}

function isSummaryPayloadTruncated(payload: SummaryPayload): boolean {
	if (payload.summary_truncated || payload.omitted_stats > 0) return true;
	return payload.omitted_notes > 0;
}

function renderSummary(payload: SummaryPayload): string {
	return `${SUMMARY_HEADER}${JSON.stringify(payload)}`;
}

function formatFindingsDetail(
	summary: string,
	report: NormalizedFallowReport | undefined,
	fullOutputPath: string,
): DetailFormatResult {
	const findingEntries = collectEntries(report, "finding");
	const contextEntries = collectContextEntries(report, findingEntries);
	const payload = createFindingsPayload(summary, report, fullOutputPath, findingEntries.length);
	fitFindingsMetadata(payload);
	fitEntries(payload, "findings", findingEntries);
	fitEntries(payload, "context", contextEntries);
	return { text: renderFindings(payload), truncated: hasOmittedEntries(payload) };
}

function collectContextEntries(
	report: NormalizedFallowReport | undefined,
	findingEntries: NormalizedFinding[],
): NormalizedFinding[] {
	if (findingEntries.length) return [];
	return collectEntries(report, "context");
}

function createFindingsPayload(
	summary: string,
	report: NormalizedFallowReport | undefined,
	fullOutputPath: string,
	findingCount: number,
): FindingsPayload {
	const contextCount = report?.contextCount ?? 0;
	return {
		detail: "findings",
		title: normalizeTitle(report),
		status: normalizeStatus(report),
		summary: compactText(summary, MAX_FINDINGS_SUMMARY_CHARS),
		stats: normalizeStats(report),
		finding_count: findingCount,
		included_findings: 0,
		omitted_findings: findingCount,
		findings: [],
		context_count: contextCount,
		included_context: 0,
		omitted_context: contextCount,
		context: [],
		notes: normalizeNotes(report),
		complete_output_path: fullOutputPath,
	};
}

function normalizeTitle(report: NormalizedFallowReport | undefined): string {
	return compactText(report ? report.title : "Fallow", MAX_SUBJECT_CHARS);
}

function normalizeStatus(report: NormalizedFallowReport | undefined): SummaryPayload["status"] {
	return report ? report.status : "warning";
}

function normalizeNotes(report: NormalizedFallowReport | undefined): string[] {
	const notes = report ? report.notes : [];
	return notes.slice(0, MAX_NOTES).map((note) => compactText(note, MAX_NOTE_CHARS));
}

function fitFindingsMetadata(payload: FindingsPayload): void {
	trimFindingsArray(payload, payload.notes);
	trimFindingsArray(payload, payload.stats);
	payload.summary = fitStringToBudget(
		payload.summary,
		0,
		(candidate) => renderFindings({ ...payload, summary: candidate }),
		FALLOW_DETAIL_BUDGETS.findings,
	);
	payload.title = fitStringToBudget(
		payload.title,
		1,
		(candidate) => renderFindings({ ...payload, title: candidate }),
		FALLOW_DETAIL_BUDGETS.findings,
	);
}

function trimFindingsArray(payload: FindingsPayload, values: unknown[]): void {
	while (!withinBudget(renderFindings(payload), FALLOW_DETAIL_BUDGETS.findings) && values.length) values.pop();
}

function hasOmittedEntries(payload: FindingsPayload): boolean {
	return payload.omitted_findings > 0 || payload.omitted_context > 0;
}

function collectEntries(
	report: NormalizedFallowReport | undefined,
	role: NormalizedFallowEntry["role"],
): NormalizedFinding[] {
	if (!report) return [];
	return entriesForFallowRole(report, role).map(normalizeFinding);
}

function normalizeFinding(entry: NormalizedFallowEntry): NormalizedFinding {
	return {
		section: compactText(entry.section, MAX_SECTION_CHARS),
		type: compactText(entry.type, MAX_TYPE_CHARS),
		id: compactOptional(entry.id, MAX_ID_CHARS),
		severity: compactOptional(entry.severity, MAX_TYPE_CHARS),
		location: normalizeLocation(entry),
		subject: compactText(entry.subject, MAX_SUBJECT_CHARS),
		details: compactOptional(entry.details, MAX_DETAILS_CHARS),
		evidence: compactOptional(entry.evidence, MAX_EVIDENCE_CHARS),
		action: compactOptional(entry.action, MAX_ACTION_CHARS),
	};
}

function normalizeLocation(entry: NormalizedFallowEntry): NormalizedFinding["location"] {
	const path = compactOptional(entry.path, MAX_PATH_CHARS);
	if (!path) return undefined;
	if (entry.line === undefined) return { path };
	return { path, line: entry.line };
}

function normalizeStats(report: NormalizedFallowReport | undefined): NormalizedStat[] {
	return (report?.stats ?? []).slice(0, MAX_STATS).map((stat) => ({
		label: compactText(stat.label, MAX_SECTION_CHARS),
		value: typeof stat.value === "number" ? stat.value : compactText(stat.value, MAX_STAT_VALUE_CHARS),
	}));
}

function fitEntries(payload: FindingsPayload, key: "findings" | "context", entries: NormalizedFinding[]): void {
	const target = payload[key];
	for (const entry of entries) {
		target.push(entry);
		updateIncludedCounts(payload);
		if (withinBudget(renderFindings(payload), FALLOW_DETAIL_BUDGETS.findings)) continue;
		target.pop();
		updateIncludedCounts(payload);
		break;
	}
}

function updateIncludedCounts(payload: FindingsPayload): void {
	payload.included_findings = payload.findings.length;
	payload.omitted_findings = payload.finding_count - payload.included_findings;
	payload.included_context = payload.context.length;
	payload.omitted_context = payload.context_count - payload.included_context;
}

function renderFindings(payload: FindingsPayload): string {
	return `${FINDINGS_HEADER}${JSON.stringify(payload)}`;
}

function withinBudget(text: string, budget: DetailBudget): boolean {
	if (text.length > budget.characters) return false;
	// A tokenizer cannot emit more tokens than the non-empty UTF-8 byte sequences it partitions.
	const tokenUpperBound = Buffer.byteLength(text, "utf8");
	return Object.values(budget.tokens).every((limit) => tokenUpperBound <= limit);
}

function fitStringToBudget(
	value: string,
	minimumChars: number,
	render: (candidate: string) => string,
	budget: DetailBudget,
): string {
	if (withinBudget(render(value), budget)) return value;
	let low = minimumChars;
	let high = value.length;
	let best = compactText(value, minimumChars);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = compactText(value, middle);
		if (withinBudget(render(candidate), budget)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function compactOptional(value: string | undefined, maxChars: number): string | undefined {
	return value ? compactText(value, maxChars) : undefined;
}

function compactText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${safeSlice(value, maxChars - 1)}…`;
}

function safeSlice(value: string, end: number): string {
	const sliced = value.slice(0, Math.max(0, end));
	if (!sliced) return sliced;
	const finalCode = sliced.charCodeAt(sliced.length - 1);
	return finalCode >= 0xd800 && finalCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

export const fallowOutputDetail = {
	budgets: FALLOW_DETAIL_BUDGETS,
	format: formatSelectedOutputDetail,
};
