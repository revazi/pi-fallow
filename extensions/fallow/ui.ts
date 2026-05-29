import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection } from "./types";

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

interface FlatIssue {
	section: FallowOverviewSection;
	item: FallowIssueLine;
	sectionIndex: number;
	itemIndex: number;
}

export interface FallowNavigatorResult {
	action: "ask" | "editor";
	prompt: string;
	issueCount: number;
}

export class FallowIssueNavigator implements Component {
	private issues: FlatIssue[];
	private selected = 0;
	private scrollStart = 0;
	private expanded = new Set<number>();
	private marked = new Set<number>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private overview: FallowOverview,
		private theme: any,
		private onDone: (result: FallowNavigatorResult | null) => void,
		private requestRender: () => void,
		private options: { command?: string; fullOutputPath?: string; truncated?: boolean } = {},
	) {
		this.issues = overview.sections.flatMap((section, sectionIndex) =>
			section.items.map((item, itemIndex) => ({ section, item, sectionIndex, itemIndex })),
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") return this.onDone(null);
		if (matchesKey(data, "up") || data === "k") return this.move(-1);
		if (matchesKey(data, "down") || data === "j") return this.move(1);
		if (matchesKey(data, "home")) return this.select(0);
		if (matchesKey(data, "end")) return this.select(this.issues.length - 1);
		if (data === "s" || matchesKey(data, "tab")) return this.toggleMarked();
		if (data === "e") return this.onDone(this.buildResult("editor"));
		if (data === "a") return this.onDone(this.buildResult("ask"));
		if (matchesKey(data, "enter") || matchesKey(data, "space") || matchesKey(data, "right") || data === "l") {
			if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
			else {
				this.expanded.clear();
				this.expanded.add(this.selected);
			}
			return this.changed();
		}
		if (matchesKey(data, "left") || data === "h") {
			this.expanded.delete(this.selected);
			return this.changed();
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const frameWidth = Math.max(50, width);
		const innerWidth = Math.max(10, frameWidth - 4);
		const theme = this.theme;
		const lines: string[] = [];
		const statusColor = this.overview.status === "success" ? "success" : this.overview.status === "error" ? "error" : "warning";

		lines.push(this.topBorder(frameWidth, theme.fg(statusColor, theme.bold(` ${this.overview.title} `))));
		for (const statLine of this.statLines(innerWidth)) lines.push(this.frame(statLine, frameWidth));
		lines.push(this.frame(theme.fg("dim", "↑↓/jk navigate · enter expand · s select · e editor · a ask Pi · q close"), frameWidth));
		lines.push(this.separator(frameWidth));

		if (!this.issues.length) {
			lines.push(this.frame(theme.fg("success", "No navigable findings in this Fallow report."), frameWidth));
			lines.push(this.bottomBorder(frameWidth));
			return this.cache(width, lines);
		}

		const listHeight = 10;
		this.ensureVisible(listHeight);
		const start = this.scrollStart;
		const end = Math.min(this.issues.length, start + listHeight);
		if (start > 0) lines.push(this.frame(theme.fg("dim", `… ${start} earlier findings`), frameWidth));

		let lastSection = -1;
		for (let index = start; index < end; index++) {
			const entry = this.issues[index]!;
			if (entry.sectionIndex !== lastSection) {
				lastSection = entry.sectionIndex;
				const count = entry.section.count !== undefined ? theme.fg("dim", ` (${entry.section.count})`) : "";
				lines.push(this.frame(`  ${theme.fg(entry.section.color ?? "accent", theme.bold(entry.section.title))}${count}`, frameWidth));
			}
			lines.push(this.frame(this.issueLine(index, innerWidth), frameWidth));
			if (this.expanded.has(index)) {
				for (const detailLine of this.detailLines(entry, innerWidth)) {
					lines.push(this.frame(detailLine, frameWidth));
				}
			}
		}

		if (end < this.issues.length) lines.push(this.frame(theme.fg("dim", `… ${this.issues.length - end} later findings`), frameWidth));
		lines.push(this.separator(frameWidth));
		lines.push(this.frame(theme.fg("muted", `${this.selection().length} selected · e copies prompt to editor · a sends prompt to Pi now`), frameWidth));
		if (this.options.fullOutputPath) lines.push(this.frame(theme.fg("dim", `Full JSON: ${this.options.fullOutputPath}`), frameWidth));
		if (this.options.command) lines.push(this.frame(theme.fg("muted", this.options.command), frameWidth));
		lines.push(this.bottomBorder(frameWidth));

		return this.cache(width, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		this.selected = Math.max(0, Math.min(Math.max(0, this.issues.length - 1), index));
		this.changed();
	}

	private toggleMarked(): void {
		if (this.marked.has(this.selected)) this.marked.delete(this.selected);
		else this.marked.add(this.selected);
		this.changed();
	}

	private ensureVisible(listHeight: number): void {
		if (this.selected < this.scrollStart) this.scrollStart = this.selected;
		if (this.selected >= this.scrollStart + listHeight) this.scrollStart = this.selected - listHeight + 1;
		this.scrollStart = Math.max(0, Math.min(this.scrollStart, Math.max(0, this.issues.length - listHeight)));
	}

	private changed(): void {
		this.invalidate();
		this.requestRender();
	}

	private selection(): FlatIssue[] {
		const indices = this.marked.size ? [...this.marked].sort((a, b) => a - b) : [this.selected];
		return indices.map((index) => this.issues[index]).filter(Boolean) as FlatIssue[];
	}

	private buildResult(action: "ask" | "editor"): FallowNavigatorResult {
		const issues = this.selection();
		return { action, issueCount: issues.length, prompt: this.buildPrompt(issues) };
	}

	private buildPrompt(issues: FlatIssue[]): string {
		const blocks = issues.map((entry, index) => {
			const item = entry.item;
			const loc = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : "unknown location";
			const raw = item.raw === undefined ? "" : `\nRaw finding:\n\`\`\`json\n${this.safeJson(item.raw, 3000)}\n\`\`\``;
			return [
				`## ${index + 1}. ${entry.section.title}: ${item.label}`,
				`Location: ${loc}`,
				item.meta ? `Details: ${item.meta}` : undefined,
				item.action ? `Suggested action: ${item.action}` : undefined,
				raw || undefined,
			].filter(Boolean).join("\n");
		}).join("\n\n");

		return [
			"Please work on the following selected Fallow findings.",
			"For each finding: inspect the referenced code, decide whether to fix, refactor, delete, add tests, or suppress intentionally, then make the appropriate changes. After changes, rerun the relevant Fallow command to verify.",
			this.options.command ? `Fallow command: ${this.options.command}` : undefined,
			"",
			blocks,
		].filter((part) => part !== undefined).join("\n");
	}

	private safeJson(value: unknown, maxChars: number): string {
		let text: string;
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n… truncated …` : text;
	}

	private statLines(width: number): string[] {
		if (!this.overview.stats.length) return [];
		const statLine = this.overview.stats.slice(0, 8)
			.map((stat) => `${this.theme.fg("muted", stat.label)} ${this.theme.fg("accent", String(stat.value))}`)
			.join(this.theme.fg("dim", " · "));
		return wrapTextWithAnsi(statLine, width);
	}

	private issueLine(index: number, width: number): string {
		const entry = this.issues[index]!;
		const selected = index === this.selected;
		const expanded = this.expanded.has(index);
		const marker = selected ? "›" : " ";
		const check = this.marked.has(index) ? "☑" : "☐";
		const expandMarker = expanded ? "▾" : "▸";
		const loc = entry.item.path ? `${entry.item.path}${entry.item.line ? `:${entry.item.line}` : ""}` : undefined;
		const main = [entry.item.label, loc, entry.item.meta].filter(Boolean).join(" · ");
		const raw = `    ${marker} ${check} ${expandMarker} ${main}`;
		const styled = selected ? this.theme.bg("selectedBg", this.theme.fg("text", raw)) : this.theme.fg("text", raw);
		return truncateToWidth(styled, width);
	}

	private detailLines(entry: FlatIssue, width: number): string[] {
		const theme = this.theme;
		const item = entry.item;
		const lines: string[] = [];
		if (item.action) lines.push(...wrapTextWithAnsi(theme.fg("dim", `      ↳ ${item.action}`), width));
		if (!item.action && item.path) lines.push(theme.fg("dim", `      ${item.path}${item.line ? `:${item.line}` : ""}`));
		return lines;
	}

	private topBorder(width: number, title: string): string {
		const titleWidth = visibleWidth(title);
		const fill = Math.max(0, width - titleWidth - 2);
		return this.theme.fg("border", "┌") + title + this.theme.fg("border", "─".repeat(fill) + "┐");
	}

	private separator(width: number): string {
		return this.theme.fg("border", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
	}

	private bottomBorder(width: number): string {
		return this.theme.fg("border", "└" + "─".repeat(Math.max(0, width - 2)) + "┘");
	}

	private frame(content: string, width: number): string {
		const innerWidth = Math.max(0, width - 4);
		const truncated = truncateToWidth(content, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		return this.theme.fg("border", "│ ") + truncated + padding + this.theme.fg("border", " │");
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
