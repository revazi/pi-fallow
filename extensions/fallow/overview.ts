import { asRecord } from "./data";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection } from "./types";

function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function fmt(value: unknown): string {
	if (value == null) return "";
	if (typeof value !== "number") return String(value);
	return formatNumericValue(value);
}

function formatNumericValue(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(1);
}

function issueLocation(issue: Record<string, any>): { path?: string; line?: number } {
	const importedFrom = asArray(issue.imported_from)[0] as Record<string, any> | undefined;
	return {
		path: firstDefinedValue([issue.path, issue.file, importedFrom?.path]),
		line: firstDefinedValue([issue.line, issue.start_line, importedFrom?.line]),
	};
}

function firstDefinedValue<T>(values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function primaryAction(issue: Record<string, any>): string | undefined {
	const actions = asArray(issue.actions);
	const action = findPrimaryAction(actions);
	return action?.description ?? action?.type;
}

function findPrimaryAction(actions: unknown[]): Record<string, any> | undefined {
	return actions.find((entry) => isActionVisible(entry)) ?? actions[0];
}

function isActionVisible(entry: unknown): boolean {
	return entry?.type && entry.type !== "suppress-line" && entry.type !== "suppress-file";
}

function issueLabel(kind: string, issue: Record<string, any>): string {
	for (const key of ["export_name", "package_name", "name", "rule_id"] as const) {
		const value = issue[key];
		if (value) return `${kind}: ${value}`;
	}
	return kind;
}

function issueMeta(issue: Record<string, any>): string | undefined {
	const parts: string[] = [];
	const entries: Array<[string, unknown]> = [
		["severity", issue.severity],
		["cyclomatic", issue.cyclomatic],
		["cognitive", issue.cognitive],
		["crap", issue.crap],
		["line_count", issue.line_count],
		["token_count", issue.token_count],
	];
	const formatters: Record<string, (value: unknown) => string> = {
		severity: (value) => String(value),
		cyclomatic: (value) => `cyc ${value}`,
		cognitive: (value) => `cog ${value}`,
		crap: (value) => `CRAP ${fmt(value)}`,
		line_count: (value) => `${value} lines`,
		token_count: (value) => `${value} tokens`,
	};
	for (const [key, value] of entries) {
		if (value === undefined) continue;
		const format = formatters[key];
		parts.push(format(value));
	}
	return parts.length ? parts.join(" · ") : undefined;
}


function makeIssue(kind: string, issue: Record<string, any>): FallowIssueLine {
	const location = issueLocation(issue);
	return {
		label: issueLabel(kind, issue),
		path: location.path,
		line: location.line,
		meta: issueMeta(issue),
		action: primaryAction(issue),
		severity: issue.severity,
		raw: issue,
	};
}

function sectionFromArray(title: string, array: unknown, kind: string, limit = 5): FallowOverviewSection | undefined {
	const items = asArray(array);
	if (!items.length) return undefined;
	return {
		title,
		count: items.length,
		color: "warning",
		items: items.slice(0, limit).map((entry) => makeIssue(kind, asRecord(entry) ?? { value: entry })),
	};
}

function buildDeadCodeSections(data: Record<string, any>): FallowOverviewSection[] {
	const specs: Array<[string, string, string]> = [
		["Unused files", "unused_files", "unused-file"],
		["Unused exports", "unused_exports", "unused-export"],
		["Unused dependencies", "unused_dependencies", "unused-dependency"],
		["Unlisted dependencies", "unlisted_dependencies", "unlisted-dependency"],
		["Unused types", "unused_types", "unused-type"],
		["Unused class members", "unused_class_members", "unused-class-member"],
		["Unresolved imports", "unresolved_imports", "unresolved-import"],
		["Duplicate exports", "duplicate_exports", "duplicate-export"],
		["Circular dependencies", "circular_dependencies", "circular-dependency"],
		["Boundary violations", "boundary_violations", "boundary-violation"],
		["Stale suppressions", "stale_suppressions", "stale-suppression"],
	];
	return specs.map(([title, key, kind]) => sectionFromArray(title, data[key], kind)).filter(Boolean) as FallowOverviewSection[];
}

function buildHealthSections(data: Record<string, any>): FallowOverviewSection[] {
	const sections: FallowOverviewSection[] = [];
	appendHealthSection(sections, "Complexity findings", "error", asArray(data.findings), 8, buildComplexityIssue);
	appendHealthSection(sections, "Worst file scores", "accent", asArray(data.file_scores), 5, buildFileScoreIssue);
	appendHealthSection(sections, "Refactoring targets", "warning", asArray(data.targets), 5, buildRefactoringTargetIssue);
	appendHealthSection(sections, "Hotspots", "warning", asArray(data.hotspots), 5, buildHotspotIssue);
	return sections;
}

function appendHealthSection(
	sections: FallowOverviewSection[],
	title: string,
	color: "error" | "accent" | "warning",
	entries: unknown[],
	limit: number,
	buildItem: (entry: unknown) => FallowIssueLine,
): void {
	if (!entries.length) return;
	sections.push({ title, count: entries.length, color, items: entries.slice(0, limit).map(buildItem) });
}

function buildComplexityIssue(entry: unknown): FallowIssueLine {
	return makeIssue("complexity", asRecord(entry) ?? {});
}

function buildFileScoreIssue(entry: unknown): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return {
		label: `score ${fmt(issue.maintainability_index)}`,
		path: issue.path,
		meta: `${issue.lines ?? "?"} LOC · dead ${fmt((issue.dead_code_ratio ?? 0) * 100)}% · CRAP max ${fmt(issue.crap_max)}`,
		raw: issue,
	};
}

function buildRefactoringTargetIssue(entry: unknown): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return {
		label: issue.category ?? "target",
		path: issue.path,
		meta: `priority ${fmt(issue.priority)} · ${issue.effort ?? "unknown effort"}`,
		action: issue.recommendation,
		raw: issue,
	};
}

function buildHotspotIssue(entry: unknown): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return {
		label: `hotspot ${fmt(issue.score)}`,
		path: issue.path,
		meta: `${buildHotspotCommitSummary(issue)} commits · churn ${buildHotspotChurn(issue)} · ${buildHotspotTrend(issue)}`,
		raw: issue,
	};
}

function buildHotspotCommitSummary(issue: Record<string, any>): string {
	return issue.commits ? String(issue.commits) : "?";
}

function buildHotspotChurn(issue: Record<string, any>): number {
	return (issue.lines_added ?? 0) + (issue.lines_deleted ?? 0);
}

function buildHotspotTrend(issue: Record<string, any>): string {
	return issue.trend ?? "";
}

function buildDupesSections(data: Record<string, any>): FallowOverviewSection[] {
	const groups = asArray(data.clone_groups);
	if (!groups.length) return [];
	return [{
		title: "Clone groups",
		count: groups.length,
		color: "warning",
		items: groups.slice(0, 6).map((entry, index) => makeCloneGroupIssue(entry, index)),
	}];
}

function makeCloneGroupIssue(entry: unknown, index: number): FallowIssueLine {
	const group = asRecord(entry) ?? {};
	const instances = asArray(group.instances);
	const [first, second] = getCloneInstances(instances);
	return {
		label: `clone #${index + 1}`,
		path: first.file,
		line: first.start_line,
		meta: formatCloneMeta(group, instances.length),
		action: getCloneAction(second, group),
		raw: group,
	};
}

function getCloneInstances(instances: any[]): [Record<string, any>, Record<string, any>] {
	return [asRecord(instances[0]) ?? {}, asRecord(instances[1]) ?? {}];
}

function formatCloneMeta(group: Record<string, any>, instanceCount: number): string {
	return `${group.line_count ?? "?"} lines · ${group.token_count ?? "?"} tokens · ${instanceCount} instances`;
}

function getCloneAction(second: Record<string, any>, group: Record<string, any>): string | undefined {
	return second.file ? `also at ${second.file}:${second.start_line}` : primaryAction(group);
}
function addSummaryStats(stats: Array<{ label: string; value: string | number }>, summary: Record<string, any> | undefined, keys: string[]): void {
	if (!summary) return;
	for (const key of keys) {
		if (summary[key] !== undefined) stats.push({ label: key.replaceAll("_", " "), value: fmt(summary[key]) });
	}
}

function addRootStats(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>): void {
	const rootSummary = asRecord(root.summary);
	addIfDefinedStat(stats, "verdict", root.verdict);
	addIfDefinedStat(stats, "issues", root.total_issues);
	addIfDefinedStat(stats, "elapsed", root.elapsed_ms !== undefined ? `${root.elapsed_ms}ms` : undefined);
	addIfDefinedHealthScore(stats, root.health_score);
	addSummaryStats(stats, rootSummary, ["total_issues", "files_analyzed", "functions_above_threshold", "severity_critical_count", "clone_groups", "duplicated_lines", "average_maintainability"]);
}

function addIfDefinedStat(stats: Array<{ label: string; value: string | number }>, label: string, value: string | number | undefined): void {
	if (value === undefined) return;
	stats.push({ label, value });
}

function addIfDefinedHealthScore(
	stats: Array<{ label: string; value: string | number }>,
	healthScore: Record<string, any> | undefined,
): void {
	if (!healthScore) return;
	const score = `${fmt(healthScore.score)} ${healthScore.grade ?? ""}`.trim();
	stats.push({ label: "score", value: score });
}

function addPrimarySections(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }): void {
	const specs = buildPrimarySectionSpecs();
	for (const spec of specs) {
		if (!spec.isPresent(root)) continue;
		processPrimarySection(root, sections, title, spec);
	}
}

function buildPrimarySectionSpecs(): Array<{
	isPresent: (root: Record<string, any>) => boolean;
	forceTitle: string;
	sectionsFor: (data: Record<string, any> | undefined) => FallowOverviewSection[];
	selector: (root: Record<string, any>) => Record<string, any> | undefined;
	prefix: string;
}> {
	return [
		{
			isPresent: (entry) => !!(entry.check || entry.dead_code),
			forceTitle: "Fallow full analysis",
			sectionsFor: buildDeadCodeSections,
			selector: (entry) => asRecord(entry.check ?? entry.dead_code),
			prefix: "Dead code",
		},
		{
			isPresent: (entry) => !!(entry.dupes || entry.duplication),
			forceTitle: "Fallow duplication",
			sectionsFor: buildDupesSections,
			selector: (entry) => asRecord(entry.dupes ?? entry.duplication),
			prefix: "Dupes",
		},
		{
			isPresent: (entry) => !!entry.health,
			forceTitle: "Fallow health",
			sectionsFor: buildHealthSections,
			selector: (entry) => asRecord(entry.health),
			prefix: "Health",
		},
	];
}

function processPrimarySection(
	root: Record<string, any>,
	sections: FallowOverviewSection[],
	title: { value: string },
	spec: {
		isPresent: (root: Record<string, any>) => boolean;
		forceTitle: string;
		sectionsFor: (data: Record<string, any> | undefined) => FallowOverviewSection[];
		selector: (root: Record<string, any>) => Record<string, any> | undefined;
		prefix: string;
	},
): void {
	if (title.value === "Fallow") title.value = spec.forceTitle;
	const sectionData = spec.selector(root);
	if (!sectionData) return;
	for (const section of spec.sectionsFor(sectionData)) {
		sections.push({ ...section, title: `${spec.prefix} · ${section.title}` });
	}
}

function addFallbackSections(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }): void {
	if (sections.length) return;
	const deadSections = buildDeadCodeSections(root);
	const healthSections = buildHealthSections(root);
	const dupeSections = buildDupesSections(root);
	appendFallbackSections(sections, deadSections, healthSections, dupeSections);
	updateFallbackTitle(healthSections, dupeSections, deadSections, title);
}

function appendFallbackSections(
	sections: FallowOverviewSection[],
	deadSections: FallowOverviewSection[],
	healthSections: FallowOverviewSection[],
	dupeSections: FallowOverviewSection[],
): void {
	sections.push(...deadSections, ...healthSections, ...dupeSections);
}

function updateFallbackTitle(
	healthSections: FallowOverviewSection[],
	dupeSections: FallowOverviewSection[],
	deadSections: FallowOverviewSection[],
	title: { value: string },
): void {
	if (healthSections.length) title.value = "Fallow health";
	else if (dupeSections.length) title.value = "Fallow duplication";
	else if (deadSections.length) title.value = "Fallow dead code";
}

function addFeatureFlags(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }): void {
	if (!root.feature_flags) return;
	title.value = "Fallow feature flags";
	const flags = asArray(root.feature_flags);
	sections.push({
		title: "Feature flags",
		count: flags.length,
		color: "accent",
		items: flags.slice(0, 8).map((entry) => makeIssue("flag", asRecord(entry) ?? {})),
	});
}

function addDefaultNotes(root: Record<string, any>, sections: FallowOverviewSection[], stats: Array<{ label: string; value: string | number }>, notes: string[]): void {
	addIfDefined(stats, "entry points", root.entry_point_count);
	addIfDefined(stats, "files", root.file_count);
	appendFallbackNotes(root, sections, stats, notes);
}

function appendFallbackNotes(
	root: Record<string, any>,
	sections: FallowOverviewSection[],
	stats: Array<{ label: string; value: string | number }>,
	notes: string[],
): void {
	if (sections.length) return;
	if (root.message) notes.push(String(root.message));
	if (stats.length <= 1) notes.push("No issues found in the selected report sections.");
}

function addIfDefined(stats: Array<{ label: string; value: string | number }>, label: string, value: string | number | undefined): void {
	if (value === undefined) return;
	stats.push({ label, value });
}
export function buildFallowOverview(data: unknown, exitCode = 0): FallowOverview | undefined {
	const root = asRecord(data);
	if (!root) return undefined;
	const stats: Array<{ label: string; value: string | number }> = [];
	const sections: FallowOverviewSection[] = [];
	const notes: string[] = [];
	const title = { value: "Fallow" };

	addRootStats(root, stats);
	addPrimarySections(root, sections, title);
	addFallbackSections(root, sections, title);
	addFeatureFlags(root, sections, title);
	addDefaultNotes(root, sections, stats, notes);
	if (exitCode === 1) notes.push("Fallow exit 1 means findings/gate failure, not a crashed command.");

	return {
		title: title.value,
		status: buildFallowStatus(root, sections, exitCode),
		stats,
		sections,
		notes,
	};
}

function buildFallowStatus(root: Record<string, any>, sections: FallowOverviewSection[], exitCode: number): "success" | "warning" | "error" {
	if (isFallowErrorState(root, exitCode)) return "error";
	return isFallowWarningState(sections, exitCode) ? "warning" : "success";
}

function isFallowErrorState(root: Record<string, any>, exitCode: number): boolean {
	return !!root.error || exitCode >= 2;
}

function isFallowWarningState(sections: FallowOverviewSection[], exitCode: number): boolean {
	return sections.length > 0 || exitCode === 1;
}
