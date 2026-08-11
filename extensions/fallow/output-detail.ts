import { Buffer } from "node:buffer";
import { asRecord } from "./data";
import type { FallowIssueLine, FallowOutputDetail, FallowOverview } from "./types";

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
	if (detail === "summary") return formatSummaryDetail(summary, overview, fullOutputPath);
	return formatFindingsDetail(summary, overview, fullOutputPath);
}

function formatSummaryDetail(
	summary: string,
	overview: FallowOverview | undefined,
	fullOutputPath: string,
): DetailFormatResult {
	const payload = createSummaryPayload(summary, overview, fullOutputPath);
	const initiallyTruncated = isSummaryPayloadTruncated(payload);
	fitSummaryPayload(payload, summary);
	return { text: renderSummary(payload), truncated: initiallyTruncated || isSummaryPayloadTruncated(payload) };
}

function createSummaryPayload(
	summary: string,
	overview: FallowOverview | undefined,
	fullOutputPath: string,
): SummaryPayload {
	const stats = normalizeStats(overview);
	const notes = normalizeNotes(overview);
	const statCount = overview ? overview.stats.length : 0;
	const noteCount = overview ? overview.notes.length : 0;
	const compactSummary = compactText(summary, MAX_FINDINGS_SUMMARY_CHARS);
	return {
		detail: "summary",
		title: normalizeTitle(overview),
		status: normalizeStatus(overview),
		summary: compactSummary,
		summary_truncated: compactSummary !== summary,
		finding_count: countEntries(overview, false),
		context_count: countEntries(overview, true),
		stat_count: statCount,
		included_stats: stats.length,
		omitted_stats: statCount - stats.length,
		stats,
		note_count: noteCount,
		included_notes: notes.length,
		omitted_notes: noteCount - notes.length,
		notes,
		complete_output_path: fullOutputPath,
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
	overview: FallowOverview | undefined,
	fullOutputPath: string,
): DetailFormatResult {
	const findingEntries = collectEntries(overview, false);
	const contextEntries = collectContextEntries(overview, findingEntries);
	const payload = createFindingsPayload(summary, overview, fullOutputPath, findingEntries.length);
	fitFindingsMetadata(payload);
	fitEntries(payload, "findings", findingEntries);
	fitEntries(payload, "context", contextEntries);
	return { text: renderFindings(payload), truncated: hasOmittedEntries(payload) };
}

function collectContextEntries(
	overview: FallowOverview | undefined,
	findingEntries: NormalizedFinding[],
): NormalizedFinding[] {
	if (findingEntries.length) return [];
	return collectEntries(overview, true);
}

function createFindingsPayload(
	summary: string,
	overview: FallowOverview | undefined,
	fullOutputPath: string,
	findingCount: number,
): FindingsPayload {
	const contextCount = countEntries(overview, true);
	return {
		detail: "findings",
		title: normalizeTitle(overview),
		status: normalizeStatus(overview),
		summary: compactText(summary, MAX_FINDINGS_SUMMARY_CHARS),
		stats: normalizeStats(overview),
		finding_count: findingCount,
		included_findings: 0,
		omitted_findings: findingCount,
		findings: [],
		context_count: contextCount,
		included_context: 0,
		omitted_context: contextCount,
		context: [],
		notes: normalizeNotes(overview),
		complete_output_path: fullOutputPath,
	};
}

function normalizeTitle(overview: FallowOverview | undefined): string {
	return compactText(overview ? overview.title : "Fallow", MAX_SUBJECT_CHARS);
}

function normalizeStatus(overview: FallowOverview | undefined): SummaryPayload["status"] {
	return overview ? overview.status : "warning";
}

function normalizeNotes(overview: FallowOverview | undefined): string[] {
	const notes = overview ? overview.notes : [];
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

function collectEntries(overview: FallowOverview | undefined, context: boolean): NormalizedFinding[] {
	if (!overview) return [];
	return overview.sections
		.filter((section) => (section.role === "context") === context)
		.flatMap((section) => section.items.map((item) => normalizeFinding(section.title, item)));
}

function countEntries(overview: FallowOverview | undefined, context: boolean): number {
	if (!overview) return 0;
	return overview.sections
		.filter((section) => (section.role === "context") === context)
		.reduce((total, section) => total + section.items.length, 0);
}

function normalizeFinding(section: string, item: FallowIssueLine): NormalizedFinding {
	const raw = asRecord(item.raw);
	return {
		section: compactText(section, MAX_SECTION_CHARS),
		type: compactText(firstString(raw, ["kind", "type", "issue_type", "rule_id"]) || section, MAX_TYPE_CHARS),
		id: compactOptional(firstString(raw, ["benchmark_id", "id", "finding_id"]), MAX_ID_CHARS),
		severity: compactOptional(item.severity || firstString(raw, ["severity"]), MAX_TYPE_CHARS),
		location: normalizeLocation(item),
		subject: compactText(item.label, MAX_SUBJECT_CHARS),
		details: compactOptional(item.meta, MAX_DETAILS_CHARS),
		evidence: compactOptional(firstText(raw, ["evidence", "reason", "rationale", "message", "description"]), MAX_EVIDENCE_CHARS),
		action: normalizeAction(item, raw),
	};
}

function normalizeLocation(item: FallowIssueLine): NormalizedFinding["location"] {
	const path = compactOptional(item.path, MAX_PATH_CHARS);
	if (!path) return undefined;
	if (item.line === undefined) return { path };
	return { path, line: item.line };
}

function normalizeAction(item: FallowIssueLine, raw: Record<string, any> | undefined): string | undefined {
	const value = item.action || firstAction(raw) || firstText(raw, ["recommendation", "suggested_action"]);
	return compactOptional(value, MAX_ACTION_CHARS);
}

function normalizeStats(overview: FallowOverview | undefined): NormalizedStat[] {
	return (overview?.stats ?? []).slice(0, MAX_STATS).map((stat) => ({
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

function firstString(record: Record<string, any> | undefined, keys: string[]): string | undefined {
	if (!record) return undefined;
	return keys.map((key) => record[key]).find(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function firstText(record: Record<string, any> | undefined, keys: string[]): string | undefined {
	const value = firstPresentValue(record, keys);
	return valueAsText(value);
}

function firstPresentValue(record: Record<string, any> | undefined, keys: string[]): unknown {
	if (!record) return undefined;
	return keys.map((key) => record[key]).find(isPresentValue);
}

function isPresentValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function valueAsText(value: unknown): string | undefined {
	if (!isPresentValue(value)) return undefined;
	if (typeof value === "string") return value;
	return stringifyValue(value);
}

function stringifyValue(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function firstAction(record: Record<string, any> | undefined): string | undefined {
	return actionValues(record).map(actionText).find(isNonEmptyString);
}

function actionValues(record: Record<string, any> | undefined): unknown[] {
	return Array.isArray(record?.actions) ? record.actions : [];
}

function actionText(value: unknown): string | undefined {
	return firstText(asRecord(value), ["description", "type"]);
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
