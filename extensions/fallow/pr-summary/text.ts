import type { FallowPrSummary } from "../types";
import { formatSummaryLines } from "../summary/format";
import { formatFallowPrSummary } from "./format";

export function formatFallowPrSummaryText(summary: FallowPrSummary | undefined): string | undefined {
	return formatSummaryLines(formatFallowPrSummary(summary));
}
