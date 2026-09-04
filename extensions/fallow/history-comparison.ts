import { asRecord } from "./data";
import {
	allNormalizedFallowEntries,
	getNormalizedFallowReport,
	retainNormalizedFallowEntry,
	type NormalizedFallowEntry,
} from "./normalized-report";
import type { FallowHistoryEntry } from "./history";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection } from "./types";

export interface FallowHistoryComparisonInput {
	prior: FallowHistoryEntry;
	current: FallowHistoryEntry;
	priorOverview: FallowOverview;
	currentOverview: FallowOverview;
}

interface ClassifiedComparison {
	newEntries: NormalizedFallowEntry[];
	unchangedEntries: NormalizedFallowEntry[];
	resolvedEntries: NormalizedFallowEntry[];
	unavailableEntries: Array<{ entry: NormalizedFallowEntry; side: "prior" | "current" }>;
}

export function buildFallowHistoryComparison(input: FallowHistoryComparisonInput): FallowOverview {
	const compatibilityReason = comparisonCompatibilityReason(input.prior, input.current);
	const priorEntries = findingEntries(input.priorOverview);
	const currentEntries = findingEntries(input.currentOverview);
	const classified = compatibilityReason
		? unavailableComparison(priorEntries, currentEntries)
		: classifyComparableEntries(priorEntries, currentEntries);
	const sections = comparisonSections(classified);
	const stats = comparisonStats(classified);
	const notes = comparisonNotes(input, compatibilityReason, classified.unavailableEntries.length);
	const overview: FallowOverview = {
		title: `Fallow comparison ${input.prior.id} → ${input.current.id}`,
		status: comparisonStatus(classified, compatibilityReason),
		stats,
		sections,
		notes,
	};
	getNormalizedFallowReport(overview);
	return overview;
}

function comparisonCompatibilityReason(prior: FallowHistoryEntry, current: FallowHistoryEntry): string | undefined {
	return completenessCompatibility(prior, current) ?? reportCompatibilityReason(prior, current);
}

function reportCompatibilityReason(prior: FallowHistoryEntry, current: FallowHistoryEntry): string | undefined {
	return versionCompatibility(prior.schemaVersion, current.schemaVersion, "schema")
		?? runtimeCompatibilityReason(prior, current);
}

function runtimeCompatibilityReason(prior: FallowHistoryEntry, current: FallowHistoryEntry): string | undefined {
	return versionCompatibility(prior.fallowVersion, current.fallowVersion, "Fallow")
		?? identityCompatibilityReason(prior, current);
}

function identityCompatibilityReason(prior: FallowHistoryEntry, current: FallowHistoryEntry): string | undefined {
	return reportKindCompatibility(prior.kind, current.kind)
		?? comparisonScopeCompatibility(prior.comparisonKey, current.comparisonKey);
}

function completenessCompatibility(prior: FallowHistoryEntry, current: FallowHistoryEntry): string | undefined {
	return prior.complete && current.complete ? undefined : "one or both reports are incomplete";
}

function versionCompatibility(prior: string | undefined, current: string | undefined, label: string): string | undefined {
	if (!prior || !current) return `${label} version metadata is missing`;
	return prior === current ? undefined : `${label} versions differ`;
}

function reportKindCompatibility(prior: string | undefined, current: string | undefined): string | undefined {
	if (!prior || !current) return "report kind metadata is missing";
	return prior === current ? undefined : "report kinds differ";
}

function comparisonScopeCompatibility(prior: string | undefined, current: string | undefined): string | undefined {
	if (!prior || !current) return "command scope metadata is missing";
	return prior === current ? undefined : "command scopes differ";
}

function findingEntries(overview: FallowOverview): NormalizedFallowEntry[] {
	return allNormalizedFallowEntries(getNormalizedFallowReport(overview)).filter((entry) => entry.role === "finding");
}

function unavailableComparison(
	priorEntries: NormalizedFallowEntry[],
	currentEntries: NormalizedFallowEntry[],
): ClassifiedComparison {
	return {
		newEntries: [],
		unchangedEntries: [],
		resolvedEntries: [],
		unavailableEntries: [
			...currentEntries.map((entry) => ({ entry, side: "current" as const })),
			...priorEntries.map((entry) => ({ entry, side: "prior" as const })),
		],
	};
}

function classifyComparableEntries(
	priorEntries: NormalizedFallowEntry[],
	currentEntries: NormalizedFallowEntry[],
): ClassifiedComparison {
	const priorGroups = groupByIdentity(priorEntries);
	const currentGroups = groupByIdentity(currentEntries);
	const classified: ClassifiedComparison = { newEntries: [], unchangedEntries: [], resolvedEntries: [], unavailableEntries: [] };
	classifyEntries(classified, currentEntries, "current", priorGroups, currentGroups);
	classifyEntries(classified, priorEntries, "prior", priorGroups, currentGroups);
	return classified;
}

type ComparisonSide = "prior" | "current";
type ComparisonCategory = "newEntries" | "unchangedEntries" | "resolvedEntries" | "skip";

function classifyEntries(
	classified: ClassifiedComparison,
	entries: NormalizedFallowEntry[],
	side: ComparisonSide,
	priorGroups: Map<string, NormalizedFallowEntry[]>,
	currentGroups: Map<string, NormalizedFallowEntry[]>,
): void {
	for (const entry of entries) classifyEntry(classified, entry, side, priorGroups, currentGroups);
}

function classifyEntry(
	classified: ClassifiedComparison,
	entry: NormalizedFallowEntry,
	side: ComparisonSide,
	priorGroups: Map<string, NormalizedFallowEntry[]>,
	currentGroups: Map<string, NormalizedFallowEntry[]>,
): void {
	const identity = comparisonIdentity(entry);
	if (!identity || identityIsAmbiguous(identity, priorGroups, currentGroups)) {
		classified.unavailableEntries.push({ entry, side });
		return;
	}
	appendComparableEntry(classified, entry, comparisonCategory(identity, side, priorGroups, currentGroups));
}

function comparisonCategory(
	identity: string,
	side: ComparisonSide,
	priorGroups: Map<string, NormalizedFallowEntry[]>,
	currentGroups: Map<string, NormalizedFallowEntry[]>,
): ComparisonCategory {
	if (side === "current") return priorGroups.has(identity) ? "unchangedEntries" : "newEntries";
	return currentGroups.has(identity) ? "skip" : "resolvedEntries";
}

function appendComparableEntry(
	classified: ClassifiedComparison,
	entry: NormalizedFallowEntry,
	category: ComparisonCategory,
): void {
	if (category !== "skip") classified[category].push(entry);
}

function groupByIdentity(entries: NormalizedFallowEntry[]): Map<string, NormalizedFallowEntry[]> {
	const groups = new Map<string, NormalizedFallowEntry[]>();
	for (const entry of entries) {
		const identity = comparisonIdentity(entry);
		if (!identity) continue;
		const group = groups.get(identity) ?? [];
		group.push(entry);
		groups.set(identity, group);
	}
	return groups;
}

function comparisonIdentity(entry: NormalizedFallowEntry): string | undefined {
	const type = normalizeIdentityPart(entry.type);
	return stableIdIdentity(type, normalizeIdentityPart(entry.id)) ?? fallbackIdentity(entry, type);
}

function stableIdIdentity(type: string | undefined, id: string | undefined): string | undefined {
	return type && id ? ["id", type, id].join("\u0000") : undefined;
}

function fallbackIdentity(entry: NormalizedFallowEntry, type: string | undefined): string | undefined {
	if (!type) return undefined;
	return subjectIdentity(entry, type, normalizeIdentityPart(entry.subject));
}

function subjectIdentity(
	entry: NormalizedFallowEntry,
	type: string,
	subject: string | undefined,
): string | undefined {
	if (!subject) return undefined;
	const path = normalizeIdentityPart(entry.path);
	return [path ? "path" : "subject", type, path ?? "", subject].join("\u0000");
}

function normalizeIdentityPart(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

function identityIsAmbiguous(
	identity: string,
	priorGroups: Map<string, NormalizedFallowEntry[]>,
	currentGroups: Map<string, NormalizedFallowEntry[]>,
): boolean {
	return Math.max(identityCount(priorGroups, identity), identityCount(currentGroups, identity)) > 1;
}

function identityCount(groups: Map<string, NormalizedFallowEntry[]>, identity: string): number {
	const group = groups.get(identity);
	return group ? group.length : 0;
}

function comparisonSections(classified: ClassifiedComparison): FallowOverviewSection[] {
	return [
		entrySection("New findings", classified.newEntries, "warning"),
		entrySection("Unchanged findings", classified.unchangedEntries, "accent"),
		entrySection("Resolved findings", classified.resolvedEntries, "success", "context"),
		unavailableSection(classified.unavailableEntries),
	].filter((section): section is FallowOverviewSection => Boolean(section));
}

function entrySection(
	title: string,
	entries: NormalizedFallowEntry[],
	color: FallowOverviewSection["color"],
	role?: "context",
): FallowOverviewSection | undefined {
	if (!entries.length) return undefined;
	return { title, count: entries.length, color, role, items: entries.map(toIssueLine) };
}

function unavailableSection(
	entries: ClassifiedComparison["unavailableEntries"],
): FallowOverviewSection | undefined {
	if (!entries.length) return undefined;
	return {
		title: "Unavailable to compare",
		count: entries.length,
		color: "muted",
		role: "context",
		items: entries.map(({ entry, side }) => toIssueLine(entry, `${side} report`)),
	};
}

function toIssueLine(entry: NormalizedFallowEntry, detailPrefix?: string): FallowIssueLine {
	const item: FallowIssueLine = {
		label: entry.subject,
		path: entry.path,
		line: entry.line,
		meta: [detailPrefix, entry.details].filter(Boolean).join(" · ") || undefined,
		action: entry.action,
		severity: entry.severity,
		raw: entry.raw,
	};
	retainNormalizedFallowEntry(item, {
		...asRecord(entry.raw),
		kind: entry.type,
		id: entry.id,
		severity: entry.severity,
		evidence: entry.evidence,
		suggested_action: entry.action,
	});
	return item;
}

function comparisonStatus(
	classified: ClassifiedComparison,
	compatibilityReason: string | undefined,
): FallowOverview["status"] {
	if (compatibilityReason) return "warning";
	return classifiedComparisonStatus(classified);
}

function classifiedComparisonStatus(classified: ClassifiedComparison): FallowOverview["status"] {
	if (classified.unavailableEntries.length) return "warning";
	return classified.newEntries.length || classified.unchangedEntries.length ? "warning" : "success";
}

function comparisonStats(classified: ClassifiedComparison): Array<{ label: string; value: number }> {
	return [
		{ label: "new", value: classified.newEntries.length },
		{ label: "unchanged", value: classified.unchangedEntries.length },
		{ label: "resolved", value: classified.resolvedEntries.length },
		{ label: "unavailable", value: classified.unavailableEntries.length },
	];
}

function comparisonNotes(
	input: FallowHistoryComparisonInput,
	compatibilityReason: string | undefined,
	unavailableCount: number,
): string[] {
	const notes = [
		"Resolved and unavailable entries are context only and are never current actionable findings.",
		"Fallback identities ignore line numbers, but retain type, path, and subject; path changes are not guessed as renames.",
	];
	if (compatibilityReason) notes.push(`Comparison unavailable: ${compatibilityReason}.`);
	else if (unavailableCount) notes.push(`${unavailableCount} entry occurrence(s) had missing or duplicate identities and were not matched.`);
	if (input.prior.gitHead !== input.current.gitHead) notes.push("Git HEAD changed between these runs.");
	return notes;
}
