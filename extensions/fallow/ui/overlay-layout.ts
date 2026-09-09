import { CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";

export function overlayRows(rows: number): number {
	return Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.floor(rows * 0.95)) : 24;
}

/** Fixed chrome has a bounded budget; the entire body remains accessible by scrolling. */
export function overlayFrame(
	width: number, rows: number, heading: string[], body: string[], footer: string[], scroll: number, anchor?: number,
): { lines: string[]; start: number; pageRows: number; contentRows: number } {
	const height = Math.max(1, Math.floor(rows));
	const top = heading.slice(0, Math.min(3, Math.max(0, height - 2)));
	const bottom = footer.slice(0, Math.min(3, Math.max(0, height - top.length - 1)));
	const pageRows = Math.max(1, height - top.length - bottom.length);
	const cursor = body.findIndex((line) => line.includes(CURSOR_MARKER));
	const target = cursor >= 0 ? cursor : anchor;
	const start = visibleStart(scroll, body.length, pageRows, target);
	const lines = [...top, ...body.slice(start, start + pageRows), ...bottom].map((line) => truncateToWidth(line, width));
	return { lines, start, pageRows, contentRows: body.length };
}

function visibleStart(scroll: number, count: number, rows: number, anchor: number | undefined): number {
	const start = Math.max(0, Math.min(scroll, Math.max(0, count - rows)));
	if (anchor === undefined) return start;
	return Math.max(0, Math.min(anchor, Math.max(start, anchor - rows + 1)));
}
