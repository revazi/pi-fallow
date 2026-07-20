import type { FallowOverview } from "../types";
import type { FallowRunMode } from "./types";

export function isFallowTuiMode(mode: FallowRunMode): boolean {
	return mode === "tui";
}

export function hasFallowNavigator(mode: FallowRunMode, overview: FallowOverview | undefined): boolean {
	if (!isFallowTuiMode(mode)) return false;
	return !!overview?.sections.some((section) => section.items.length > 0);
}
