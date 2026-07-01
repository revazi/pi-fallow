import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderFallowProjectState } from "../project/render";
import { renderFallowPrSummary } from "../pr-summary/render";
import type { FallowIssueLine, FallowNavigatorResult, FallowOverview, FallowOverviewSection, FallowPrSummary, FallowProjectState } from "../types";
import { amber, cyan, getOverviewStatusColor, pill, pink, purple, violet } from "./shared";

const MIN_NAVIGATOR_WIDTH = 50;
const FRAME_BORDER_WIDTH = 4;
const HEADER_BORDER_WIDTH = 2;
const VISIBLE_ISSUE_ROWS = 10;

function buildHeaderTitle(issueCount: number, title: string, status: FallowOverview["status"], theme: any): string {
	const statusColor = getOverviewStatusColor(status);
	const findingText = `${issueCount} finding${issueCount === 1 ? "" : "s"}`;
	return `${purple(" ✦ ")}${theme.fg(statusColor, theme.bold(title))}${theme.fg("dim", " · ")}${pill(findingText, issueCount ? pink : cyan)} `;
}

interface FlatIssue {
	section: FallowOverviewSection;
	item: FallowIssueLine;
	sectionIndex: number;
	itemIndex: number;
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
		private options: { command?: string; fullOutputPath?: string; truncated?: boolean; projectState?: FallowProjectState; prSummary?: FallowPrSummary } = {},
	) {
		this.issues = overview.sections.flatMap((section, sectionIndex) =>
			section.items.map((item, itemIndex) => ({ section, item, sectionIndex, itemIndex })),
		);
	}

	preferredWidth(maxWidth: number): number {
		const boundedMax = normalizeMaxWidth(maxWidth);
		const measuredWidth = Math.max(MIN_NAVIGATOR_WIDTH, this.measurePreferredWidth());
		return Math.min(measuredWidth, boundedMax);
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
				action: () => this.toggleExpanded() },
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
		const frameWidth = Math.max(FRAME_BORDER_WIDTH, width);
		const innerWidth = Math.max(1, frameWidth - FRAME_BORDER_WIDTH);
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
		const issueCount = this.issues.length;
		const title = buildHeaderTitle(issueCount, this.overview.title, this.overview.status, this.theme);
		lines.push(this.topBorder(frameWidth, title));
		lines.push(...this.statLines(innerWidth).map((line) => this.frame(line, frameWidth)));
		lines.push(this.frame(this.helpLine(), frameWidth));
		lines.push(this.separator(frameWidth));
	}

	private renderIssues(frameWidth: number, innerWidth: number, lines: string[]): void {
		const listHeight = VISIBLE_ISSUE_ROWS;
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
			rows.push(...this.renderIssueRowsSectionHeader(entry, index, lastSection));
			if (entry.sectionIndex !== lastSection) {
				lastSection = entry.sectionIndex;
			}
			rows.push(this.issueLine(index, innerWidth));
			if (this.expanded.has(index)) rows.push(...this.detailLines(entry, innerWidth));
		}
		return rows;
	}

	private renderIssueRowsSectionHeader(entry: FlatIssue, index: number, lastSection: number): string[] {
		if (entry.sectionIndex === lastSection) return [];
		return [this.sectionHeaderLine(entry)];
	}

	private sectionHeaderLine(entry: FlatIssue): string {
		const count = entry.section.count !== undefined ? this.theme.fg("dim", ` (${entry.section.count})`) : "";
		return `  ${violet("●")} ${this.theme.fg(entry.section.color ?? "accent", this.theme.bold(entry.section.title))}${count}`;
	}

	private renderFooter(frameWidth: number, lines: string[]): void {
		lines.push(this.separator(frameWidth));
		lines.push(this.frame(this.footerSelectionLine(), frameWidth));
		this.renderFooterSummaryBlocks(frameWidth, lines);
		this.renderFooterMeta(frameWidth, lines);
	}

	private footerSelectionLine(): string {
		return `${pill(`${this.selection().length} selected`, purple)} ${this.theme.fg("muted", "e/a loads prompt into editor for your comments")}`;
	}

	private renderFooterSummaryBlocks(frameWidth: number, lines: string[]): void {
		for (const line of this.summaryBlockLines()) {
			lines.push(this.frame(line, frameWidth));
		}
	}

	private summaryBlockLines(): string[] {
		return [
			renderFallowPrSummary(this.options.prSummary, this.theme),
			renderFallowProjectState(this.options.projectState, this.theme),
		].filter(Boolean).flatMap((summary) => summary.split("\n"));
	}

	private renderFooterMeta(frameWidth: number, lines: string[]): void {
		for (const line of this.footerMetaLines()) {
			lines.push(this.frame(line, frameWidth));
		}
	}

	private footerMetaLines(): string[] {
		return [
			`${pink("Contribute")} ${this.theme.fg("muted", "Ideas, issues, and PRs are welcome: https://github.com/revazi/pi-fallow")}`,
			this.options.fullOutputPath ? `${cyan("Full JSON")} ${this.theme.fg("dim", this.options.fullOutputPath)}` : undefined,
			this.options.command ? `${violet("Command")} ${this.theme.fg("muted", this.options.command)}` : undefined,
		].filter(Boolean) as string[];
	}

	private measurePreferredWidth(): number {
		const issueCount = this.issues.length;
		const headerTitle = buildHeaderTitle(issueCount, this.overview.title, this.overview.status, this.theme);
		const frameCandidates = [
			...this.preferredHeaderLines(),
			...this.preferredIssueLines(),
			this.footerSelectionLine(),
			...this.summaryBlockLines(),
			...this.footerMetaLines(),
		];
		const contentWidth = Math.max(0, ...frameCandidates.map((line) => visibleWidth(line)));
		return Math.max(visibleWidth(headerTitle) + HEADER_BORDER_WIDTH, contentWidth + FRAME_BORDER_WIDTH);
	}

	private preferredHeaderLines(): string[] {
		return [this.statLine(), this.helpLine()].filter(Boolean) as string[];
	}

	private preferredIssueLines(): string[] {
		if (!this.issues.length) return [this.theme.fg("success", "No navigable findings in this Fallow report.")];
		return this.visibleIssueEntries().flatMap((entry, index, entries) => this.preferredIssueEntryLines(entry, index, entries));
	}

	private visibleIssueEntries(): FlatIssue[] {
		return this.issues.slice(0, VISIBLE_ISSUE_ROWS);
	}

	private preferredIssueEntryLines(entry: FlatIssue, index: number, entries: FlatIssue[]): string[] {
		return [
			...this.preferredSectionHeaderLines(entry, index, entries),
			this.issueLineRaw(index),
			...this.preferredActionLines(entry.item),
		];
	}

	private preferredSectionHeaderLines(entry: FlatIssue, index: number, entries: FlatIssue[]): string[] {
		return entries[index - 1]?.sectionIndex === entry.sectionIndex ? [] : [this.sectionHeaderLine(entry)];
	}

	private preferredActionLines(item: FallowIssueLine): string[] {
		return item.action ? [this.detailActionLine(item)] : [];
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

	private toggleExpanded(): void {
		if (!this.hasExpandableDetails(this.selected)) return;
		if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
		else {
			this.expanded.clear();
			this.expanded.add(this.selected);
		}
		this.changed();
	}

	private hasExpandableDetails(index: number): boolean {
		return !!this.issues[index]?.item.action;
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
		const pathWithLine = pickPathFromText(action, /(?:^|\s)([^\s"'`]+?\.[A-Za-z0-9_./+-]+:\d+)(?:\s|$)/);
		if (pathWithLine) return this.stripTraceSuffix(pathWithLine);
		const barePath = pickPathFromText(action, /(?:^|\s)([^\s"'`]+?\.[A-Za-z0-9_./+-]+)(?:\s|$)/);
		return barePath ? this.stripTraceSuffix(barePath) : null;
	}


	private stripTraceSuffix(path: string): string {
		return path
			.replace(/[\]\)>,.;:!?]+$/u, "")
			.replace(/:\d+$/, "");
	}

	private buildPrompt(issues: FlatIssue[]): string {
		const blocks = issues.map((entry, index) => this.buildIssuePromptBlock(entry, index)).join("\n\n");
		const sections = [
			"Please work on the following selected Fallow findings.",
			"",
			"Additional instructions from user:",
			"<!-- Add your comments here before submitting to Pi. -->",
			"",
			"Default task: For each finding, inspect the referenced code, decide whether to fix, refactor, delete, add tests, or suppress intentionally, then make the appropriate changes. After changes, rerun the relevant Fallow command to verify.",
			this.options.command ? `Fallow command: ${this.options.command}` : undefined,
			"",
			blocks,
		];
		return sections.filter((part) => part !== undefined).join("\n");
	}

	private buildIssuePromptBlock(entry: FlatIssue, index: number): string {
		const item = entry.item;
		const lines: string[] = [
			`## ${index + 1}. ${entry.section.title}: ${item.label}`,
			this.buildIssueLocationLine(item),
			...this.buildIssueMetaLines(item),
			...this.buildIssueActionLines(item),
			...this.buildIssueRawLines(item),
		];
		return lines.join("\n");
	}

	private buildIssueLocationLine(item: FallowIssueLine): string {
		const location = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : "unknown location";
		return `Location: ${location}`;
	}

	private buildIssueMetaLines(item: FallowIssueLine): string[] {
		if (!item.meta) return [];
		return [`Details: ${item.meta}`];
	}

	private buildIssueActionLines(item: FallowIssueLine): string[] {
		if (!item.action) return [];
		return [`Suggested action: ${item.action}`];
	}

	private buildIssueRawLines(item: FallowIssueLine): string[] {
		if (item.raw === undefined) return [];
		return [
			"Raw finding:",
			"```json",
			this.safeJson(item.raw, 3000),
			"```",
		];
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
		const statLine = this.statLine();
		return statLine ? wrapTextWithAnsi(statLine, width) : [];
	}

	private statLine(): string | undefined {
		if (!this.overview.stats.length) return undefined;
		const colors = [purple, cyan, amber, pink, violet];
		return this.overview.stats.slice(0, 8)
			.map((stat, index) => `${colors[index % colors.length]!("◆")} ${this.theme.fg("muted", stat.label)} ${this.theme.fg("accent", this.theme.bold(String(stat.value)))}`)
			.join(this.theme.fg("dim", "   "));
	}

	private helpLine(): string {
		const key = (text: string) => pill(text, violet);
		return `${key("↑↓/jk")} ${this.theme.fg("muted", "navigate")}  ${key("enter")} ${this.theme.fg("muted", "expand")}  ${key("s")} ${this.theme.fg("muted", "select")}  ${key("e/a")} ${this.theme.fg("muted", "load")}  ${key("t")} ${this.theme.fg("muted", "trace")}  ${key("q")} ${this.theme.fg("muted", "close")}`;
	}

	private issueLine(index: number, width: number): string {
		const raw = this.issueLineRaw(index);
		return truncateToWidth(this.selected === index ? this.theme.bg("selectedBg", raw) : raw, width);
	}

	private issueLineRaw(index: number): string {
		const entry = this.issues[index]!;
		const marker = this.issueLineMarker(index);
		const check = this.issueLineCheck(index);
		const expandMarker = this.issueExpandMarker(index);
		const main = this.buildIssueLineMain(entry);
		return `    ${marker} ${check} ${expandMarker} ${main}`;
	}

	private buildIssueLineMain(entry: FlatIssue): string {
		const loc = this.getIssueLineLocation(entry.item);
		return [
			this.theme.fg("text", entry.item.label),
			loc,
			entry.item.meta ? this.theme.fg("dim", entry.item.meta) : undefined,
		].filter(Boolean).join(this.theme.fg("dim", " · "));
	}

	private getIssueLineLocation(item: FallowIssueLine): string | undefined {
		if (!item.path) return undefined;
		const path = item.line ? `${item.path}:${item.line}` : item.path;
		return cyan(path);
	}

	private issueLineMarker(index: number): string {
		return index === this.selected ? purple("❯") : this.theme.fg("dim", " ");
	}

	private issueLineCheck(index: number): string {
		return this.marked.has(index) ? this.theme.fg("success", "☑") : this.theme.fg("dim", "☐");
	}

	private issueExpandMarker(index: number): string {
		if (!this.hasExpandableDetails(index)) return this.theme.fg("dim", "·");
		return this.expanded.has(index) ? amber("▾") : violet("▸");
	}

	private detailLines(entry: FlatIssue, width: number): string[] {
		return this.buildDetailActionLines(entry.item, width);
	}

	private buildDetailActionLines(item: FallowIssueLine, width: number): string[] {
		if (!item.action) return [];
		return wrapTextWithAnsi(this.detailActionLine(item), width);
	}

	private detailActionLine(item: FallowIssueLine): string {
		return `${amber("      ↳")} ${this.theme.fg("muted", item.action ?? "")}`;
	}

	private topBorder(width: number, title: string): string {
		const clippedTitle = truncateToWidth(title, Math.max(0, width - HEADER_BORDER_WIDTH));
		const titleWidth = visibleWidth(clippedTitle);
		const fill = Math.max(0, width - titleWidth - HEADER_BORDER_WIDTH);
		return purple("╭") + clippedTitle + purple("─".repeat(fill) + "╮");
	}

	private separator(width: number): string {
		return purple("├" + "─".repeat(Math.max(0, width - 2)) + "┤");
	}

	private bottomBorder(width: number): string {
		return purple("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
	}

	private frame(content: string, width: number): string {
		const innerWidth = Math.max(0, width - FRAME_BORDER_WIDTH);
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

function pickPathFromText(text: string, pattern: RegExp): string | null {
	const match = text.match(pattern);
	return match?.[1] ?? null;
}

function normalizeMaxWidth(maxWidth: number): number {
	if (!Number.isFinite(maxWidth)) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor(maxWidth));
}
