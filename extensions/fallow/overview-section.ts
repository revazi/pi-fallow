import type { FallowIssueLine, FallowOverviewSection } from "./types";

export function appendContextSection(
	sections: FallowOverviewSection[],
	title: string,
	entries: unknown[],
	includeAllRaw: boolean,
	inlineRawLimit: number,
	buildItem: (entry: unknown, includeRaw: boolean) => FallowIssueLine,
): void {
	if (!entries.length) return;
	sections.push({
		title,
		count: entries.length,
		color: "accent",
		role: "context",
		items: entries.map((entry, index) => buildItem(entry, includeAllRaw || index < inlineRawLimit)),
	});
}
