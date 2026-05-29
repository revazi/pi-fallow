import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { FallowOverview } from "./types";

export class FallowOverviewComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private overview: FallowOverview,
		private theme: any,
		private options: { expanded?: boolean; command?: string; fullOutputPath?: string; truncated?: boolean } = {},
	) {}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const theme = this.theme;
		const lines: string[] = [];
		const statusIcon = this.overview.status === "success" ? "✓" : this.overview.status === "error" ? "✗" : "●";
		const statusColor = this.overview.status === "success" ? "success" : this.overview.status === "error" ? "error" : "warning";
		lines.push(truncateToWidth(`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", theme.bold(this.overview.title))}`, width));

		if (this.overview.stats.length) {
			const statLine = this.overview.stats.slice(0, this.options.expanded ? 10 : 6)
				.map((stat) => `${theme.fg("muted", stat.label)} ${theme.fg("accent", String(stat.value))}`)
				.join(theme.fg("dim", " · "));
			lines.push(...wrapTextWithAnsi(statLine, Math.max(10, width)));
		}

		const maxSections = this.options.expanded ? this.overview.sections.length : Math.min(this.overview.sections.length, 4);
		for (const section of this.overview.sections.slice(0, maxSections)) {
			const color = section.color ?? "accent";
			const count = section.count !== undefined ? theme.fg("dim", ` (${section.count})`) : "";
			lines.push(truncateToWidth(`  ${theme.fg(color, theme.bold(section.title))}${count}`, width));
			const maxItems = this.options.expanded ? 8 : 3;
			for (const item of section.items.slice(0, maxItems)) {
				const loc = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : undefined;
				const main = [theme.fg("text", item.label), loc ? theme.fg("muted", loc) : undefined, item.meta ? theme.fg("dim", item.meta) : undefined]
					.filter(Boolean)
					.join(theme.fg("dim", " · "));
				lines.push(truncateToWidth(`    • ${main}`, width));
				if (this.options.expanded && item.action) {
					for (const wrapped of wrapTextWithAnsi(theme.fg("dim", `      ↳ ${item.action}`), Math.max(10, width))) {
						lines.push(wrapped);
					}
				}
			}
			if (section.items.length > maxItems) {
				lines.push(truncateToWidth(theme.fg("dim", `    … ${section.items.length - maxItems} more shown in JSON output`), width));
			}
		}
		if (this.overview.sections.length > maxSections) {
			lines.push(truncateToWidth(theme.fg("dim", `  … ${this.overview.sections.length - maxSections} more sections`), width));
		}

		for (const note of this.overview.notes.slice(0, this.options.expanded ? 5 : 2)) {
			lines.push(...wrapTextWithAnsi(theme.fg("dim", `  ${note}`), Math.max(10, width)));
		}
		if (this.options.expanded && this.options.command) lines.push(truncateToWidth(theme.fg("muted", this.options.command), width));
		if (this.options.fullOutputPath) lines.push(truncateToWidth(theme.fg("dim", `Full JSON: ${this.options.fullOutputPath}`), width));
		if (this.options.truncated) lines.push(truncateToWidth(theme.fg("warning", "JSON output was truncated for context."), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
