import type { FallowOverview } from "../types";
import { resolveFallowNavigatorMode } from "./navigator";
import type { FallowRunMode } from "./types";

export function isFallowTuiMode(mode: FallowRunMode): boolean {
	return mode === "tui";
}

export function hasFallowNavigator(mode: FallowRunMode, overview: FallowOverview | undefined): boolean {
	if (!isFallowTuiMode(mode)) return false;
	return resolveFallowNavigatorMode(overview) !== "none";
}
