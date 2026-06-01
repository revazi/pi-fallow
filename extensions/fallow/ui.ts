// fallow-ignore-file unused-export
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { formatFallowProjectState } from "./project";
import { formatFallowPrSummary } from "./pr-summary";
import { renderSummaryLines } from "./summary";
import type { FallowIssueLine, FallowOverview, FallowOverviewSection, FallowPrSummary, FallowProjectState } from "./types";

const ansi = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[39m`;
export const fallowPurple = (text: string) => ansi(141, text);
const purple = fallowPurple;
const violet = (text: string) => ansi(99, text);
const pink = (text: string) => ansi(213, text);
const cyan = (text: string) => ansi(81, text);
const amber = (text: string) => ansi(215, text);

function pill(text: string, color: (value: string) => string): string {
	return color(` ${text} `);
}

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
		if (this.options.expanded && this.options.command) lines.push(truncateToWidth(this.theme.fg("muted", this.options.command), width));
		if (this.options.fullOutputPath) lines.push(truncateToWidth(this.theme.fg("dim", `Full JSON: ${this.options.fullOutputPath}`), width));
		if (this.options.truncated) lines.push(truncateToWidth(this.theme.fg("warning", "JSON output was truncated for context."), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderTitle(width: number, lines: string[]): void {
		const theme = this.theme;
		const statusIcon = this.overview.status === "success" ? "✓" : this.overview.status === "error" ? "✗" : "●";
		const statusColor = this.overview.status === "success" ? "success" : this.overview.status === "error" ? "error" : "warning";
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
			const loc = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : undefined;
			const main = [
				this.theme.fg("text", item.label),
				loc ? this.theme.fg("muted", loc) : undefined,
				item.meta ? this.theme.fg("dim", item.meta) : undefined,
			]
				.filter(Boolean)
				.join(this.theme.fg("dim", " · "));
			lines.push(truncateToWidth(`    • ${main}`, width));
			if (!this.options.expanded || !item.action) continue;
			for (const wrapped of wrapTextWithAnsi(this.theme.fg("dim", `      ↳ ${item.action}`), Math.max(10, width))) {
				lines.push(wrapped);
			}
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
		const theme = this.theme;
		const summaryText = renderSummaryLines(formatFallowPrSummary(this.options.prSummary), theme);
		if (summaryText) {
			for (const line of summaryText.split("\n")) lines.push(truncateToWidth(line, width));
		}
		const projectStateText = renderSummaryLines(formatFallowProjectState(this.options.projectState), theme);
		if (projectStateText) {
			for (const line of projectStateText.split("\n")) lines.push(truncateToWidth(line, width));
		}
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

export type FallowNavigatorResult =
	| { type: "prompt"; prompt: string; issueCount: number }
	| { type: "trace"; commandArgs: string[] };

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
		private options: { command?: string; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } = {},
	) {
		this.issues = overview.sections.flatMap((section, sectionIndex) =>
			section.items.map((item, itemIndex) => ({ section, item, sectionIndex, itemIndex })),
		);
	}

	handleInput(data: string): void {
		const bindings: Array<{ matches: (value: string) => boolean; action: () => void }> = [
			{ matches: (value) => matchesKey(value, "escape") || value === "q", action: () => this.onDone(null) },
			{ matches: (value) => matchesKey(value, "up") || value === "k", action: () => this.move(-1) },
			{ matches: (value) => matchesKey(value, "down") || value === "j", action: () => this.move(1) },
			{ matches: (value) => matchesKey(value, "home"), action: () => this.select(0) },
			{ matches: (value) => matchesKey(value, "end"), action: () => this.select(this.issues.length - 1) },
			{ matches: (value) => value === "s" || matchesKey(value, "tab"), action: () => this.toggleMarked() },
			{ matches: (value) => value === "e" || value === "a", action: () => this.onDone(this.buildPromptResult()) },
			{ matches: (value) => value === "t", action: () => {
				const trace = this.currentTraceCandidate();
				if (!trace) return;
				this.onDone({ type: "trace", commandArgs: ["dead-code", "--trace-file", trace] });
			} },
			{ matches: (value) => matchesKey(value, "enter") || matchesKey(value, "space") || matchesKey(value, "right") || value === "l",
				action: () => {
				if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
				else {
					this.expanded.clear();
					this.expanded.add(this.selected);
				}
				this.changed();
			} },
			{ matches: (value) => matchesKey(value, "left") || value === "h", action: () => {
				this.expanded.delete(this.selected);
				this.changed();
			} },
		];

		for (const binding of bindings) {
			if (binding.matches(data)) {
				binding.action();
				return;
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const frameWidth = Math.max(50, width);
		const innerWidth = Math.max(10, frameWidth - 4);
		const lines: string[] = [];

		this.renderHeader(frameWidth, innerWidth, lines);
		if (!this.issues.length) {
			lines.push(this.frame(this.theme.fg("success", "No navigable findings in this Fallow report."), frameWidth));
			lines.push(this.bottomBorder(frameWidth));
			return this.cache(width, lines);
		}

		this.renderIssues(frameWidth, innerWidth, lines);
		this.renderFooter(frameWidth, lines);
		lines.push(this.bottomBorder(frameWidth));
		return this.cache(width, lines);
	}

	private renderHeader(frameWidth: number, innerWidth: number, lines: string[]): void {
		const theme = this.theme;
		const statusColor = this.overview.status === "success" ? "success" : this.overview.status === "error" ? "error" : "warning";
		const issueCount = this.issues.length;
		const title = `${purple(" ✦ ")}${theme.fg(statusColor, theme.bold(this.overview.title))}${theme.fg("dim", " · ")}${pill(`${issueCount} finding${issueCount === 1 ? "" : "s"}`, issueCount ? pink : cyan)} `;
		lines.push(this.topBorder(frameWidth, title));
		lines.push(...this.statLines(innerWidth).map((line) => this.frame(line, frameWidth)));
		lines.push(this.frame(this.helpLine(), frameWidth));
		lines.push(this.separator(frameWidth));
	}

	private renderIssues(frameWidth: number, innerWidth: number, lines: string[]): void {
		const listHeight = 10;
		this.ensureVisible(listHeight);
		const start = this.scrollStart;
		const end = Math.min(this.issues.length, start + listHeight);
		if (start > 0) lines.push(this.frame(this.theme.fg("dim", `… ${start} earlier findings`), frameWidth));

		for (const row of this.renderIssueRows(start, end, innerWidth)) {
			lines.push(this.frame(row, frameWidth));
		}
		if (end < this.issues.length) lines.push(this.frame(this.theme.fg("dim", `… ${this.issues.length - end} later findings`), frameWidth));
	}

	private renderIssueRows(start: number, end: number, innerWidth: number): string[] {
		const rows: string[] = [];
		let lastSection = -1;
		for (let index = start; index < end; index++) {
			const entry = this.issues[index]!;
			if (entry.sectionIndex !== lastSection) {
				lastSection = entry.sectionIndex;
				const count = entry.section.count !== undefined ? this.theme.fg("dim", ` (${entry.section.count})`) : "";
				rows.push(`  ${violet("●")} ${this.theme.fg(entry.section.color ?? "accent", this.theme.bold(entry.section.title))}${count}`);
			}
			rows.push(this.issueLine(index, innerWidth));
			if (this.expanded.has(index)) {
				rows.push(...this.detailLines(this.issues[index]!, innerWidth));
			}
		}
		return rows;
	}

	private renderFooter(frameWidth: number, lines: string[]): void {
		const theme = this.theme;
		lines.push(this.separator(frameWidth));
		lines.push(this.frame(`${pill(`${this.selection().length} selected`, purple)} ${theme.fg("muted", "e/a loads prompt into editor for your comments")}`, frameWidth));
		this.renderSummaryBlock(this.options.prSummary ? formatFallowPrSummary(this.options.prSummary) : undefined, theme, frameWidth, lines);
		this.renderSummaryBlock(this.options.projectState ? formatFallowProjectState(this.options.projectState) : undefined, theme, frameWidth, lines);
		if (this.options.fullOutputPath) lines.push(this.frame(`${cyan("Full JSON")} ${theme.fg("dim", this.options.fullOutputPath)}`, frameWidth));
		if (this.options.command) lines.push(this.frame(`${violet("Command")} ${theme.fg("muted", this.options.command)}`, frameWidth));
	}

	private renderSummaryBlock(summaryData: unknown, theme: any, frameWidth: number, lines: string[]): void {
		const summaryText = renderSummaryLines(summaryData, theme);
		if (!summaryText) return;
		for (const line of summaryText.split("\n")) {
			lines.push(this.frame(line, frameWidth));
		}
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

	private buildPromptResult(): FallowNavigatorResult {
		const issues = this.selection();
		return { type: "prompt", issueCount: issues.length, prompt: this.buildPrompt(issues) };
	}

	private currentTraceCandidate(): string | null {
		const selected = this.issues[this.selected];
		if (!selected) return null;
		const path = selected.item.path ? this.stripTraceSuffix(selected.item.path) : this.pathFromAction(selected.item.action);
		return path ?? null;
	}

	private pathFromAction(action: string | undefined): string | null {
		if (!action) return null;
		const pathWithLine = action.match(/(?:^|\s)([^\s"'`]+?\.[A-Za-z0-9_./+-]+:\d+)(?:\s|$)/);
		if (pathWithLine?.[1]) return this.stripTraceSuffix(pathWithLine[1]);
		const barePath = action.match(/(?:^|\s)([^\s"'`]+?\.[A-Za-z0-9_./+-]+)(?:\s|$)/);
		return barePath?.[1] ? this.stripTraceSuffix(barePath[1]) : null;
	}

	private stripTraceSuffix(path: string): string {
		return path
			.replace(/[\]\)>,.;:!?]+$/u, "")
			.replace(/:\d+$/, "");
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
			"",
			"Additional instructions from user:",
			"<!-- Add your comments here before submitting to Pi. -->",
			"",
			"Default task: For each finding, inspect the referenced code, decide whether to fix, refactor, delete, add tests, or suppress intentionally, then make the appropriate changes. After changes, rerun the relevant Fallow command to verify.",
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
		const colors = [purple, cyan, amber, pink, violet];
		const statLine = this.overview.stats.slice(0, 8)
			.map((stat, index) => `${colors[index % colors.length]!("◆")} ${this.theme.fg("muted", stat.label)} ${this.theme.fg("accent", this.theme.bold(String(stat.value)))}`)
			.join(this.theme.fg("dim", "   "));
		return wrapTextWithAnsi(statLine, width);
	}

	private helpLine(): string {
		const key = (text: string) => pill(text, violet);
		return `${key("↑↓/jk")} ${this.theme.fg("muted", "navigate")}  ${key("enter")} ${this.theme.fg("muted", "expand")}  ${key("s")} ${this.theme.fg("muted", "select")}  ${key("e/a")} ${this.theme.fg("muted", "load")}  ${key("t")} ${this.theme.fg("muted", "trace")}  ${key("q")} ${this.theme.fg("muted", "close")}`;
	}

	private issueLine(index: number, width: number): string {
		const entry = this.issues[index]!;
		const selected = index === this.selected;
		const expanded = this.expanded.has(index);
		const marker = selected ? purple("❯") : this.theme.fg("dim", " ");
		const check = this.marked.has(index) ? this.theme.fg("success", "☑") : this.theme.fg("dim", "☐");
		const expandMarker = expanded ? amber("▾") : violet("▸");
		const loc = entry.item.path ? `${entry.item.path}${entry.item.line ? `:${entry.item.line}` : ""}` : undefined;
		const main = [
			this.theme.fg("text", entry.item.label),
			loc ? cyan(loc) : undefined,
			entry.item.meta ? this.theme.fg("dim", entry.item.meta) : undefined,
		].filter(Boolean).join(this.theme.fg("dim", " · "));
		const raw = `    ${marker} ${check} ${expandMarker} ${main}`;
		const styled = selected ? this.theme.bg("selectedBg", raw) : raw;
		return truncateToWidth(styled, width);
	}

	private detailLines(entry: FlatIssue, width: number): string[] {
		const theme = this.theme;
		const item = entry.item;
		const lines: string[] = [];
		if (item.action) lines.push(...wrapTextWithAnsi(`${amber("      ↳")} ${theme.fg("muted", item.action)}`, width));
		if (!item.action && item.path) lines.push(`${cyan("      Location")} ${theme.fg("dim", `${item.path}${item.line ? `:${item.line}` : ""}`)}`);
		return lines;
	}

	private topBorder(width: number, title: string): string {
		const titleWidth = visibleWidth(title);
		const fill = Math.max(0, width - titleWidth - 2);
		return purple("╭") + title + purple("─".repeat(fill) + "╮");
	}

	private separator(width: number): string {
		return purple("├" + "─".repeat(Math.max(0, width - 2)) + "┤");
	}

	private bottomBorder(width: number): string {
		return purple("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
	}

	private frame(content: string, width: number): string {
		const innerWidth = Math.max(0, width - 4);
		const truncated = truncateToWidth(content, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		return purple("│ ") + truncated + padding + purple(" │");
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
