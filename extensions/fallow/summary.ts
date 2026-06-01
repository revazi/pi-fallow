// fallow-ignore-file unused-export
import type { FallowSummaryLines } from "./types";

export function formatSummaryLines(summary: FallowSummaryLines | undefined): string | undefined {
	if (!summary) return undefined;
	return summary.lines
		.map((line) => line.text)
		.filter((text) => text.length > 0)
		.join("\n");
}

export function renderSummaryLines(summary: FallowSummaryLines | undefined, theme: { fg: (color: string, text: string) => string }): string {
	if (!summary) return "";
	const fg = theme.fg.bind(theme);
	return summary.lines
		.filter((line) => line.text.length > 0)
		.map((line) => fg(line.tone ?? "dim", line.text))
		.join("\n");
}
