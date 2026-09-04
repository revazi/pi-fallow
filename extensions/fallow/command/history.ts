import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFallowHistoryComparison } from "../history-comparison";
import {
	FALLOW_HISTORY_LIMIT,
	findFallowHistoryEntry,
	getFallowHistoryArtifactStatus,
	listFallowHistory,
	readFallowHistoryArtifact,
	type FallowHistoryArtifactStatus,
	type FallowHistoryEntry,
	type FallowHistoryState,
} from "../history";
import { buildFallowOverview } from "../overview";
import type { FallowNavigatorResult, FallowNavigatorState, FallowOverview } from "../types";
import { isFallowTuiMode } from "./mode";
import { openFallowOverviewNavigator } from "./result-flow";
import type { FallowCommandContext } from "./types";

interface LoadedHistoryReport {
	entry: FallowHistoryEntry;
	overview: FallowOverview;
}

export async function executeFallowHistoryCommand(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
	initialState?: FallowNavigatorState,
): Promise<FallowNavigatorResult | null | undefined> {
	try {
		return await dispatchHistoryCommand(pi, ctx, state, args, initialState);
	} catch (error) {
		return reportHistoryError(ctx, error);
	}
}

function dispatchHistoryCommand(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
	initialState?: FallowNavigatorState,
): Promise<FallowNavigatorResult | null | undefined> {
	const operation = args[1] ?? "list";
	if (operation === "list") return showFallowHistory(pi, ctx, state, args);
	return dispatchHistoryDetailCommand(pi, ctx, state, args, initialState, operation);
}

function dispatchHistoryDetailCommand(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
	initialState: FallowNavigatorState | undefined,
	operation: string,
): Promise<FallowNavigatorResult | null | undefined> {
	if (operation === "open") return openFallowHistory(pi, ctx, state, args, initialState);
	if (operation === "compare") return compareFallowHistory(pi, ctx, state, args, initialState);
	if (operation === "clear") return Promise.resolve(clearFallowHistory(pi, ctx, state, args));
	return Promise.reject(new Error("history expects list, open <run-id>, compare <prior-id> <current-id>, or clear"));
}

async function showFallowHistory(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
): Promise<null> {
	if (args.length > 2) throw new Error("history list does not accept extra arguments");
	const entries = listFallowHistory(state, ctx.cwd);
	const statuses = await Promise.all(entries.map(getFallowHistoryArtifactStatus));
	const content = ctx.mode === "json"
		? JSON.stringify(historyJson(ctx.cwd, entries, statuses), null, 2)
		: formatHistoryList(entries, statuses);
	sendHistoryMessage(pi, ctx, args, content);
	return null;
}

async function openFallowHistory(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
	initialState?: FallowNavigatorState,
): Promise<FallowNavigatorResult | null> {
	validateHistoryArity(args, 3, "history open requires exactly one run id");
	const loaded = await loadHistoryReport(state, ctx.cwd, args[2]!);
	const content = ctx.mode === "json"
		? JSON.stringify({ kind: "pi-fallow-history-open", entry: loaded.entry }, null, 2)
		: `Reopened ${loaded.entry.id}: ${loaded.entry.command}\nRecorded Git HEAD: ${shortGitHead(loaded.entry)}\nComplete report: ${loaded.entry.reportPath}`;
	sendHistoryMessage(pi, ctx, args, content, loaded.overview);
	return openFallowOverviewNavigator(ctx, loaded.overview, {
		command: loaded.entry.command,
		commandArgs: [...args],
		initialState,
		fullOutputPath: loaded.entry.reportPath,
	});
}

async function compareFallowHistory(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
	initialState?: FallowNavigatorState,
): Promise<FallowNavigatorResult | null> {
	validateHistoryArity(args, 4, "history compare requires prior and current run ids");
	const [prior, current] = await Promise.all([
		loadHistoryReport(state, ctx.cwd, args[2]!),
		loadHistoryReport(state, ctx.cwd, args[3]!),
	]);
	const overview = buildFallowHistoryComparison({
		prior: prior.entry,
		current: current.entry,
		priorOverview: prior.overview,
		currentOverview: current.overview,
	});
	const content = ctx.mode === "json"
		? JSON.stringify({
			kind: "pi-fallow-history-comparison",
			prior: prior.entry.id,
			current: current.entry.id,
			stats: overview.stats,
			notes: overview.notes,
		}, null, 2)
		: formatComparisonSummary(prior.entry, current.entry, overview);
	sendHistoryMessage(pi, ctx, args, content, overview);
	return openFallowOverviewNavigator(ctx, overview, {
		command: `/fallow history compare ${prior.entry.id} ${current.entry.id}`,
		commandArgs: [...args],
		initialState,
	});
}

function clearFallowHistory(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	state: FallowHistoryState,
	args: string[],
): null {
	validateHistoryArity(args, 2, "history clear does not accept extra arguments");
	const rootEntries = new Set(listFallowHistory(state, ctx.cwd));
	state.entries = state.entries.filter((entry) => !rootEntries.has(entry));
	const content = ctx.mode === "json"
		? JSON.stringify({ kind: "pi-fallow-history-cleared", removed: rootEntries.size, reportsDeleted: false }, null, 2)
		: "Cleared this project's session history metadata. Report files were not deleted.";
	sendHistoryMessage(pi, ctx, args, content);
	return null;
}

async function loadHistoryReport(state: FallowHistoryState, cwd: string, id: string): Promise<LoadedHistoryReport> {
	validateHistoryId(id);
	const entry = requireHistoryEntry(state, cwd, id);
	const data = parseHistoryArtifact(await readFallowHistoryArtifact(entry), id);
	const overview = requireHistoryOverview(data, entry);
	return { entry, overview };
}

function validateHistoryId(id: string): void {
	if (!/^r\d+$/.test(id)) throw new Error("history run ids use the form r1");
}

function requireHistoryEntry(state: FallowHistoryState, cwd: string, id: string): FallowHistoryEntry {
	const entry = findFallowHistoryEntry(state, cwd, id);
	if (!entry) throw new Error(`History run ${id} is unavailable, expired, or belongs to another project/session.`);
	return entry;
}

function parseHistoryArtifact(text: string, id: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`History run ${id} no longer contains structured JSON.`);
	}
}

function requireHistoryOverview(data: unknown, entry: FallowHistoryEntry): FallowOverview {
	const overview = buildFallowOverview(data, entry.exitCode);
	if (!overview) throw new Error(`History run ${entry.id} cannot be reopened as a Fallow report.`);
	return overview;
}

function validateHistoryArity(args: string[], expected: number, message: string): void {
	if (args.length !== expected) throw new Error(message);
}

function historyJson(root: string, entries: FallowHistoryEntry[], statuses: FallowHistoryArtifactStatus[]) {
	return {
		kind: "pi-fallow-history",
		scope: "session",
		root: resolve(root),
		limit: FALLOW_HISTORY_LIMIT,
		entries: entries.map((entry, index) => ({ ...entry, artifactStatus: statuses[index] })),
	};
}

function formatHistoryList(entries: FallowHistoryEntry[], statuses: FallowHistoryArtifactStatus[]): string {
	if (!entries.length) return "No Fallow history is available for this project in the current session.";
	const lines = entries.map((entry, index) => {
		const completeness = entry.complete ? "complete" : `incomplete:${entry.completenessReason ?? "unknown"}`;
		return `${entry.id}  ${entry.timestamp}  ${entry.findingCount} finding(s)  ${completeness}  ${statuses[index]}  git:${shortGitHead(entry)}\n    ${entry.command}`;
	});
	return [
		`Fallow session history (${entries.length}/${FALLOW_HISTORY_LIMIT})`,
		...lines,
		"Use /fallow history open <id> or /fallow history compare <prior-id> <current-id>.",
	].join("\n");
}

function shortGitHead(entry: FallowHistoryEntry): string {
	return entry.gitHead?.slice(0, 12) ?? "unavailable";
}

function formatComparisonSummary(
	prior: FallowHistoryEntry,
	current: FallowHistoryEntry,
	overview: FallowOverview,
): string {
	const counts = new Map(overview.stats.map((item) => [item.label, item.value]));
	return [
		`Compared ${prior.id} → ${current.id}: ${comparisonCount(counts, "new")} new, ${comparisonCount(counts, "unchanged")} unchanged, ${comparisonCount(counts, "resolved")} resolved, ${comparisonCount(counts, "unavailable")} unavailable.`,
		...overview.notes.map((note) => `Note: ${note}`),
		`Prior report: ${prior.reportPath}`,
		`Current report: ${current.reportPath}`,
	].join("\n");
}

function comparisonCount(counts: Map<string, string | number>, label: string): string | number {
	return counts.get(label) ?? 0;
}

function sendHistoryMessage(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	args: string[],
	content: string,
	overview?: FallowOverview,
): void {
	const tuiOverview = isFallowTuiMode(ctx.mode) ? overview : undefined;
	pi.sendMessage({
		customType: "fallow-result",
		content,
		display: true,
		details: {
			command: "/fallow",
			args,
			cwd: ctx.cwd,
			exitCode: 0,
			elapsedMs: 0,
			parsed: true,
			summary: content,
			overview: tuiOverview,
			compact: Boolean(tuiOverview?.sections.some((section) => section.items.length)),
		},
	});
}

function reportHistoryError(ctx: FallowCommandContext, error: unknown): null {
	const message = error instanceof Error ? error.message : String(error);
	if (!ctx.hasUI) throw error;
	ctx.ui.notify(message, "error");
	return null;
}
