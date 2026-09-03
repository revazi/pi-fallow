import { asRecord } from "./data";
import { retainNormalizedFallowEntry } from "./normalized-report";
import { isMissingSimilarCodeModelMessage } from "./similar-code";
import type { FallowIssueLine, FallowOverviewSection } from "./types";

const INLINE_RAW_CANDIDATES = 5;

type OverviewStat = { label: string; value: string | number };
type MutableTitle = { value: string };
type SimilarCodeOverviewHandler = (
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
) => void;

const EMPTY_RECORD: Record<string, any> = {};
const SIMILAR_CODE_OVERVIEW_HANDLERS = new Map<string, SimilarCodeOverviewHandler>([
	["similar-code-status", (root, stats, _sections, title, notes) => addSimilarCodeStatus(root, stats, title, notes)],
	["similar-code", addSimilarCodeCandidates],
	["similar-code-inspect", (root, stats, sections, title, notes) => addSimilarCodeInspect(root, stats, sections, title, notes)],
	["similar-code-review", addSimilarCodeReview],
]);

export function addSimilarCodeOverview(
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
): void {
	const handler = SIMILAR_CODE_OVERVIEW_HANDLERS.get(root.kind);
	if (handler) return handler(root, stats, sections, title, notes, includeAllRaw);
	addSimilarCodeErrorGuidance(root, title, notes);
}

function addSimilarCodeStatus(root: Record<string, any>, stats: OverviewStat[], title: MutableTitle, notes: string[]): void {
	title.value = "Fallow similar-code status";
	addStat(stats, "model ready", String(root.model_ready === true));
	addStat(stats, "model", root.model_id);
	addStat(stats, "revision", root.model_revision);
	addStat(stats, "companion", root.companion_version);
	addStat(stats, "protocol", root.protocol_version);
	addStat(stats, "download", formatDownloadSize(root.download_bytes));
	if (root.analysis_offline === true) notes.push("Semantic inference runs locally; project source does not leave the machine.");
	if (root.problem) notes.push(String(root.problem));
}

function addSimilarCodeCandidates(
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
): void {
	title.value = "Fallow similar code";
	const candidates = asArray(root.candidates);
	addSimilarCodeRunMetadata(root, stats, notes, candidates.length);
	if (!candidates.length) return;
	sections.push({
		title: "Unverified semantic candidates",
		count: candidates.length,
		color: "warning",
		items: candidates.map((entry, index) => buildCandidateItem(entry, includeAllRaw || index < INLINE_RAW_CANDIDATES)),
	});
}

function addSimilarCodeInspect(
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
): void {
	title.value = "Fallow similar-code inspect";
	addSimilarCodeRunMetadata(root, stats, notes, root.candidate ? 1 : 0);
	if (!root.candidate) return;
	const raw = { candidate: root.candidate, packet: root.packet };
	const item = buildCandidateItem(root.candidate, true, raw);
	item.action = "Review the source-grounded packet and abstain when evidence is incomplete.";
	sections.push({ title: "Inspected semantic candidate", count: 1, color: "accent", items: [item] });
}

function addSimilarCodeReview(
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
): void {
	title.value = "Fallow similar-code review";
	const reviewed = asArray(root.candidates);
	addSimilarCodeRunMetadata(root, stats, notes, reviewed.length);
	if (reviewed.length) {
		sections.push({
			title: "Reviewed semantic candidates",
			count: reviewed.length,
			color: "accent",
			items: reviewed.map((entry, index) => buildReviewedCandidateItem(entry, includeAllRaw || index < INLINE_RAW_CANDIDATES)),
		});
	}
	notes.push("Review outcomes come from a separate verdict document; verify its provenance before acting.");
}

function addSimilarCodeRunMetadata(
	root: Record<string, any>,
	stats: OverviewStat[],
	notes: string[],
	candidateCount: number,
): void {
	const generation = recordOrEmpty(root.generation);
	const completion = recordOrEmpty(root.completion);
	const model = recordOrEmpty(generation.model);
	const provider = recordOrEmpty(generation.provider);
	const cache = recordOrEmpty(completion.cache);
	addStat(stats, "candidates", candidateCount);
	addStat(stats, "completion", completion.status);
	addStat(stats, "threshold", generation.threshold);
	addStat(stats, "model", model.model_id);
	addStat(stats, "model revision", model.revision);
	addStat(stats, "provider inference", numberWithSuffix(completion.provider_inference_ms, "ms"));
	addStat(stats, "cache", cache.status);
	addSimilarCodeTrustNotes(notes, provider, completion);
	appendDiagnostics(notes, root.diagnostics);
}

function addSimilarCodeTrustNotes(
	notes: string[],
	provider: Record<string, any>,
	completion: Record<string, any>,
): void {
	notes.push("Semantic similar-code candidates are advisory and unverified until source-grounded review supplies a separate verdict.");
	if (provider.source_left_machine === false) notes.push("Pinned-model inference ran locally; project source did not leave the machine.");
	addPartialCompletionNote(notes, completion.status);
}

function addPartialCompletionNote(notes: string[], status: unknown): void {
	if (typeof status !== "string") return;
	if (status === "complete") return;
	notes.push(`Similar-code completion is ${status}; an empty or truncated result is not conclusive.`);
}

function buildCandidateItem(entry: unknown, includeRaw: boolean, retainedRaw: unknown = entry): FallowIssueLine {
	const candidate = recordOrEmpty(entry);
	const left = recordOrEmpty(candidate.left);
	const right = recordOrEmpty(candidate.right);
	const item: FallowIssueLine = {
		label: `${locationName(left)} ↔ ${locationName(right)}`,
		path: stringValue(left.path),
		line: numberValue(left.start_line),
		meta: candidateMeta(candidate, right),
		action: candidateAction(candidate),
	};
	retainNormalizedFallowEntry(item, retainedRaw);
	if (includeRaw) item.raw = retainedRaw;
	return item;
}

function candidateMeta(candidate: Record<string, any>, right: Record<string, any>): string | undefined {
	return joinParts([
		numberWithPrefix(candidate.similarity, "similarity "),
		candidate.similarity_band,
		formatRightLocation(right),
		stringValue(candidate.verification_status) || "unverified",
	]);
}

function candidateAction(candidate: Record<string, any>): string {
	return firstAction(candidate) || "Inspect both functions before judging equivalence or refactor safety.";
}

function buildReviewedCandidateItem(entry: unknown, includeRaw: boolean): FallowIssueLine {
	const reviewed = recordOrEmpty(entry);
	const candidate = recordOrEmpty(reviewed.candidate);
	const item = buildCandidateItem(candidate, includeRaw, entry);
	const verdict = recordOrEmpty(reviewed.verdict);
	item.meta = joinParts([item.meta, reviewed.outcome, verdictMatchLabel(reviewed.verdict_match), refactorSafeLabel(verdict)]);
	item.action = stringValue(verdict.rationale) || item.action;
	return item;
}

function verdictMatchLabel(value: unknown): string | undefined {
	const match = stringValue(value);
	return match ? `match ${match}` : undefined;
}

function refactorSafeLabel(verdict: Record<string, any>): string | undefined {
	return verdict.refactor_safe === true ? "refactor-safe verdict" : undefined;
}

function addSimilarCodeErrorGuidance(root: Record<string, any>, title: MutableTitle, notes: string[]): void {
	if (!root.error || !isMissingSimilarCodeModelMessage(root.message)) return;
	title.value = "Fallow similar-code setup required";
	notes.push("Pi Fallow does not download models. Run `/fallow similar-code status`, review the pinned model details, then use the Fallow CLI directly if you choose to install it.");
}

export function isSimilarCodeWarning(root: Record<string, any>): boolean {
	if (root.kind === "similar-code-status") return root.model_ready === false;
	if (!["similar-code", "similar-code-inspect", "similar-code-review"].includes(root.kind)) return false;
	return asRecord(root.completion)?.status === "partial";
}

function appendDiagnostics(notes: string[], value: unknown): void {
	const diagnostics = asArray(value);
	const visible = diagnostics.slice(0, 3).map(formatDiagnostic).filter(isString);
	notes.push(...visible);
	appendOmittedDiagnosticNote(notes, diagnostics.length);
}

function formatDiagnostic(entry: unknown): string | undefined {
	const diagnostic = recordOrEmpty(entry);
	const message = stringValue(diagnostic.message);
	if (!message) return undefined;
	const path = stringValue(diagnostic.path);
	return path ? `${path}: ${message}` : message;
}

function appendOmittedDiagnosticNote(notes: string[], diagnosticCount: number): void {
	if (diagnosticCount <= 3) return;
	notes.push(`${diagnosticCount - 3} additional similar-code diagnostic(s) are in the complete report.`);
}

function firstAction(candidate: Record<string, any>): string | undefined {
	return asArray(candidate.actions).map(readOnlyActionDescription).find(isString);
}

function readOnlyActionDescription(entry: unknown): string | undefined {
	const action = recordOrEmpty(entry);
	if (action.read_only === false) return undefined;
	return stringValue(action.description);
}

function formatRightLocation(location: Record<string, any>): string | undefined {
	const path = stringValue(location.path);
	if (!path) return undefined;
	const line = numberValue(location.start_line);
	return `right ${path}${line === undefined ? "" : `:${line}`}`;
}

function locationName(location: Record<string, any>): string {
	return stringValue(location.name) ?? stringValue(location.path) ?? "unknown function";
}

function formatDownloadSize(value: unknown): string | undefined {
	if (typeof value !== "number") return undefined;
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function numberWithPrefix(value: unknown, prefix: string): string | undefined {
	return typeof value === "number" ? `${prefix}${value.toFixed(3)}` : undefined;
}

function numberWithSuffix(value: unknown, suffix: string): string | undefined {
	return typeof value === "number" ? `${value}${suffix}` : undefined;
}

function addStat(stats: OverviewStat[], label: string, value: unknown): void {
	if (typeof value === "string" || typeof value === "number") stats.push({ label, value });
}

function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function recordOrEmpty(value: unknown): Record<string, any> {
	return asRecord(value) || EMPTY_RECORD;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function joinParts(values: unknown[]): string | undefined {
	const parts = values.filter((value) => value !== undefined && value !== null && value !== "").map(String);
	return parts.length ? parts.join(" · ") : undefined;
}
