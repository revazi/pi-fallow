import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderFallowProjectState } from "../project/render";
import { renderFallowPrSummary } from "../pr-summary/render";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection, FallowPrSummary, FallowProjectState } from "../types";
import { getOverviewStatusColor } from "./shared";

export class FallowOverviewComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private overview: FallowOverview,
		private theme: any,
		private options: { expanded?: boolean; command?: string; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } = {},
	) {}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const lines: string[] = [];
		this.renderTitle(width, lines);
		this.renderStats(width, lines);
		this.renderSections(width, lines);
		this.renderNotes(width, lines);
		this.renderSummaryBlocks(width, lines);
		this.renderCommandSummary(width, lines);
		this.renderPathSummary(width, lines);
		this.renderTruncationWarning(width, lines);
		return this.cache(width, lines);
	}

	private renderCommandSummary(width: number, lines: string[]): void {
		if (!this.options.expanded || !this.options.command) return;
		lines.push(truncateToWidth(this.theme.fg("muted", this.options.command), width));
	}

	private renderPathSummary(width: number, lines: string[]): void {
		if (!this.options.fullOutputPath) return;
		lines.push(truncateToWidth(this.theme.fg("dim", `Full JSON: ${this.options.fullOutputPath}`), width));
	}

	private renderTruncationWarning(width: number, lines: string[]): void {
		if (!this.options.truncated) return;
		lines.push(truncateToWidth(this.theme.fg("warning", "JSON output was truncated for context."), width));
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}


	private renderTitle(width: number, lines: string[]): void {
		const theme = this.theme;
		const statusColor = getOverviewStatusColor(this.overview.status);
		const statusIcon = getOverviewStatusIcon(this.overview.status);
		lines.push(truncateToWidth(`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", theme.bold(this.overview.title))}`, width));
	}


	private renderStats(width: number, lines: string[]): void {
		if (!this.overview.stats.length) return;
		const statLine = this.overview.stats.slice(0, this.options.expanded ? 10 : 6)
			.map((stat) => `${this.theme.fg("muted", stat.label)} ${this.theme.fg("accent", String(stat.value))}`)
			.join(this.theme.fg("dim", " · "));
		lines.push(...wrapTextWithAnsi(statLine, Math.max(10, width)));
	}

	private renderSections(width: number, lines: string[]): void {
		const maxSections = this.options.expanded ? this.overview.sections.length : Math.min(this.overview.sections.length, 4);
		for (const section of this.overview.sections.slice(0, maxSections)) {
			this.renderSection(section, width, lines);
		}
		if (this.overview.sections.length > maxSections) {
			lines.push(truncateToWidth(this.theme.fg("dim", `  … ${this.overview.sections.length - maxSections} more sections`), width));
		}
	}

	private renderSection(section: FallowOverviewSection, width: number, lines: string[]): void {
		const maxItems = this.options.expanded ? 8 : 3;
		this.renderSectionHeader(section, width, lines);
		this.renderSectionItems(section, width, lines, maxItems);
		this.renderSectionOverflow(section, width, lines, maxItems);
	}

	private renderSectionHeader(section: FallowOverviewSection, width: number, lines: string[]): void {
		const theme = this.theme;
		const count = section.count !== undefined ? theme.fg("dim", ` (${section.count})`) : "";
		const titleColor = section.color ?? "accent";
		lines.push(truncateToWidth(`  ${theme.fg(titleColor, theme.bold(section.title))}${count}`, width));
	}

	private renderSectionItems(section: FallowOverviewSection, width: number, lines: string[], maxItems: number): void {
		for (const item of section.items.slice(0, maxItems)) {
			this.renderSectionItemLine(item, width, lines);
			this.renderSectionItemAction(item, width, lines);
		}
	}

	private renderSectionItemLine(item: FallowIssueLine, width: number, lines: string[]): void {
		const main = this.buildSectionItemLine(item);
		lines.push(truncateToWidth(`    • ${main}`, width));
	}

	private buildSectionItemLine(item: FallowIssueLine): string {
		const location = getItemLocation(item);
		const labels = [
			this.theme.fg("text", item.label),
			location ? this.theme.fg("muted", location) : undefined,
			item.meta ? this.theme.fg("dim", item.meta) : undefined,
		].filter(Boolean);
		return labels.join(this.theme.fg("dim", " · "));
	}

	private renderSectionItemAction(item: FallowIssueLine, width: number, lines: string[]): void {
		if (!this.options.expanded || !item.action) return;
		for (const wrapped of wrapTextWithAnsi(this.theme.fg("dim", `      ↳ ${item.action}`), Math.max(10, width))) {
			lines.push(wrapped);
		}
	}


	private renderSectionOverflow(section: FallowOverviewSection, width: number, lines: string[], maxItems: number): void {
		if (section.items.length <= maxItems) return;
		lines.push(truncateToWidth(this.theme.fg("dim", `    … ${section.items.length - maxItems} more shown in JSON output`), width));
	}

	private renderNotes(width: number, lines: string[]): void {
		for (const note of this.overview.notes.slice(0, this.options.expanded ? 5 : 2)) {
			lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `  ${note}`), Math.max(10, width)));
		}
	}

	private renderSummaryBlocks(width: number, lines: string[]): void {
		for (const summaryText of collectSummaryBlocks(this.options.prSummary, this.options.projectState, this.theme)) {
			for (const line of summaryText) {
				lines.push(truncateToWidth(line, width));
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function getOverviewStatusIcon(status: FallowOverview["status"]): string {
	if (status === "success") return "✓";
	if (status === "error") return "✗";
	return "●";
}

function getItemLocation(item: FallowIssueLine): string | undefined {
	if (!item.path) return undefined;
	return `${item.path}${item.line ? `:${item.line}` : ""}`;
}

function collectSummaryBlocks(prSummary: FallowPrSummary | undefined, projectState: FallowProjectState | undefined, theme: any): string[][] {
	const summaryText = renderFallowPrSummary(prSummary, theme);
	const projectStateText = renderFallowProjectState(projectState, theme);
	return [summaryText, projectStateText].filter(Boolean).map((text) => text.split("\n"));
}

