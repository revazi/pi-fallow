import { needsFallowBaseDetection } from "./args";
import type { FallowCommandState } from "./types";

export type FallowBaseRefDetector = (cwd: string) => Promise<string | undefined>;

export async function resolveFallowCommandBaseRef(
	rawArgs: string[],
	cwd: string,
	state: FallowCommandState,
	detectBaseRef: FallowBaseRefDetector,
): Promise<string> {
	if (!needsFallowBaseDetection(rawArgs)) return "main";
	const cached = state.baseRefs.get(cwd);
	if (cached) return cached;
	const detected = await detectBaseRef(cwd) ?? "main";
	state.baseRefs.set(cwd, detected);
	return detected;
}
