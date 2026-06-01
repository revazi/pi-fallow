import type { FallowProjectState, FallowSummaryLines } from "../types";

export function formatFallowProjectState(state: FallowProjectState | undefined): FallowSummaryLines | undefined {
	if (!state) return undefined;
	return {
		lines: [
			{ text: `Config: ${formatProjectConfig(state)}` },
			{ text: `Cache: ${formatProjectCache(state)}` },
		],
	};
}

function formatProjectConfig(state: FallowProjectState): string {
	return state.configPath ? `${state.configPath}${state.configSource === "flag" ? " (--config)" : ""}` : "none";
}

function formatProjectCache(state: FallowProjectState): string {
	if (!state.cacheEnabled) return "disabled (--no-cache)";
	return state.cacheFiles.length ? state.cacheFiles.join(", ") : "none";
}
