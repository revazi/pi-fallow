import { Text } from "@earendil-works/pi-tui";
import { renderFallowProjectState } from "./project/render";
import { renderFallowPrSummary } from "./pr-summary/render";
import type { FallowDetails, FallowOverview, FallowPrSummary, FallowProjectState } from "./types";
import { FallowOverviewComponent } from "./ui";

export function commandDisplay(binary: string, args: string[]): string {
	return [binary, ...args].map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
}

export function fallowExitLabel(code: number, killed = false): string {
	if (killed) return "killed";
	if (code === 0) return "ok";
	if (code === 1) return "findings";
	return "error";
}

export function renderFallowToolCall(args: { command?: string; root?: string; changedSince?: string; base?: string }, theme: any): Text {
	return new Text(formatToolCallTitle(args, theme), 0, 0);
}

function formatToolCallTitle(args: { command?: string; root?: string; changedSince?: string; base?: string }, theme: any): string {
	return [
		theme.fg("toolTitle", theme.bold("fallow ")),
		theme.fg("accent", args.command ?? "run"),
		...formatToolCallRootParts(args, theme),
		...formatToolCallChangeParts(args, theme),
	].join("");
}

export function renderFallowToolResult(
	result: { details?: unknown },
	{ expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
	theme: any,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Running Fallow..."), 0, 0);
	const details = result.details as FallowDetails | undefined;
	if (!details) return new Text(theme.fg("dim", "No Fallow details"), 0, 0);
	if (details.overview) {
		return new FallowOverviewComponent(details.overview, theme, {
			expanded,
			command: commandDisplay(details.command, details.args),
			fullOutputPath: details.fullOutputPath,
			truncated: details.truncated,
			projectState: details.projectState,
			prSummary: details.prSummary,
		});
	}
	return new Text(buildFallowCompactMessage(details, expanded, theme), 0, 0);
}

export function renderFallowMessageRenderer(message: any, options: any, theme: any): Text {
	const details = message.details as MessageRendererDetails | undefined;
	const compactMessage = renderFallowCompactResultMessage(details, theme);
	if (compactMessage) return compactMessage;
	const overviewMessage = renderFallowOverviewResultMessage(details, options, theme);
	if (overviewMessage) return overviewMessage;
	return new Text(theme.fg("toolTitle", theme.bold("Fallow result")) + "\n" + message.content, 0, 0);
}

function formatToolCallRootParts(args: { root?: string }, theme: any): string[] {
	if (!args.root) return [];
	return [theme.fg("muted", ` in ${args.root}`)];
}

function formatToolCallChangeParts(args: { changedSince?: string; base?: string }, theme: any): string[] {
	const changeReference = args.changedSince ?? args.base;
	if (!changeReference) return [];
	return [theme.fg("dim", ` since ${changeReference}`)];
}

function buildFallowCompactMessage(
	details: FallowDetails,
	expanded: boolean | undefined,
	theme: any,
): string {
	const base = formatBaseCompactMessage(details, theme);
	if (!expanded) return base;
	return [
		base,
		theme.fg("muted", commandDisplay(details.command, details.args)),
		theme.fg("dim", details.summary),
		...buildCompactMessageSummary(details, theme),
		details.fullOutputPath ? theme.fg("dim", `Full output: ${details.fullOutputPath}`) : undefined,
	].filter(Boolean).join("\n");
}

function formatBaseCompactMessage(details: FallowDetails, theme: any): string {
	const statusColor = details.exitCode === 0 ? "success" : "warning";
	const parts = [
		theme.fg(statusColor, `Fallow ${fallowExitLabel(details.exitCode)} (exit ${details.exitCode})`),
		details.truncated ? theme.fg("warning", " (truncated)") : undefined,
		theme.fg("dim", ` · ${details.elapsedMs}ms`),
	];
	return parts.filter(Boolean).join("");
}

function buildCompactMessageSummary(details: FallowDetails, theme: any): string[] {
	return [
		renderFallowPrSummary(details.prSummary, theme),
		renderFallowProjectState(details.projectState, theme),
	].filter(Boolean);
}

function renderFallowCompactResultMessage(
	details: MessageRendererDetails | undefined,
	theme: any,
): Text | null {
	if (!details || !details.compact) return null;
	return new Text(buildCompactFallowMessage(details, theme), 0, 0);
}

function buildCompactFallowMessage(
	details: MessageRendererDetails,
	theme: any,
): string {
	const title = details.overview ? details.overview.title : "Fallow result";
	const summary = buildCompactSummary(details, theme);
	const stats = buildCompactStats(details.overview);
	const lines = [
		theme.fg("toolTitle", theme.bold(title)),
		theme.fg("muted", "Detailed findings were shown in the navigator window."),
	];
	return [
		...lines.slice(0, 1),
		...includeCompactLine(stats, (line) => theme.fg("dim", line)),
		...includeCompactLine(summary, (line) => line),
		...lines.slice(1),
	].join("\n");
}

function includeCompactLine<T>(value: T | undefined, render: (value: T) => string): string[] {
	if (value === undefined) return [];
	return [render(value)];
}

function buildCompactStats(overview: FallowOverview | undefined): string {
	const stats = overview?.stats ?? [];
	if (!stats.length) return "";
	return stats.slice(0, 5).map((stat) => `${stat.label}: ${stat.value}`).join(" · ");
}

function buildCompactSummary(details: MessageRendererDetails, theme: any): string {
	const prSummaryLines = renderFallowPrSummary(details.prSummary, theme);
	const projectStateLines = renderFallowProjectState(details.projectState, theme);
	return [prSummaryLines, projectStateLines].filter(Boolean).join("\n");
}

function renderFallowOverviewResultMessage(
	details: MessageRendererDetails | undefined,
	options: { expanded?: boolean },
	theme: any,
): Text | null {
	if (!details || !details.overview) return null;
	const overview = details.overview;
	return new FallowOverviewComponent(overview, theme, {
		expanded: options.expanded,
		command: resolveOverviewCommand(details),
		fullOutputPath: details.fullOutputPath,
		truncated: details.truncated,
		projectState: details.projectState,
		prSummary: details.prSummary,
	});
}

function resolveOverviewCommand(details: MessageRendererDetails | undefined): string | undefined {
	if (!details?.command || !details.args) return undefined;
	return commandDisplay(details.command, details.args);
}

type MessageRendererDetails = {
	command?: string;
	args?: string[];
	overview?: FallowOverview;
	compact?: boolean;
	fullOutputPath?: string;
	truncated?: boolean;
	projectState?: FallowProjectState;
	prSummary?: FallowPrSummary;
};
