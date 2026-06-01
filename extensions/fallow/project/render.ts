import type { FallowProjectState } from "../types";
import { renderSummaryLines } from "../summary/render";
import { formatFallowProjectState } from "./format";

export function renderFallowProjectState(state: FallowProjectState | undefined, theme: { fg: (color: string, text: string) => string }): string {
	return renderSummaryLines(formatFallowProjectState(state), theme);
}
