import type { FallowIssueLine, FallowOverview, FallowOverviewSection } from "./types";

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function fmt(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
	return String(value);
}

function issueLocation(issue: Record<string, any>): { path?: string; line?: number } {
	const importedFrom = asArray(issue.imported_from)[0];
	return {
		path: issue.path ?? issue.file ?? importedFrom?.path,
		line: issue.line ?? issue.start_line ?? importedFrom?.line,
	};
}

function primaryAction(issue: Record<string, any>): string | undefined {
	const actions = asArray(issue.actions);
	const action = actions.find((entry) => entry?.type && entry.type !== "suppress-line" && entry.type !== "suppress-file") ?? actions[0];
	return action?.description ?? action?.type;
}

function issueLabel(kind: string, issue: Record<string, any>): string {
	if (issue.export_name) return `${kind}: ${issue.export_name}`;
	if (issue.package_name) return `${kind}: ${issue.package_name}`;
	if (issue.name) return `${kind}: ${issue.name}`;
	if (issue.rule_id) return `${kind}: ${issue.rule_id}`;
	return kind;
}

function issueMeta(issue: Record<string, any>): string | undefined {
	const parts: string[] = [];
	if (issue.severity) parts.push(issue.severity);
	if (issue.cyclomatic !== undefined) parts.push(`cyc ${issue.cyclomatic}`);
	if (issue.cognitive !== undefined) parts.push(`cog ${issue.cognitive}`);
	if (issue.crap !== undefined) parts.push(`CRAP ${fmt(issue.crap)}`);
	if (issue.line_count !== undefined) parts.push(`${issue.line_count} lines`);
	if (issue.token_count !== undefined) parts.push(`${issue.token_count} tokens`);
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
	const findings = asArray(data.findings);
	if (findings.length) {
		sections.push({
			title: "Complexity findings",
			count: findings.length,
			color: "error",
			items: findings.slice(0, 8).map((entry) => makeIssue("complexity", asRecord(entry) ?? {})),
		});
	}
	const fileScores = asArray(data.file_scores);
	if (fileScores.length) {
		sections.push({
			title: "Worst file scores",
			count: fileScores.length,
			color: "accent",
			items: fileScores.slice(0, 5).map((entry) => {
				const issue = asRecord(entry) ?? {};
				return {
					label: `score ${fmt(issue.maintainability_index)}`,
					path: issue.path,
					meta: `${issue.lines ?? "?"} LOC · dead ${fmt((issue.dead_code_ratio ?? 0) * 100)}% · CRAP max ${fmt(issue.crap_max)}`,
					raw: issue,
				};
			}),
		});
	}
	const targets = asArray(data.targets);
	if (targets.length) {
		sections.push({
			title: "Refactoring targets",
			count: targets.length,
			color: "warning",
			items: targets.slice(0, 5).map((entry) => {
				const issue = asRecord(entry) ?? {};
				return {
					label: issue.category ?? "target",
					path: issue.path,
					meta: `priority ${fmt(issue.priority)} · ${issue.effort ?? "unknown effort"}`,
					action: issue.recommendation,
					raw: issue,
				};
			}),
		});
	}
	const hotspots = asArray(data.hotspots);
	if (hotspots.length) {
		sections.push({
			title: "Hotspots",
			count: hotspots.length,
			color: "warning",
			items: hotspots.slice(0, 5).map((entry) => {
				const issue = asRecord(entry) ?? {};
				return {
					label: `hotspot ${fmt(issue.score)}`,
					path: issue.path,
					meta: `${issue.commits ?? "?"} commits · churn ${(issue.lines_added ?? 0) + (issue.lines_deleted ?? 0)} · ${issue.trend ?? ""}`,
					raw: issue,
				};
			}),
		});
	}
	return sections;
}

function buildDupesSections(data: Record<string, any>): FallowOverviewSection[] {
	const groups = asArray(data.clone_groups);
	if (!groups.length) return [];
	return [{
		title: "Clone groups",
		count: groups.length,
		color: "warning",
		items: groups.slice(0, 6).map((entry, index) => {
			const group = asRecord(entry) ?? {};
			const instances = asArray(group.instances);
			const first = asRecord(instances[0]) ?? {};
			const second = asRecord(instances[1]) ?? {};
			return {
				label: `clone #${index + 1}`,
				path: first.file,
				line: first.start_line,
				meta: `${group.line_count ?? "?"} lines · ${group.token_count ?? "?"} tokens · ${instances.length} instances`,
				action: second.file ? `also at ${second.file}:${second.start_line}` : primaryAction(group),
				raw: group,
			};
		}),
	}];
}

function addSummaryStats(stats: Array<{ label: string; value: string | number }>, summary: Record<string, any> | undefined, keys: string[]): void {
	if (!summary) return;
	for (const key of keys) {
		if (summary[key] !== undefined) stats.push({ label: key.replaceAll("_", " "), value: fmt(summary[key]) });
	}
}

export function buildFallowOverview(data: unknown, exitCode = 0): FallowOverview | undefined {
	const root = asRecord(data);
	if (!root) return undefined;
	const stats: Array<{ label: string; value: string | number }> = [];
	const sections: FallowOverviewSection[] = [];
	const notes: string[] = [];
	let title = "Fallow";

	if (root.verdict) stats.push({ label: "verdict", value: root.verdict });
	if (root.total_issues !== undefined) stats.push({ label: "issues", value: root.total_issues });
	if (root.elapsed_ms !== undefined) stats.push({ label: "elapsed", value: `${root.elapsed_ms}ms` });
	if (root.health_score) {
		stats.push({ label: "score", value: `${fmt(root.health_score.score)} ${root.health_score.grade ?? ""}`.trim() });
	}

	const rootSummary = asRecord(root.summary);
	addSummaryStats(stats, rootSummary, ["total_issues", "files_analyzed", "functions_above_threshold", "severity_critical_count", "clone_groups", "duplicated_lines", "average_maintainability"]);

	if (root.check || root.dead_code) {
		title = "Fallow full analysis";
		const check = asRecord(root.check ?? root.dead_code);
		if (check) sections.push(...buildDeadCodeSections(check).map((section) => ({ ...section, title: `Dead code · ${section.title}` })));
	}
	if (root.dupes || root.duplication) {
		title = title === "Fallow" ? "Fallow duplication" : title;
		const dupes = asRecord(root.dupes ?? root.duplication);
		if (dupes) sections.push(...buildDupesSections(dupes).map((section) => ({ ...section, title: `Dupes · ${section.title}` })));
	}
	if (root.health) {
		title = title === "Fallow" ? "Fallow health" : title;
		const health = asRecord(root.health);
		if (health) sections.push(...buildHealthSections(health).map((section) => ({ ...section, title: `Health · ${section.title}` })));
	}

	if (!sections.length) {
		const deadSections = buildDeadCodeSections(root);
		const healthSections = buildHealthSections(root);
		const dupeSections = buildDupesSections(root);
		sections.push(...deadSections, ...healthSections, ...dupeSections);
		if (healthSections.length) title = "Fallow health";
		else if (dupeSections.length) title = "Fallow duplication";
		else if (deadSections.length) title = "Fallow dead code";
	}

	if (root.feature_flags) {
		title = "Fallow feature flags";
		const flags = asArray(root.feature_flags);
		sections.push({
			title: "Feature flags",
			count: flags.length,
			color: "accent",
			items: flags.slice(0, 8).map((entry) => makeIssue("flag", asRecord(entry) ?? {})),
		});
	}

	if (root.entry_point_count !== undefined) stats.push({ label: "entry points", value: root.entry_point_count });
	if (root.file_count !== undefined) stats.push({ label: "files", value: root.file_count });
	if (!sections.length && root.message) notes.push(String(root.message));
	if (!sections.length && stats.length <= 1) notes.push("No issues found in the selected report sections.");
	if (exitCode === 1) notes.push("Fallow exit 1 means findings/gate failure, not a crashed command.");

	const status = exitCode >= 2 || root.error ? "error" : sections.length || exitCode === 1 ? "warning" : "success";
	return { title, status, stats, sections, notes };
}
