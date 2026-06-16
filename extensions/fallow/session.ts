import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallowCompletions } from "./autocomplete";
import { setFallowReadyStatus } from "./status";

export function registerFallowSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void setFallowReadyStatus(ctx);
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

function getFallowSlashPrefix(lines: string[], cursorLine: number, cursorCol: number): string {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const slashIndex = beforeCursor.lastIndexOf("/");
	return slashIndex >= 0 ? beforeCursor.slice(slashIndex) : "";
}

function isFallowCommandPrefix(prefix: string): boolean {
	return /^\/fallow\s+$/.test(prefix);
}
