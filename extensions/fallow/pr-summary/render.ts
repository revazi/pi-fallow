import type { FallowPrSummary } from "../types";
import { renderSummaryLines } from "../summary/render";
import { formatFallowPrSummary } from "./format";

export function renderFallowPrSummary(summary: FallowPrSummary | undefined, theme: { fg: (color: string, text: string) => string }): string {
	return renderSummaryLines(formatFallowPrSummary(summary), theme);
}
