import { asRecord } from "./data";

export type SimilarCodeOverviewStat = { label: string; value: string | number };
type OverviewStat = SimilarCodeOverviewStat;

const EMPTY_RECORD: Record<string, any> = {};

export function addSimilarCodeRunMetadata(
	root: Record<string, any>,
	stats: OverviewStat[],
	notes: string[],
	candidateCount: number,
): void {
	const generation = recordOrEmpty(root.generation);
	const completion = recordOrEmpty(root.completion);
	const model = recordOrEmpty(generation.model);
	const provider = recordOrEmpty(generation.provider);
	const parameters = recordOrEmpty(generation.parameters);
	const scope = recordOrEmpty(generation.scope);
	const cache = recordOrEmpty(completion.cache);
	addStat(stats, "candidates", candidateCount);
	addStat(stats, "completion", completion.status);
	addStat(stats, "threshold", generation.threshold);
	addStat(stats, "provider", provider.provider);
	addStat(stats, "companion", provider.companion_version);
	addStat(stats, "protocol", provider.protocol_version);
	addStat(stats, "model", model.model_id);
	addStat(stats, "model revision", model.revision);
	addStat(stats, "model artifact", model.artifact_sha256);
	addStat(stats, "model license", model.license);
	addStat(stats, "parameters", parameters.parameter_sha256);
	addStat(stats, "scope files", Array.isArray(scope.paths) ? scope.paths.length : undefined);
	addStat(stats, "provider inference", numberWithSuffix(completion.provider_inference_ms, "ms"));
	addStat(stats, "cache", cache.status);
	addTrustNotes(notes, provider, completion);
	appendIncompletePhases(notes, completion.phases);
	appendSkips(notes, completion.skips);
	appendDiagnostics(notes, root.diagnostics);
}

function addTrustNotes(notes: string[], provider: Record<string, any>, completion: Record<string, any>): void {
	notes.push("Semantic similar-code candidates are advisory and unverified until source-grounded review supplies a separate verdict.");
	if (provider.source_left_machine === false) notes.push("Pinned-model inference ran locally; project source did not leave the machine.");
	if (typeof completion.status === "string" && completion.status !== "complete") {
		notes.push(`Similar-code completion is ${completion.status}; an empty or truncated result is not conclusive.`);
	}
}

function appendIncompletePhases(notes: string[], value: unknown): void {
	const phases = asArray(value).map(recordOrEmpty).filter((phase) => phase.status !== "complete");
	for (const phase of phases.slice(0, 3)) {
		const progress = formatPhaseProgress(phase.processed, phase.total);
		notes.push(joinParts([
			`Phase ${stringValue(phase.phase) ?? "unknown"}: ${stringValue(phase.status) ?? "unknown"}${progress}`,
			stringValue(phase.reason),
		])!);
	}
	appendOmittedNote(notes, phases.length, 3, "incomplete phase");
}

function formatPhaseProgress(processed: unknown, total: unknown): string {
	if (typeof processed !== "number") return "";
	return ` (${processed}${typeof total === "number" ? `/${total}` : ""})`;
}

function appendSkips(notes: string[], value: unknown): void {
	const skips = asArray(value).map(recordOrEmpty);
	notes.push(...skips.slice(0, 3).map(formatSkip));
	appendOmittedNote(notes, skips.length, 3, "skip category");
}

function formatSkip(skip: Record<string, any>): string {
	const count = numberValue(skip.count) ?? 0;
	const phase = stringValue(skip.phase) ?? "unknown";
	const reason = stringValue(skip.reason) ?? "unknown";
	return `${count} skipped in ${phase}: ${reason}.`;
}

function appendOmittedNote(notes: string[], count: number, visibleCount: number, label: string): void {
	if (count <= visibleCount) return;
	notes.push(`${count - visibleCount} additional ${label}(s) are in the complete report.`);
}

function appendDiagnostics(notes: string[], value: unknown): void {
	const diagnostics = asArray(value);
	const visible = diagnostics.slice(0, 3).map(formatDiagnostic).filter(isString);
	notes.push(...visible);
	if (diagnostics.length > 3) {
		notes.push(`${diagnostics.length - 3} additional similar-code diagnostic(s) are in the complete report.`);
	}
}

function formatDiagnostic(entry: unknown): string | undefined {
	const diagnostic = recordOrEmpty(entry);
	const message = stringValue(diagnostic.message);
	if (!message) return undefined;
	const path = stringValue(diagnostic.path);
	return path ? `${path}: ${message}` : message;
}

function numberWithSuffix(value: unknown, suffix: string): string | undefined {
	return typeof value === "number" ? `${value}${suffix}` : undefined;
}

export function addSimilarCodeStat(stats: SimilarCodeOverviewStat[], label: string, value: unknown): void {
	if (typeof value === "string" || typeof value === "number") stats.push({ label, value });
}

export function asSimilarCodeArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

export function similarCodeRecord(value: unknown): Record<string, any> {
	return asRecord(value) || EMPTY_RECORD;
}

export function similarCodeString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function similarCodeNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function isSimilarCodeString(value: unknown): value is string {
	return typeof value === "string";
}

export function joinSimilarCodeParts(values: unknown[]): string | undefined {
	const parts = values.filter((value) => value !== undefined && value !== null && value !== "").map(String);
	return parts.length ? parts.join(" · ") : undefined;
}

const addStat = addSimilarCodeStat;
const asArray = asSimilarCodeArray;
const recordOrEmpty = similarCodeRecord;
const stringValue = similarCodeString;
const numberValue = similarCodeNumber;
const isString = isSimilarCodeString;
const joinParts = joinSimilarCodeParts;

