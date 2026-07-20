import { asRecord } from "./data";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection } from "./types";

// Preserve the existing inline raw-detail footprint while normalized rows remain unbounded.
const INLINE_RAW_DEFAULT = 5;
const INLINE_RAW_EXTENDED = 8;
const INLINE_RAW_CLONES = 6;

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
		if (value) return String(value);
	}
	return kind;
}

function issueMeta(issue: Record<string, any>): string | undefined {
	const parts: string[] = [];
	const entries: Array<[string, unknown]> = [
		["cyclomatic", issue.cyclomatic],
		["cognitive", issue.cognitive],
		["crap", issue.crap],
		["line_count", issue.line_count],
		["token_count", issue.token_count],
	];
	const formatters: Record<string, (value: unknown) => string> = {
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


function makeIssue(kind: string, issue: Record<string, any>, includeRaw = true): FallowIssueLine {
	const location = issueLocation(issue);
	return withOptionalRaw({
		label: issueLabel(kind, issue),
		path: location.path,
		line: location.line,
		meta: issueMeta(issue),
		action: primaryAction(issue),
		severity: issue.severity,
	}, issue, includeRaw);
}

function withOptionalRaw(item: FallowIssueLine, raw: unknown, includeRaw: boolean): FallowIssueLine {
	if (includeRaw) item.raw = raw;
	return item;
}

function valueOr<T>(value: T | null | undefined, fallback: T): T {
	return value ?? fallback;
}

function sectionFromArray(title: string, array: unknown, kind: string, includeAllRaw = false): FallowOverviewSection | undefined {
	const items = asArray(array);
	if (!items.length) return undefined;
	return {
		title,
		count: items.length,
		color: "warning",
		items: items.map((entry, index) => makeIssue(kind, asRecord(entry) ?? { value: entry }, includeAllRaw || index < INLINE_RAW_DEFAULT)),
	};
}

function buildDeadCodeSections(data: Record<string, any>, includeAllRaw = false): FallowOverviewSection[] {
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
	return specs.map(([title, key, kind]) => sectionFromArray(title, data[key], kind, includeAllRaw)).filter(Boolean) as FallowOverviewSection[];
}

function buildHealthSections(data: Record<string, any>, includeAllRaw = false): FallowOverviewSection[] {
	const sections: FallowOverviewSection[] = [];
	appendHealthSection(sections, "Complexity findings", "error", "finding", asArray(data.findings), INLINE_RAW_EXTENDED, includeAllRaw, buildComplexityIssue);
	appendHealthSection(sections, "Worst file scores", "accent", "context", asArray(data.file_scores), INLINE_RAW_DEFAULT, includeAllRaw, buildFileScoreIssue);
	appendHealthSection(sections, "Refactoring targets", "warning", "finding", asArray(data.targets), INLINE_RAW_DEFAULT, includeAllRaw, buildRefactoringTargetIssue);
	appendHealthSection(sections, "Hotspots", "muted", "context", asArray(data.hotspots), INLINE_RAW_DEFAULT, includeAllRaw, buildHotspotIssue);
	return sections;
}

function appendHealthSection(
	sections: FallowOverviewSection[],
	title: string,
	color: "error" | "accent" | "warning" | "muted",
	role: "finding" | "context",
	entries: unknown[],
	rawLimit: number,
	includeAllRaw: boolean,
	buildItem: (entry: unknown, includeRaw: boolean) => FallowIssueLine,
): void {
	if (!entries.length) return;
	sections.push({ title, count: entries.length, color, role, items: entries.map((entry, index) => buildItem(entry, includeAllRaw || index < rawLimit)) });
}

function buildComplexityIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	return makeIssue("complexity", asRecord(entry) ?? {}, includeRaw);
}

function buildFileScoreIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return withOptionalRaw({
		label: `score ${fmt(issue.maintainability_index)}`,
		path: issue.path,
		meta: `${valueOr(issue.lines, "?")} LOC · dead ${fmt(valueOr(issue.dead_code_ratio, 0) * 100)}% · CRAP max ${fmt(issue.crap_max)}`,
	}, issue, includeRaw);
}

function buildRefactoringTargetIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return withOptionalRaw({
		label: valueOr(issue.category, "target"),
		path: issue.path,
		meta: `priority ${fmt(issue.priority)} · ${valueOr(issue.effort, "unknown effort")}`,
		action: issue.recommendation,
	}, issue, includeRaw);
}

function buildHotspotIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	return withOptionalRaw({
		label: `hotspot ${fmt(issue.score)}`,
		path: issue.path,
		meta: `${buildHotspotCommitSummary(issue)} commits · churn ${buildHotspotChurn(issue)} · ${buildHotspotTrend(issue)}`,
		action: primaryAction(issue),
	}, issue, includeRaw);
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

function buildDupesSections(data: Record<string, any>, includeAllRaw = false): FallowOverviewSection[] {
	const groups = asArray(data.clone_groups);
	if (!groups.length) return [];
	return [{
		title: "Clone groups",
		count: groups.length,
		color: "warning",
		items: groups.map((entry, index) => makeCloneGroupIssue(entry, index, includeAllRaw || index < INLINE_RAW_CLONES)),
	}];
}

function makeCloneGroupIssue(entry: unknown, index: number, includeRaw = true): FallowIssueLine {
	const group = asRecord(entry) ?? {};
	const instances = asArray(group.instances);
	const [first, second] = getCloneInstances(instances);
	return withOptionalRaw({
		label: `clone #${index + 1}`,
		path: first.file,
		line: first.start_line,
		meta: formatCloneMeta(group, instances.length),
		action: getCloneAction(second, group),
	}, group, includeRaw);
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

function addPrimarySections(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }, includeAllRaw: boolean): void {
	const specs = buildPrimarySectionSpecs();
	for (const spec of specs) {
		if (!spec.isPresent(root)) continue;
		processPrimarySection(root, sections, title, spec, includeAllRaw);
	}
}

function buildPrimarySectionSpecs(): Array<{
	isPresent: (root: Record<string, any>) => boolean;
	forceTitle: string;
	sectionsFor: (data: Record<string, any> | undefined, includeAllRaw?: boolean) => FallowOverviewSection[];
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
		sectionsFor: (data: Record<string, any> | undefined, includeAllRaw?: boolean) => FallowOverviewSection[];
		selector: (root: Record<string, any>) => Record<string, any> | undefined;
		prefix: string;
	},
	includeAllRaw: boolean,
): void {
	if (title.value === "Fallow") title.value = spec.forceTitle;
	const sectionData = spec.selector(root);
	if (!sectionData) return;
	for (const section of spec.sectionsFor(sectionData, includeAllRaw)) {
		sections.push({ ...section, title: `${spec.prefix} · ${section.title}` });
	}
}

function addFallbackSections(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }, includeAllRaw: boolean): void {
	if (sections.length) return;
	const deadSections = buildDeadCodeSections(root, includeAllRaw);
	const healthSections = buildHealthSections(root, includeAllRaw);
	const dupeSections = buildDupesSections(root, includeAllRaw);
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

function addFeatureFlags(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }, includeAllRaw: boolean): void {
	if (!root.feature_flags) return;
	title.value = "Fallow feature flags";
	const flags = asArray(root.feature_flags);
	sections.push({
		title: "Feature flags",
		count: flags.length,
		color: "accent",
		role: "context",
		items: flags.map((entry, index) => makeIssue("flag", asRecord(entry) ?? {}, includeAllRaw || index < INLINE_RAW_EXTENDED)),
	});
}

function addSecurity(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }, includeAllRaw: boolean): void {
	if (!root.security_findings) return;
	title.value = "Fallow security";
	const findings = asArray(root.security_findings);
	if (!findings.length) return;
	sections.push({
		title: "Security candidates",
		count: findings.length,
		color: "warning",
		items: findings.map((entry, index) => buildSecurityIssue(entry, includeAllRaw || index < INLINE_RAW_EXTENDED)),
	});
}

function buildSecurityIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	const labelParts = [valueOr(issue.kind, "security"), issue.category].filter(Boolean);
	return withOptionalRaw({
		label: labelParts.join(": "),
		path: issue.path,
		line: issue.line,
		meta: formatSecurityMeta(issue),
		action: firstStringValue([primaryAction(issue), issue.evidence]),
		severity: issue.severity,
	}, issue, includeRaw);
}

function formatSecurityMeta(issue: Record<string, any>): string | undefined {
	const parts = [issue.severity, issue.cwe ? `CWE-${issue.cwe}` : undefined].filter(Boolean);
	return parts.length ? parts.join(" · ") : undefined;
}

function addDecisionSurface(root: Record<string, any>, sections: FallowOverviewSection[], title: { value: string }, includeAllRaw: boolean): void {
	if (!root.decisions) return;
	title.value = "Fallow decision surface";
	const decisions = asArray(root.decisions);
	if (!decisions.length) return;
	sections.push({
		title: "Structural decisions",
		count: decisions.length,
		color: "accent",
		items: decisions.map((entry, index) => buildDecisionIssue(entry, includeAllRaw || index < INLINE_RAW_EXTENDED)),
	});
}

function buildDecisionIssue(entry: unknown, includeRaw = true): FallowIssueLine {
	const issue = asRecord(entry) ?? {};
	const item = withOptionalRaw({
		label: decisionLabel(issue),
		path: firstStringValue([issue.path, issue.file]),
		line: issue.line,
		meta: joinDefinedValues([issue.expert, issue.severity, issue.confidence]),
		action: firstStringValue([issue.prompt, issue.rationale]),
	}, issue, includeRaw);
	if (issue.severity) item.severity = issue.severity;
	return item;
}

function decisionLabel(issue: Record<string, any>): string {
	return firstStringValue([issue.question, issue.title, issue.kind]) ?? "decision";
}

function firstStringValue(values: unknown[]): string | undefined {
	const value = firstDefinedValue(values);
	return typeof value === "string" && value ? value : undefined;
}

function joinDefinedValues(values: unknown[]): string | undefined {
	const parts = values.filter((value) => value !== undefined && value !== null && value !== "").map(String);
	return parts.length ? parts.join(" · ") : undefined;
}

function addInspectionStats(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>, title: { value: string }, notes: string[]): void {
	if (root.kind !== "inspect_target") return;
	title.value = "Fallow inspect";
	const identity = asRecord(root.identity);
	if (!identity) return;
	addIfDefined(stats, "target", identity.file);
	addIfDefined(stats, "reachable", String(!!identity.is_reachable));
	addIfDefined(stats, "exports", identity.export_count);
	addIfDefined(stats, "imports", identity.import_count);
	addIfDefined(stats, "importers", identity.imported_by_count);
	for (const warning of asArray(root.warnings).slice(0, 3)) notes.push(String(warning));
}

function addWorkspaceStats(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>, title: { value: string }, notes: string[]): void {
	if (root.kind !== "list-workspaces") return;
	title.value = "Fallow workspaces";
	addIfDefined(stats, "workspaces", root.workspace_count);
	const diagnostics = asArray(root.workspace_diagnostics);
	if (diagnostics.length) notes.push(`${diagnostics.length} workspace diagnostic(s)`);
}

function addSchemaStats(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>, title: { value: string }): void {
	if (root.name !== "fallow" || !Array.isArray(root.commands)) return;
	title.value = "Fallow schema";
	addIfDefined(stats, "version", root.version);
	addIfDefined(stats, "commands", root.commands.length);
	addIfDefined(stats, "issue types", asArray(root.issue_types).length || undefined);
}

function addConfigStats(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>, title: { value: string }): void {
	if (!isConfigOutput(root)) return;
	title.value = "Fallow config";
	addIfDefined(stats, "entries", asArray(root.entry).length);
	addIfDefined(stats, "rules", Object.keys(asRecord(root.rules) ?? {}).length);
}

function isConfigOutput(root: Record<string, any>): boolean {
	if (!Array.isArray(root.entry)) return false;
	if (root.kind) return false;
	return ["rules", "duplicates", "health"].every((key) => Boolean(root[key]));
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
	appendRootMessage(root, notes);
	if (shouldAddNoIssuesNote(root, stats)) notes.push("No issues found in the selected report sections.");
}

function appendRootMessage(root: Record<string, any>, notes: string[]): void {
	if (root.message) notes.push(String(root.message));
}

function shouldAddNoIssuesNote(root: Record<string, any>, stats: Array<{ label: string; value: string | number }>): boolean {
	if (root.error) return false;
	return stats.length <= 1;
}

function addIfDefined(stats: Array<{ label: string; value: string | number }>, label: string, value: string | number | undefined): void {
	if (value === undefined) return;
	stats.push({ label, value });
}
export function buildFallowOverview(
	data: unknown,
	exitCode = 0,
	options: { includeAllRaw?: boolean } = {},
): FallowOverview | undefined {
	const root = asRecord(data);
	if (!root) return undefined;
	const stats: Array<{ label: string; value: string | number }> = [];
	const sections: FallowOverviewSection[] = [];
	const notes: string[] = [];
	const title = { value: "Fallow" };
	const includeAllRaw = options.includeAllRaw === true;

	addRootStats(root, stats);
	addConfigStats(root, stats, title);
	addOverviewSections(root, sections, title, includeAllRaw);
	addFeatureFlags(root, sections, title, includeAllRaw);
	addSecurity(root, sections, title, includeAllRaw);
	addDecisionSurface(root, sections, title, includeAllRaw);
	addInspectionStats(root, stats, title, notes);
	addWorkspaceStats(root, stats, title, notes);
	addSchemaStats(root, stats, title);
	addDefaultNotes(root, sections, stats, notes);
	applyErrorTitle(root, title);
	addExitCodeNote(notes, exitCode);

	return {
		title: title.value,
		status: buildFallowStatus(root, sections, exitCode),
		stats,
		sections,
		notes,
	};
}

function applyErrorTitle(root: Record<string, any>, title: { value: string }): void {
	if (root.error) title.value = "Fallow error";
}

function addOverviewSections(
	root: Record<string, any>,
	sections: FallowOverviewSection[],
	title: { value: string },
	includeAllRaw: boolean,
): void {
	if (isConfigOutput(root)) return;
	addPrimarySections(root, sections, title, includeAllRaw);
	addFallbackSections(root, sections, title, includeAllRaw);
}

function addExitCodeNote(notes: string[], exitCode: number): void {
	if (exitCode === 1) notes.push("Fallow exit 1 means findings/gate failure, not a crashed command.");
}

function buildFallowStatus(root: Record<string, any>, sections: FallowOverviewSection[], exitCode: number): "success" | "warning" | "error" {
	if (isFallowErrorState(root, exitCode)) return "error";
	return isFallowWarningState(sections, exitCode) ? "warning" : "success";
}

function isFallowErrorState(root: Record<string, any>, exitCode: number): boolean {
	return !!root.error || exitCode >= 2;
}

function isFallowWarningState(sections: FallowOverviewSection[], exitCode: number): boolean {
	return sections.some((section) => section.role !== "context" && section.items.length > 0) || exitCode === 1;
}
