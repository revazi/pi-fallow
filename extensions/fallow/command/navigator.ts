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

const INFORMATIONAL_HEALTH_FLAGS = ["--file-scores", "--hotspots", "--ownership"];
const ACTIONABLE_HEALTH_FLAGS = ["--complexity", "--targets", "--coverage-gaps", "--css"];

export function resolveFallowNavigatorVisibleRows(terminalRows: number, informationalMode: boolean): number {
	if (!Number.isFinite(terminalRows) || terminalRows < 1) return MAX_VISIBLE_ROWS;
	const overlayRows = Math.floor(terminalRows * 0.95);
	const staticRows = informationalMode ? INFORMATIONAL_STATIC_ROWS : NAVIGATOR_STATIC_ROWS;
	return Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, overlayRows - staticRows));
}

export function isInformationalNavigatorCommand(args: string[]): boolean {
	if (args[0] === "flags") return true;
	if (args[0] !== "health") return false;
	if (!hasAnyFlag(args, INFORMATIONAL_HEALTH_FLAGS)) return false;
	return !hasAnyFlag(args, ACTIONABLE_HEALTH_FLAGS);
}

function hasAnyFlag(args: string[], flags: string[]): boolean {
	return flags.some((flag) => args.includes(flag));
}
