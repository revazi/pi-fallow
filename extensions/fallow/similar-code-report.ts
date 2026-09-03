import { asRecord } from "./data";
import { retainNormalizedFallowEntry } from "./normalized-report";
import { isMissingSimilarCodeModelMessage } from "./similar-code";
import {
	addSimilarCodeRunMetadata,
	addSimilarCodeStat as addStat,
	asSimilarCodeArray as asArray,
	isSimilarCodeString as isString,
	joinSimilarCodeParts as joinParts,
	similarCodeNumber as numberValue,
	similarCodeRecord as recordOrEmpty,
	similarCodeString as stringValue,
	type SimilarCodeOverviewStat as OverviewStat,
} from "./similar-code-metadata";
import type { FallowIssueLine, FallowOverviewSection } from "./types";

const INLINE_RAW_CANDIDATES = 5;
type MutableTitle = { value: string };
type SimilarCodeOverviewHandler = (
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
) => void;

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
	addStat(stats, "license", root.license);
	addStat(stats, "integrity verified", typeof root.integrity_verified === "boolean" ? String(root.integrity_verified) : undefined);
	addStat(stats, "download", formatDownloadSize(root.download_bytes));
	addStat(stats, "cache directory", root.cache_dir);
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
	const packet = recordOrEmpty(root.packet);
	const raw = { candidate: root.candidate, packet: root.packet };
	const item = buildCandidateItem(root.candidate, true, raw, packet.availability);
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
	const review = recordOrEmpty(root.review);
	addStat(stats, "candidate input", review.candidates_sha256);
	addStat(stats, "verdict input", review.verdicts_sha256);
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

function buildCandidateItem(
	entry: unknown,
	includeRaw: boolean,
	retainedRaw: unknown = entry,
	enrichmentOverride?: unknown,
): FallowIssueLine {
	const candidate = recordOrEmpty(entry);
	const left = recordOrEmpty(candidate.left);
	const right = recordOrEmpty(candidate.right);
	const item: FallowIssueLine = {
		label: `${locationName(left)} ↔ ${locationName(right)}`,
		path: stringValue(left.path),
		line: numberValue(left.start_line),
		meta: candidateMeta(candidate, right, enrichmentOverride ?? candidate.enrichment),
		action: candidateAction(candidate),
	};
	retainNormalizedFallowEntry(item, retainedRaw);
	if (includeRaw) item.raw = retainedRaw;
	return item;
}

function candidateMeta(candidate: Record<string, any>, right: Record<string, any>, enrichment: unknown): string | undefined {
	return joinParts([
		stringValue(candidate.candidate_id) ? `id ${candidate.candidate_id}` : undefined,
		numberWithPrefix(candidate.similarity, "similarity "),
		candidate.similarity_band,
		formatRightLocation(right),
		formatEnrichmentAvailability(enrichment),
		stringValue(candidate.verification_status) || "unverified",
	]);
}

function formatEnrichmentAvailability(value: unknown): string | undefined {
	const enrichment = asRecord(value);
	if (!enrichment || !Object.keys(enrichment).length) return undefined;
	const unavailable = Object.entries(enrichment)
		.filter(([, state]) => state !== "available")
		.map(([name, state]) => `${name.replaceAll("_", " ")} ${String(state)}`);
	return unavailable.length ? `enrichment ${unavailable.join(", ")}` : "enrichment available";
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

function firstAction(candidate: Record<string, any>): string | undefined {
	return asArray(candidate.actions).map(readOnlyActionDescription).find(isString);
}

function readOnlyActionDescription(entry: unknown): string | undefined {
	const action = recordOrEmpty(entry);
	if (action.read_only !== true) return undefined;
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
