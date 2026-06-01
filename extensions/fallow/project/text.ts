import type { FallowProjectState } from "../types";
import { formatSummaryLines } from "../summary/format";
import { formatFallowProjectState } from "./format";

export function formatFallowProjectStateText(state: FallowProjectState | undefined): string | undefined {
	return formatSummaryLines(formatFallowProjectState(state));
}
