import { asRecord } from "./data";
import { retainNormalizedFallowEntry } from "./normalized-report";
import { appendContextSection } from "./overview-section";
import type { FallowIssueLine, FallowOverviewSection } from "./types";

interface OverviewStat {
	label: string;
	value: string | number;
}

interface MutableTitle {
	value: string;
}

const INLINE_RAW_LIMIT = 5;

export function isRuntimeCoverageWarning(root: Record<string, any>): boolean {
	const runtime = asRecord(root.runtime_coverage);
	if (!runtime) return false;
	const provenance = asRecord(runtime.provenance) ?? {};
	return [
		runtime.verdict !== "clean",
		runtime.actionable === false,
		array(runtime.warnings).length > 0,
		provenance.stale === true,
		Boolean(runtime.watermark),
	].some(Boolean);
}

export function addRuntimeCoverageOverview(
	root: Record<string, any>,
	stats: OverviewStat[],
	sections: FallowOverviewSection[],
	title: MutableTitle,
	notes: string[],
	includeAllRaw: boolean,
): void {
	const runtime = asRecord(root.runtime_coverage);
	if (!runtime) return;
	applyRuntimeTitle(root.kind, title);
	addRuntimeStats(runtime, stats);
	addRuntimeFindings(runtime, sections, includeAllRaw);
	addRuntimeContext(runtime, sections, includeAllRaw);
	addRuntimeNotes(runtime, notes);
}

function applyRuntimeTitle(kind: unknown, title: MutableTitle): void {
	if (kind === "coverage-analyze") title.value = "Fallow runtime coverage";
	else if (kind === "health" && title.value === "Fallow") title.value = "Fallow health";
}

function addRuntimeStats(runtime: Record<string, any>, stats: OverviewStat[]): void {
	const summary = record(runtime.summary);
	const quality = record(summary.capture_quality);
	const provenance = record(runtime.provenance);
	const values: Array<[string, unknown]> = [
		["runtime verdict", runtime.verdict],
		["signals", stringList(runtime.signals)],
		["data source", firstDefined(summary.data_source, provenance.data_source)],
		["functions tracked", summary.functions_tracked],
		["functions hit", summary.functions_hit],
		["functions unhit", summary.functions_unhit],
		["functions untracked", summary.functions_untracked],
		["runtime coverage", percentage(summary.coverage_percent)],
		["trace count", summary.trace_count],
		["capture window", duration(quality.window_seconds)],
		["production origin", provenance.is_production],
		["actionable", booleanText(runtime.actionable)],
	];
	for (const [label, value] of values) addStat(stats, label, value);
}

function addRuntimeFindings(runtime: Record<string, any>, sections: FallowOverviewSection[], includeAllRaw: boolean): void {
	const findings = array(runtime.findings);
	if (!findings.length) return;
	sections.push({
		title: "Runtime coverage findings",
		count: findings.length,
		color: "warning",
		items: findings.map((entry, index) => buildRuntimeFinding(entry, includeAllRaw || index < INLINE_RAW_LIMIT)),
	});
}

function buildRuntimeFinding(entry: unknown, includeRaw: boolean): FallowIssueLine {
	const finding = asRecord(entry) ?? {};
	return withRaw({
		label: text(finding.function) ?? text(finding.verdict) ?? "runtime finding",
		path: text(finding.path),
		line: number(finding.line),
		meta: join([
			text(finding.verdict), confidence(finding.confidence), invocations(finding.invocations),
			trackingState(finding), observationVolume(finding),
		]),
		action: guardedRuntimeAction(finding),
	}, finding, includeRaw);
}

function addRuntimeContext(runtime: Record<string, any>, sections: FallowOverviewSection[], includeAllRaw: boolean): void {
	appendContextSection(sections, "Runtime hot paths", array(runtime.hot_paths), includeAllRaw, INLINE_RAW_LIMIT, buildHotPath);
	appendContextSection(sections, "Runtime blast radius", array(runtime.blast_radius), includeAllRaw, INLINE_RAW_LIMIT, buildBlastRadius);
	appendContextSection(sections, "Runtime importance", array(runtime.importance), includeAllRaw, INLINE_RAW_LIMIT, buildImportance);
}

function buildHotPath(entry: unknown, includeRaw: boolean): FallowIssueLine {
	const item = asRecord(entry) ?? {};
	return withRaw({
		label: text(item.function) ?? "hot path",
		path: text(item.path),
		line: number(item.line),
		meta: join([invocations(item.invocations), item.percentile === undefined ? undefined : `p${item.percentile}`]),
		action: primaryAction(item),
	}, item, includeRaw);
}

function buildBlastRadius(entry: unknown, includeRaw: boolean): FallowIssueLine {
	const item = asRecord(entry) ?? {};
	return withRaw({
		label: text(item.function) ?? "blast radius",
		path: text(item.file),
		line: number(item.line),
		meta: join([
			text(item.risk_band), metric(item.caller_count, "caller", "callers"),
			metric(item.caller_count_weighted_by_traffic, "weighted caller", "weighted callers"),
		]),
	}, item, includeRaw);
}

function buildImportance(entry: unknown, includeRaw: boolean): FallowIssueLine {
	const item = asRecord(entry) ?? {};
	return withRaw({
		label: text(item.function) ?? "runtime importance",
		path: text(item.file),
		line: number(item.line),
		meta: join([
			item.importance_score === undefined ? undefined : `score ${item.importance_score}`,
			invocations(item.invocations), metric(item.owner_count, "owner", "owners"),
		]),
		action: text(item.reason),
	}, item, includeRaw);
}

function addRuntimeNotes(runtime: Record<string, any>, notes: string[]): void {
	const summary = asRecord(runtime.summary) ?? {};
	const quality = asRecord(summary.capture_quality) ?? {};
	const provenance = asRecord(runtime.provenance) ?? {};
	addProvenanceNote(provenance, notes);
	addCaptureQualityNote(quality, notes);
	addStalenessNote(provenance, notes);
	addActionabilityNote(runtime, notes);
	addAdvisoryNote(runtime, notes);
	appendWarnings(runtime, notes);
	addWatermarkNote(runtime, notes);
}

function addProvenanceNote(provenance: Record<string, any>, notes: string[]): void {
	if (!Object.keys(provenance).length) return;
	notes.push(`Runtime evidence source is ${provenance.data_source ?? "unknown"}; production origin is ${provenance.is_production ?? "unknown"}.`);
}

function addCaptureQualityNote(quality: Record<string, any>, notes: string[]): void {
	if (!quality.lazy_parse_warning) return;
	const ratio = typeof quality.untracked_ratio_percent === "number" ? `${quality.untracked_ratio_percent}%` : "an unknown percentage";
	notes.push(`Capture quality warns that ${ratio} of functions were untracked.`);
}

function addStalenessNote(provenance: Record<string, any>, notes: string[]): void {
	if (!provenance.stale) return;
	notes.push(`Runtime evidence is stale under the report's ${provenance.stale_after_days ?? "configured"}-day cutoff.`);
}

function addActionabilityNote(runtime: Record<string, any>, notes: string[]): void {
	if (runtime.actionable !== false) return;
	notes.push(`Runtime evidence is not actionable: ${runtime.actionability_reason ?? runtime.actionability_verdict ?? "insufficient evidence"}.`);
}

function addAdvisoryNote(runtime: Record<string, any>, notes: string[]): void {
	if (!array(runtime.findings).length) return;
	notes.push("Runtime verdicts are advisory evidence, not deletion authorization; inspect or trace code and review capture quality before editing.");
}

function addWatermarkNote(runtime: Record<string, any>, notes: string[]): void {
	if (runtime.watermark) notes.push(`Runtime coverage watermark: ${runtime.watermark}.`);
}

function appendWarnings(runtime: Record<string, any>, notes: string[]): void {
	const warnings = array(runtime.warnings);
	notes.push(...warnings.slice(0, 3).map(runtimeWarningMessage));
	if (warnings.length > 3) notes.push(`${warnings.length - 3} additional runtime coverage warning(s) omitted.`);
}

function runtimeWarningMessage(warning: unknown): string {
	const message = runtimeWarningRecordMessage(asRecord(warning));
	if (message) return message;
	return text(warning) ?? "Runtime coverage warning.";
}

function runtimeWarningRecordMessage(warning: Record<string, any> | undefined): string | undefined {
	if (!warning) return undefined;
	return text(warning.message) ?? text(warning.code);
}

function withRaw(item: FallowIssueLine, raw: Record<string, any>, includeRaw: boolean): FallowIssueLine {
	retainNormalizedFallowEntry(item, raw);
	if (includeRaw) item.raw = raw;
	return item;
}

function guardedRuntimeAction(finding: Record<string, any>): string {
	const suggested = primaryAction(finding);
	const guard = runtimeActionGuard(finding);
	return suggested ? `${guard} Suggested action: ${suggested}` : guard;
}

function runtimeActionGuard(finding: Record<string, any>): string {
	if (finding.verdict === "coverage_unavailable") return "Coverage is unavailable; do not infer that this code is unused or safe to delete.";
	if (asRecord(finding.discriminators)?.meets_observation_volume === false) return "Below the confidence floor—not proof of unused or delete safety; inspect or trace before editing.";
	return "Inspect or trace and review capture quality before editing.";
}

function primaryAction(record: Record<string, any>): string | undefined {
	const action = array(record.actions).map(asRecord).find(Boolean);
	return text(action?.description) ?? text(action?.type);
}

function trackingState(finding: Record<string, any>): string | undefined {
	const state = asRecord(finding.discriminators)?.tracking_state;
	return state ? `tracking ${state}` : undefined;
}

function observationVolume(finding: Record<string, any>): string | undefined {
	const discriminators = asRecord(finding.discriminators) ?? {};
	const values = [discriminators.trace_count, discriminators.min_observation_volume];
	if (values.some((value) => value === undefined)) return undefined;
	const state = discriminators.meets_observation_volume === false ? "below floor" : "meets floor";
	return `volume ${values[0]}/${values[1]} (${state})`;
}

function confidence(value: unknown): string | undefined {
	return value ? `confidence ${value}` : undefined;
}

function invocations(value: unknown): string | undefined {
	return typeof value === "number" ? metric(value, "invocation", "invocations") : undefined;
}

function metric(value: unknown, singular: string, plural: string): string | undefined {
	return typeof value === "number" ? `${value} ${value === 1 ? singular : plural}` : undefined;
}

function booleanText(value: unknown): string | undefined {
	return typeof value === "boolean" ? String(value) : undefined;
}

function percentage(value: unknown): string | undefined {
	return typeof value === "number" ? `${value}%` : undefined;
}

function duration(value: unknown): string | undefined {
	return typeof value === "number" ? `${value}s` : undefined;
}

function stringList(value: unknown): string | undefined {
	const values = array(value).map(String);
	return values.length ? values.join(", ") : undefined;
}

function addStat(stats: OverviewStat[], label: string, value: unknown): void {
	if (typeof value === "string" || typeof value === "number") stats.push({ label, value });
}

function join(values: Array<string | undefined>): string | undefined {
	const present = values.filter((value): value is string => Boolean(value));
	return present.length ? present.join(" · ") : undefined;
}

function record(value: unknown): Record<string, any> {
	return asRecord(value) ?? {};
}

function firstDefined(primary: unknown, fallback: unknown): unknown {
	return primary === undefined ? fallback : primary;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
