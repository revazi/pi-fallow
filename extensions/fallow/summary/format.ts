import type { FallowSummaryLines } from "../types";

export function formatSummaryLines(summary: FallowSummaryLines | undefined): string | undefined {
	if (!summary) return undefined;
	return summary.lines
		.map((line) => line.text)
		.filter((text) => text.length > 0)
		.join("\n");
}
