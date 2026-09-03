import { Buffer } from "node:buffer";
import { asRecord } from "./data";
import type { FallowIssueLine, FallowOverview } from "./types";

export type NormalizedFallowEntryRole = "finding" | "context";

export interface NormalizedFallowSource {
	reportIndex: number;
	sectionIndex: number;
	itemIndex: number;
	sectionTitle: string;
}

export interface NormalizedFallowEntry {
	role: NormalizedFallowEntryRole;
	section: string;
	type: string;
	id?: string;
	severity?: string;
	path?: string;
	line?: number;
	subject: string;
	details?: string;
	evidence?: string;
	action?: string;
	source: NormalizedFallowSource;
	raw?: unknown;
}

export interface NormalizedFallowReport {
	title: string;
	status: FallowOverview["status"];
	stats: FallowOverview["stats"];
	notes: string[];
	entryCount: number;
	findingCount: number;
	contextCount: number;
}

interface RetainedSemanticFields {
	type?: string;
	id?: string;
	severity?: string;
	evidence?: string;
	action?: string;
}

interface PackedSemanticFields {
	text: Buffer;
	offsets: Int32Array;
	lengths: Uint32Array;
}

interface NormalizedReportStorage extends PackedSemanticFields {
	overview: FallowOverview;
	sectionIndices: Uint32Array;
	itemIndices: Uint32Array;
}

interface NormalizedReportCollector {
	rows: Array<Array<string | undefined>>;
	sectionIndices: number[];
	itemIndices: number[];
	findingCount: number;
	contextCount: number;
}

interface SemanticPackBuilder {
	offsets: Int32Array;
	lengths: Uint32Array;
	chunks: Buffer[];
	locations: Map<string, { offset: number; length: number }>;
	textLength: number;
}

const TYPE_FIELD = 0;
const ID_FIELD = 1;
const SEVERITY_FIELD = 2;
const EVIDENCE_FIELD = 3;
const ACTION_FIELD = 4;
const SEMANTIC_FIELD_COUNT = 5;
const SOURCE_COORDINATE_KEYS = ["reportIndex", "sectionIndex", "itemIndex", "sectionTitle"] as const;
const SEMANTIC_IDENTITY_KEYS = [
	"role", "section", "type", "id", "severity", "path", "line", "subject", "details", "evidence", "action",
] as const;

const retainedSemanticFields = new WeakMap<FallowIssueLine, RetainedSemanticFields>();
const normalizedReports = new WeakMap<FallowOverview, NormalizedFallowReport>();
const normalizedReportStorage = new WeakMap<NormalizedFallowReport, NormalizedReportStorage>();

/** Retain only semantic scalars while the overview intentionally drops most raw entry objects. */
export function retainNormalizedFallowEntry(item: FallowIssueLine, raw: unknown): void {
	retainedSemanticFields.set(item, extractSemanticFields(asRecord(raw)));
}

export function getNormalizedFallowReport(overview: FallowOverview): NormalizedFallowReport {
	const retained = normalizedReports.get(overview);
	if (retained) return retained;
	const report = normalizeFallowReport(overview);
	normalizedReports.set(overview, report);
	return report;
}

export function normalizeFallowIssue(
	section: string,
	item: FallowIssueLine,
	role: NormalizedFallowEntryRole = "finding",
	source: NormalizedFallowSource = { reportIndex: -1, sectionIndex: -1, itemIndex: -1, sectionTitle: section },
): NormalizedFallowEntry {
	const retained = retainedSemanticFields.get(item) ?? extractSemanticFields(asRecord(item.raw));
	retainedSemanticFields.delete(item);
	return createNormalizedEntry(section, item, role, source, retained);
}

function getNormalizedFallowEntry(
	report: NormalizedFallowReport,
	reportIndex: number,
): NormalizedFallowEntry {
	assertNormalizedEntryIndex(report, reportIndex);
	const storage = requireStorage(report);
	const { section, item, source } = resolveNormalizedSource(storage, reportIndex);
	return createNormalizedEntry(
		section.title,
		item,
		section.role === "context" ? "context" : "finding",
		source,
		readSemanticFields(storage, reportIndex),
	);
}

function assertNormalizedEntryIndex(report: NormalizedFallowReport, reportIndex: number): void {
	const valid = [Number.isInteger(reportIndex), reportIndex >= 0, reportIndex < report.entryCount].every(Boolean);
	if (!valid) throw new Error("Normalized Fallow entry index is out of range.");
}

function resolveNormalizedSource(storage: NormalizedReportStorage, reportIndex: number): {
	section: FallowOverview["sections"][number];
	item: FallowIssueLine;
	source: NormalizedFallowSource;
} {
	const sectionIndex = storage.sectionIndices[reportIndex]!;
	const itemIndex = storage.itemIndices[reportIndex]!;
	const section = storage.overview.sections[sectionIndex];
	if (!section) throw new Error("Normalized Fallow section coordinates do not match the overview.");
	const item = section.items[itemIndex];
	if (!item) throw new Error("Normalized Fallow item coordinates do not match the overview.");
	return { section, item, source: { reportIndex, sectionIndex, itemIndex, sectionTitle: section.title } };
}

function readSemanticFields(storage: PackedSemanticFields, reportIndex: number): RetainedSemanticFields {
	return {
		type: readSemanticField(storage, reportIndex, TYPE_FIELD),
		id: readSemanticField(storage, reportIndex, ID_FIELD),
		severity: readSemanticField(storage, reportIndex, SEVERITY_FIELD),
		evidence: readSemanticField(storage, reportIndex, EVIDENCE_FIELD),
		action: readSemanticField(storage, reportIndex, ACTION_FIELD),
	};
}

export function allNormalizedFallowEntries(report: NormalizedFallowReport): NormalizedFallowEntry[] {
	return Array.from({ length: report.entryCount }, (_, index) => getNormalizedFallowEntry(report, index));
}

export function entriesForFallowRole(
	report: NormalizedFallowReport,
	role: NormalizedFallowEntryRole,
): NormalizedFallowEntry[] {
	const entries: NormalizedFallowEntry[] = [];
	for (let index = 0; index < report.entryCount; index++) {
		const entry = getNormalizedFallowEntry(report, index);
		if (entry.role === role) entries.push(entry);
	}
	return entries;
}

export function hydrateNormalizedFallowEntry(
	report: NormalizedFallowReport,
	expected: NormalizedFallowEntry,
): NormalizedFallowEntry {
	const candidate = getNormalizedFallowEntry(report, expected.source.reportIndex);
	if (!sameSource(candidate.source, expected.source) || !sameSemantics(candidate, expected)) {
		throw new Error("Complete report coordinates do not match the selected finding.");
	}
	return candidate;
}

function normalizeFallowReport(overview: FallowOverview): NormalizedFallowReport {
	const collector = createNormalizedReportCollector();
	for (const [sectionIndex, section] of overview.sections.entries()) {
		appendNormalizedSection(collector, section, sectionIndex);
	}
	const report = createNormalizedReport(overview, collector);
	storeNormalizedReport(report, overview, collector);
	return report;
}

function createNormalizedReportCollector(): NormalizedReportCollector {
	return { rows: [], sectionIndices: [], itemIndices: [], findingCount: 0, contextCount: 0 };
}

function appendNormalizedSection(
	collector: NormalizedReportCollector,
	section: FallowOverview["sections"][number],
	sectionIndex: number,
): void {
	const context = section.role === "context";
	collector.contextCount += context ? section.items.length : 0;
	collector.findingCount += context ? 0 : section.items.length;
	for (const [itemIndex, item] of section.items.entries()) appendNormalizedItem(collector, section.title, item, sectionIndex, itemIndex);
}

function appendNormalizedItem(
	collector: NormalizedReportCollector,
	sectionTitle: string,
	item: FallowIssueLine,
	sectionIndex: number,
	itemIndex: number,
): void {
	const retained = takeRetainedSemanticFields(item);
	collector.rows.push(buildSemanticRow(sectionTitle, item, retained));
	collector.sectionIndices.push(sectionIndex);
	collector.itemIndices.push(itemIndex);
}

function takeRetainedSemanticFields(item: FallowIssueLine): RetainedSemanticFields {
	const retained = retainedSemanticFields.get(item) ?? extractSemanticFields(asRecord(item.raw));
	retainedSemanticFields.delete(item);
	return retained;
}

function buildSemanticRow(
	sectionTitle: string,
	item: FallowIssueLine,
	retained: RetainedSemanticFields,
): Array<string | undefined> {
	return [
		retained.type ?? sectionTitle,
		retained.id,
		fallbackSemanticField(item.severity, retained.severity),
		retained.evidence,
		fallbackSemanticField(item.action, retained.action),
	];
}

function fallbackSemanticField(primary: string | undefined, fallback: string | undefined): string | undefined {
	return primary ? undefined : fallback;
}

function createNormalizedReport(overview: FallowOverview, collector: NormalizedReportCollector): NormalizedFallowReport {
	return {
		title: overview.title,
		status: overview.status,
		stats: overview.stats,
		notes: overview.notes,
		entryCount: collector.rows.length,
		findingCount: collector.findingCount,
		contextCount: collector.contextCount,
	};
}

function storeNormalizedReport(
	report: NormalizedFallowReport,
	overview: FallowOverview,
	collector: NormalizedReportCollector,
): void {
	normalizedReportStorage.set(report, {
		overview,
		sectionIndices: Uint32Array.from(collector.sectionIndices),
		itemIndices: Uint32Array.from(collector.itemIndices),
		...packSemanticFields(collector.rows),
	});
}

function createNormalizedEntry(
	section: string,
	item: FallowIssueLine,
	role: NormalizedFallowEntryRole,
	source: NormalizedFallowSource,
	retained: RetainedSemanticFields,
): NormalizedFallowEntry {
	return {
		role,
		section,
		type: retained.type ?? section,
		id: retained.id,
		severity: item.severity || retained.severity,
		path: item.path,
		line: item.line,
		subject: item.label,
		details: item.meta,
		evidence: retained.evidence,
		action: item.action || retained.action,
		source,
		raw: item.raw,
	};
}

function packSemanticFields(rows: Array<Array<string | undefined>>): PackedSemanticFields {
	const builder = createSemanticPackBuilder(rows.length);
	for (const [rowIndex, row] of rows.entries()) packSemanticRow(builder, row, rowIndex);
	return { text: Buffer.concat(builder.chunks, builder.textLength), offsets: builder.offsets, lengths: builder.lengths };
}

function createSemanticPackBuilder(rowCount: number): SemanticPackBuilder {
	const offsets = new Int32Array(rowCount * SEMANTIC_FIELD_COUNT);
	offsets.fill(-1);
	return { offsets, lengths: new Uint32Array(offsets.length), chunks: [], locations: new Map(), textLength: 0 };
}

function packSemanticRow(builder: SemanticPackBuilder, row: Array<string | undefined>, rowIndex: number): void {
	for (let fieldIndex = 0; fieldIndex < SEMANTIC_FIELD_COUNT; fieldIndex++) {
		packSemanticValue(builder, row[fieldIndex], rowIndex * SEMANTIC_FIELD_COUNT + fieldIndex);
	}
}

function packSemanticValue(builder: SemanticPackBuilder, value: string | undefined, packedIndex: number): void {
	if (value === undefined) return;
	let location = builder.locations.get(value);
	if (!location) location = appendSemanticChunk(builder, value);
	builder.offsets[packedIndex] = location.offset;
	builder.lengths[packedIndex] = location.length;
}

function appendSemanticChunk(builder: SemanticPackBuilder, value: string): { offset: number; length: number } {
	const chunk = Buffer.from(value, "utf8");
	const location = { offset: builder.textLength, length: chunk.length };
	builder.locations.set(value, location);
	builder.chunks.push(chunk);
	builder.textLength += chunk.length;
	return location;
}

function readSemanticField(
	storage: PackedSemanticFields,
	reportIndex: number,
	fieldIndex: number,
): string | undefined {
	const packedIndex = reportIndex * SEMANTIC_FIELD_COUNT + fieldIndex;
	const offset = storage.offsets[packedIndex]!;
	if (offset < 0) return undefined;
	return storage.text.toString("utf8", offset, offset + storage.lengths[packedIndex]!);
}

function requireStorage(report: NormalizedFallowReport): NormalizedReportStorage {
	const storage = normalizedReportStorage.get(report);
	if (!storage) throw new Error("Normalized Fallow report storage is unavailable.");
	return storage;
}

function extractSemanticFields(raw: Record<string, any> | undefined): RetainedSemanticFields {
	const source = asRecord(raw?.candidate) ?? raw;
	return {
		type: firstString(source, ["kind", "type", "issue_type", "rule_id"]),
		id: firstString(source, ["candidate_id", "benchmark_id", "id", "finding_id"]),
		severity: firstString(source, ["severity"]),
		evidence: firstText(source, ["evidence", "reason", "rationale", "message", "description"]),
		action: firstAction(source) || firstText(source, ["recommendation", "suggested_action"]),
	};
}

function firstString(record: Record<string, any> | undefined, keys: string[]): string | undefined {
	if (!record) return undefined;
	return keys.map((key) => record[key]).find(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function firstText(record: Record<string, any> | undefined, keys: string[]): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const text = valueAsText(record[key]);
		if (text) return text;
	}
	return undefined;
}

function valueAsText(value: unknown): string | undefined {
	if (([undefined, null, ""] as unknown[]).includes(value)) return undefined;
	if (typeof value === "string") return value;
	return stringifyText(value);
}

function stringifyText(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized === "string") return serialized;
	} catch {
		return String(value);
	}
	return String(value);
}

function firstAction(record: Record<string, any> | undefined): string | undefined {
	const actions = Array.isArray(record?.actions) ? record.actions : [];
	return actions.map((action) => firstText(asRecord(action), ["description", "type"])).find(isNonEmptyString);
}

function sameSource(left: NormalizedFallowSource, right: NormalizedFallowSource): boolean {
	return SOURCE_COORDINATE_KEYS.every((key) => left[key] === right[key]);
}

function sameSemantics(left: NormalizedFallowEntry, right: NormalizedFallowEntry): boolean {
	return SEMANTIC_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}
