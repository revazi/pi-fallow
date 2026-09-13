import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCompletions } from "./autocomplete";
import { fallowCli } from "./cli";
import type { FallowCommandState } from "./command/types";
import { resetFallowHistory } from "./history";
import { scheduleFallowUpdateNotice } from "./update-notice";

const FALLOW_PREFERENCES_ENTRY = "pi-fallow-preferences";

export function registerFallowSessionStart(pi: ExtensionAPI, commandState?: FallowCommandState): void {
	pi.on("session_start", (_event, ctx) => {
		fallowCli.clearRunnerCache(pi);
		if (commandState) {
			resetFallowHistory(commandState.history);
			restoreFallowPreferences(commandState, ctx.sessionManager.getBranch());
		}
		if (ctx.mode !== "tui") return;
		void fallowCompletions.preloadGitReferences(pi, ctx.cwd);
		scheduleFallowUpdateNotice(pi, ctx);
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const slashPrefix = getFallowSlashPrefix(lines, cursorLine, cursorCol);
				if (isFallowCommandPrefix(slashPrefix)) {
					return { prefix: slashPrefix, items: fallowCompletions.getFallowRootCommandCompletions() };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const slashPrefix = getFallowSlashPrefix(lines, cursorLine, cursorCol);
				if (isFallowCommandPrefix(slashPrefix)) return true;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}

export function persistSimilarCodeCachePreference(pi: ExtensionAPI, state: FallowCommandState, enabled: boolean): void {
	if (state.similarCodeReuseCache === enabled) return;
	state.similarCodeReuseCache = enabled;
	pi.appendEntry(FALLOW_PREFERENCES_ENTRY, { similarCodeReuseCache: enabled });
}

type SessionEntry = { type: string; customType?: string; data?: unknown };

function restoreFallowPreferences(state: FallowCommandState, entries: SessionEntry[]): void {
	const latest = entries.findLast(isFallowPreferencesEntry);
	state.similarCodeReuseCache = latest
		? (latest.data as { similarCodeReuseCache: boolean }).similarCodeReuseCache
		: false;
}

function isFallowPreferencesEntry(entry: SessionEntry): boolean {
	const value = (entry.data as { similarCodeReuseCache?: unknown } | undefined)?.similarCodeReuseCache;
	return entry.type === "custom" && entry.customType === FALLOW_PREFERENCES_ENTRY && typeof value === "boolean";
}

function getFallowSlashPrefix(lines: string[], cursorLine: number, cursorCol: number): string {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const slashIndex = beforeCursor.lastIndexOf("/");
	return slashIndex >= 0 ? beforeCursor.slice(slashIndex) : "";
}

function isFallowCommandPrefix(prefix: string): boolean {
	return /^\/fallow\s+$/.test(prefix);
}
