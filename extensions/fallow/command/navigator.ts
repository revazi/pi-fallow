import { getNormalizedFallowReport } from "../normalized-report";
import type { FallowOverview } from "../types";

const NAVIGATOR_STATIC_ROWS = 17;
const INFORMATIONAL_STATIC_ROWS = 9;
const MIN_VISIBLE_ROWS = 3;
const MAX_VISIBLE_ROWS = 30;

export const FALLOW_NAVIGATOR_OVERLAY_OPTIONS = {
	width: "90%",
	minWidth: 50,
	maxHeight: "95%",
	anchor: "center",
} as const;

export type FallowNavigatorMode = "none" | "informational" | "actionable";

export function resolveFallowNavigatorVisibleRows(terminalRows: number, informationalMode: boolean): number {
	if (!Number.isFinite(terminalRows) || terminalRows < 1) return MAX_VISIBLE_ROWS;
	const overlayRows = Math.floor(terminalRows * 0.95);
	const staticRows = informationalMode ? INFORMATIONAL_STATIC_ROWS : NAVIGATOR_STATIC_ROWS;
	return Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, overlayRows - staticRows));
}

export function resolveFallowNavigatorMode(overview: FallowOverview | undefined): FallowNavigatorMode {
	if (!overview) return "none";
	const report = getNormalizedFallowReport(overview);
	if (!report.entryCount) return "none";
	return report.findingCount ? "actionable" : "informational";
}
