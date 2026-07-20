import { readFile } from "node:fs/promises";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { buildFallowOverview } from "../overview";
import { buildFallowPrompt, type FallowPromptDetail, type FallowPromptFinding } from "../prompt";
import { renderFallowProjectState } from "../project/render";
import { renderFallowPrSummary } from "../pr-summary/render";
import type { FallowIssueLine, FallowNavigatorResult, FallowOverview, FallowOverviewSection, FallowPrSummary, FallowProjectState } from "../types";
import { amber, cyan, getOverviewStatusColor, pill, pink, purple, violet } from "./shared";

const MIN_NAVIGATOR_WIDTH = 50;
const FRAME_BORDER_WIDTH = 4;
const HEADER_BORDER_WIDTH = 2;
const VISIBLE_ISSUE_ROWS = 10;
const SEVERITY_ORDER = ["critical", "high", "error", "medium", "warning", "low", "info", "unspecified"];

function buildHeaderTitle(visibleCount: number, totalCount: number, title: string, status: FallowOverview["status"], theme: any): string {
	const statusColor = getOverviewStatusColor(status);
	const count = visibleCount === totalCount ? `${totalCount}` : `${visibleCount}/${totalCount}`;
	const findingText = `${count} finding${totalCount === 1 ? "" : "s"}`;
	return `${purple(" ✦ ")}${theme.fg(statusColor, theme.bold(title))}${theme.fg("dim", " · ")}${pill(findingText, totalCount ? pink : cyan)} `;
}

interface FallowNavigatorOptions {
	command?: string;
	fullOutputPath?: string;
	truncated?: boolean;
	projectState?: FallowProjectState;
	prSummary?: FallowPrSummary;
	visibleRows?: number;
}

interface FlatIssue {
	id: number;
	section: FallowOverviewSection;
	item: FallowIssueLine;
	sectionIndex: number;
	itemIndex: number;
}

export class FallowIssueNavigator implements Component, Focusable {
	focused = false;
	private issues: FlatIssue[];
	private selected = 0;
	private scrollStart = 0;
	private expanded = new Set<number>();
	private marked = new Set<number>();
	private query = "";
	private editingSearch = false;
	private sectionFilter?: number;
	private severityFilter?: string;
	private includeFullDetails = false;
	private preparingPrompt = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private overview: FallowOverview,
		private theme: any,
		private onDone: (result: FallowNavigatorResult | null) => void,
		private requestRender: () => void,
		private options: FallowNavigatorOptions = {},
	) {
		this.issues = overview.sections
			.flatMap((section, sectionIndex) => section.items.map((item, itemIndex) => ({ section, item, sectionIndex, itemIndex })))
			.map((entry, id) => ({ ...entry, id }));
	}

	preferredWidth(maxWidth: number): number {
		const boundedMax = normalizeMaxWidth(maxWidth);
		const measuredWidth = Math.max(MIN_NAVIGATOR_WIDTH, this.measurePreferredWidth());
		return Math.min(measuredWidth, boundedMax);
	}

	handleInput(data: string): void {
		if (this.routeModalInput(data)) return;
		const bindings: Array<{ matches: (value: string) => boolean; action: () => void }> = [
			{ matches: (value) => matchesKey(value, "escape") || value === "q", action: () => this.onDone(null) },
			{ matches: (value) => matchesKey(value, "up") || value === "k", action: () => this.move(-1) },
			{ matches: (value) => matchesKey(value, "down") || value === "j", action: () => this.move(1) },
			{ matches: (value) => matchesKey(value, "home"), action: () => this.select(0) },
			{ matches: (value) => matchesKey(value, "end"), action: () => this.select(this.visibleIssues().length - 1) },
			{ matches: (value) => value === "/", action: () => this.startSearch() },
			{ matches: (value) => value === "f", action: () => this.cycleSectionFilter() },
			{ matches: (value) => value === "v", action: () => this.cycleSeverityFilter() },
			{ matches: (value) => value === "x", action: () => this.clearFilters() },
			{ matches: (value) => value === "s" || matchesKey(value, "tab"), action: () => this.toggleMarked() },
			{ matches: (value) => value === "A", action: () => this.toggleAllVisible() },
			{ matches: (value) => value === "c", action: () => this.clearMarked() },
			{ matches: (value) => value === "d", action: () => this.togglePromptDetail() },
			{ matches: (value) => value === "e" || value === "a", action: () => this.finishWithPrompt() },
			{ matches: (value) => value === "t", action: () => this.finishWithTrace() },
			{ matches: (value) => matchesKey(value, "enter") || matchesKey(value, "space") || matchesKey(value, "right") || value === "l", action: () => this.toggleExpanded() },
			{ matches: (value) => matchesKey(value, "left") || value === "h", action: () => this.collapseCurrent() },
		];
		for (const binding of bindings) {
			if (!binding.matches(data)) continue;
			binding.action();
			return;
		}
	}

	private routeModalInput(data: string): boolean {
		if (this.preparingPrompt) return true;
		if (!this.editingSearch) return false;
		this.handleSearchInput(data);
		return true;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const frameWidth = Math.max(FRAME_BORDER_WIDTH, width);
		const innerWidth = Math.max(1, frameWidth - FRAME_BORDER_WIDTH);
		const visible = this.visibleIssues();
		const lines: string[] = [];

		this.renderHeader(frameWidth, innerWidth, visible.length, lines);
		this.renderBody(frameWidth, innerWidth, visible, lines);
		this.renderFooter(frameWidth, lines);
		lines.push(this.bottomBorder(frameWidth));
		return this.cache(width, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private handleSearchInput(data: string): void {
		const control = this.searchControl(data);
		if (control) {
			control();
			return;
		}
		if (!isPrintableCharacter(data)) return;
		this.query += data;
		this.filtersChanged();
	}

	private searchControl(data: string): (() => void) | undefined {
		const controls: Array<[string, () => void]> = [
			["escape", () => this.cancelSearch()],
			["enter", () => this.acceptSearch()],
			["backspace", () => this.updateSearch(removeLastCharacter(this.query))],
			["ctrl+u", () => this.updateSearch("")],
		];
		return controls.find(([key]) => matchesKey(data, key))?.[1];
	}

	private cancelSearch(): void {
		this.query = "";
		this.editingSearch = false;
		this.filtersChanged();
	}

	private acceptSearch(): void {
		this.editingSearch = false;
		this.changed();
	}

	private updateSearch(query: string): void {
		this.query = query;
		this.filtersChanged();
	}

	private startSearch(): void {
		this.editingSearch = true;
		this.changed();
	}

	private cycleSectionFilter(): void {
		const options: Array<number | undefined> = [undefined, ...new Set(this.issues.map((issue) => issue.sectionIndex))];
		this.sectionFilter = nextOption(options, this.sectionFilter);
		this.filtersChanged();
	}

	private cycleSeverityFilter(): void {
		const severities = [...new Set(this.issues.map((issue) => issueSeverity(issue)))].sort(compareSeverities);
		this.severityFilter = nextOption([undefined, ...severities], this.severityFilter);
		this.filtersChanged();
	}

	private clearFilters(): void {
		this.query = "";
		this.sectionFilter = undefined;
		this.severityFilter = undefined;
		this.editingSearch = false;
		this.filtersChanged();
	}

	private renderHeader(frameWidth: number, innerWidth: number, visibleCount: number, lines: string[]): void {
		const title = buildHeaderTitle(visibleCount, this.issues.length, this.overview.title, this.overview.status, this.theme);
		lines.push(this.topBorder(frameWidth, title));
		lines.push(...this.statLines(innerWidth).map((line) => this.frame(line, frameWidth)));
		for (const line of this.filterLines(innerWidth)) lines.push(this.frame(line, frameWidth));
		for (const line of wrapTextWithAnsi(this.helpLine(), innerWidth)) lines.push(this.frame(line, frameWidth));
		lines.push(this.separator(frameWidth));
	}

	private filterLines(width: number): string[] {
		if (!this.hasActiveFilters() && !this.editingSearch) return [];
		return wrapTextWithAnsi(this.filterLine(), width);
	}

	private filterLine(): string {
		const parts = [this.searchFilterLabel(), this.sectionFilterLabel(), this.severityFilterLabel()].filter(Boolean);
		return `${cyan("Filter")} ${this.theme.fg("muted", parts.join(" · "))}`;
	}

	private searchFilterLabel(): string | undefined {
		return this.editingSearch || this.query ? this.searchStatus() : undefined;
	}

	private sectionFilterLabel(): string | undefined {
		if (this.sectionFilter === undefined) return undefined;
		const title = this.overview.sections[this.sectionFilter]?.title ?? "unknown";
		return `section: ${title}`;
	}

	private severityFilterLabel(): string | undefined {
		return this.severityFilter ? `severity: ${this.severityFilter}` : undefined;
	}

	private searchStatus(): string {
		const cursor = this.editingSearch ? `${this.focused ? CURSOR_MARKER : ""}${this.theme.fg("accent", "▌")}` : "";
		return `search: ${this.query}${cursor}`;
	}

	private hasActiveFilters(): boolean {
		return !!this.query || this.sectionFilter !== undefined || !!this.severityFilter;
	}

	private renderBody(frameWidth: number, innerWidth: number, visible: FlatIssue[], lines: string[]): void {
		if (!this.issues.length) {
			lines.push(this.frame(this.theme.fg("success", "No navigable findings in this Fallow report."), frameWidth));
			return;
		}
		if (!visible.length) {
			lines.push(this.frame(this.theme.fg("warning", "No findings match the active filters."), frameWidth));
			return;
		}
		this.renderIssues(frameWidth, innerWidth, visible, lines);
	}

	private renderIssues(frameWidth: number, innerWidth: number, visible: FlatIssue[], lines: string[]): void {
		const visibleRows = this.visibleRowCount();
		this.ensureVisible(visibleRows, visible.length);
		const start = this.scrollStart;
		const end = Math.min(visible.length, start + visibleRows);
		if (start > 0) lines.push(this.frame(this.theme.fg("dim", `… ${start} earlier findings`), frameWidth));
		for (const row of this.renderIssueRows(start, end, innerWidth, visible)) lines.push(this.frame(row, frameWidth));
		if (end < visible.length) lines.push(this.frame(this.theme.fg("dim", `… ${visible.length - end} later findings`), frameWidth));
	}

	private renderIssueRows(start: number, end: number, innerWidth: number, visible: FlatIssue[]): string[] {
		const rows: string[] = [];
		let lastSection = -1;
		for (let index = start; index < end; index++) {
			const entry = visible[index]!;
			if (entry.sectionIndex !== lastSection) {
				rows.push(this.sectionHeaderLine(entry));
				lastSection = entry.sectionIndex;
			}
			rows.push(this.issueLine(entry, index, innerWidth));
			if (this.expanded.has(entry.id)) rows.push(...this.detailLines(entry, innerWidth));
		}
		return rows;
	}

	private sectionHeaderLine(entry: FlatIssue): string {
		const count = entry.section.count !== undefined ? this.theme.fg("dim", ` (${entry.section.count})`) : "";
		return `  ${violet("●")} ${this.theme.fg(entry.section.color ?? "accent", this.theme.bold(entry.section.title))}${count}`;
	}

	private renderFooter(frameWidth: number, lines: string[]): void {
		lines.push(this.separator(frameWidth));
		lines.push(this.frame(this.footerSelectionLine(), frameWidth));
		lines.push(this.frame(this.promptDetailLine(), frameWidth));
		const innerWidth = Math.max(1, frameWidth - FRAME_BORDER_WIDTH);
		for (const line of wrapTextWithAnsi(this.promptImplicationLine(), innerWidth)) lines.push(this.frame(line, frameWidth));
		for (const line of this.summaryBlockLines()) lines.push(this.frame(line, frameWidth));
		for (const line of this.footerMetaLines()) lines.push(this.frame(line, frameWidth));
	}

	private footerSelectionLine(): string {
		return `${pill(this.selectionStatus(), purple)} ${this.theme.fg("muted", "e/a loads prompt into editor for your comments")}`;
	}

	private selectionStatus(): string {
		if (this.marked.size) return `${this.marked.size} selected`;
		return this.currentIssue() ? "current finding" : "0 selected";
	}

	private promptDetailLine(): string {
		const checkbox = this.includeFullDetails ? this.theme.fg("success", "☑") : this.theme.fg("dim", "☐");
		return `${checkbox} ${this.theme.fg("text", "Include full finding JSON in agent prompt")} ${pill("d toggle", violet)}`;
	}

	private promptImplicationLine(): string {
		const count = this.selection().length;
		if (this.preparingPrompt) return this.theme.fg("accent", `Preparing ${this.promptDetail()} prompt for ${count} finding(s)…`);
		if (this.includeFullDetails) {
			return this.theme.fg("warning", `Full: embeds raw JSON for ${count} finding(s). Much larger prompt; may consume significant model context.`);
		}
		return this.theme.fg("muted", `Compact: sends ${count} finding(s) with type, severity, location, concise evidence, and action. Lower context; complete JSON stays linked.`);
	}

	private summaryBlockLines(): string[] {
		return [
			renderFallowPrSummary(this.options.prSummary, this.theme),
			renderFallowProjectState(this.options.projectState, this.theme),
		].filter(Boolean).flatMap((summary) => summary.split("\n"));
	}

	private footerMetaLines(): string[] {
		return [
			`${pink("Contribute")} ${this.theme.fg("muted", "Ideas, issues, and PRs are welcome: https://github.com/revazi/pi-fallow")}`,
			this.options.fullOutputPath ? `${cyan("Full JSON")} ${this.theme.fg("dim", this.options.fullOutputPath)}` : undefined,
			this.options.command ? `${violet("Command")} ${this.theme.fg("muted", this.options.command)}` : undefined,
		].filter(Boolean) as string[];
	}

	private measurePreferredWidth(): number {
		const visible = this.visibleIssues();
		const headerTitle = buildHeaderTitle(visible.length, this.issues.length, this.overview.title, this.overview.status, this.theme);
		const frameCandidates = [
			...this.preferredHeaderLines(),
			...this.preferredIssueLines(visible),
			this.footerSelectionLine(),
			this.promptDetailLine(),
			this.promptImplicationLine(),
			...this.summaryBlockLines(),
			...this.footerMetaLines(),
		];
		const contentWidth = Math.max(0, ...frameCandidates.map((line) => visibleWidth(line)));
		return Math.max(visibleWidth(headerTitle) + HEADER_BORDER_WIDTH, contentWidth + FRAME_BORDER_WIDTH);
	}

	private preferredHeaderLines(): string[] {
		return [this.statLine(), this.hasActiveFilters() ? this.filterLine() : undefined, this.helpLine()].filter(Boolean) as string[];
	}

	private preferredIssueLines(visible: FlatIssue[]): string[] {
		if (!this.issues.length) return [this.theme.fg("success", "No navigable findings in this Fallow report.")];
		if (!visible.length) return [this.theme.fg("warning", "No findings match the active filters.")];
		const entries = visible.slice(0, this.visibleRowCount());
		return entries.flatMap((entry, index) => this.preferredIssueEntryLines(entry, index, entries));
	}

	private preferredIssueEntryLines(entry: FlatIssue, index: number, entries: FlatIssue[]): string[] {
		return [
			...(entries[index - 1]?.sectionIndex === entry.sectionIndex ? [] : [this.sectionHeaderLine(entry)]),
			this.issueLineRaw(entry, index),
			...(entry.item.action ? [this.detailActionLine(entry.item)] : []),
		];
	}

	private visibleRowCount(): number {
		return this.options.visibleRows ?? VISIBLE_ISSUE_ROWS;
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		this.selected = clampSelection(index, this.visibleIssues().length);
		this.changed();
	}

	private currentIssue(): FlatIssue | undefined {
		return this.visibleIssues()[this.selected];
	}

	private toggleMarked(): void {
		const current = this.currentIssue();
		if (!current) return;
		if (this.marked.has(current.id)) this.marked.delete(current.id);
		else this.marked.add(current.id);
		this.changed();
	}

	private toggleAllVisible(): void {
		const visible = this.visibleIssues();
		if (!visible.length) return;
		const allMarked = visible.every((entry) => this.marked.has(entry.id));
		for (const entry of visible) {
			if (allMarked) this.marked.delete(entry.id);
			else this.marked.add(entry.id);
		}
		this.changed();
	}

	private clearMarked(): void {
		if (!this.marked.size) return;
		this.marked.clear();
		this.changed();
	}

	private toggleExpanded(): void {
		const current = this.currentIssue();
		if (!current?.item.action) return;
		if (this.expanded.has(current.id)) this.expanded.delete(current.id);
		else {
			this.expanded.clear();
			this.expanded.add(current.id);
		}
		this.changed();
	}

	private collapseCurrent(): void {
		const current = this.currentIssue();
		if (!current) return;
		this.expanded.delete(current.id);
		this.changed();
	}

	private ensureVisible(listHeight: number, visibleCount: number): void {
		if (this.selected < this.scrollStart) this.scrollStart = this.selected;
		if (this.selected >= this.scrollStart + listHeight) this.scrollStart = this.selected - listHeight + 1;
		this.scrollStart = Math.max(0, Math.min(this.scrollStart, Math.max(0, visibleCount - listHeight)));
	}

	private filtersChanged(): void {
		this.selected = 0;
		this.scrollStart = 0;
		this.expanded.clear();
		this.changed();
	}

	private changed(): void {
		this.invalidate();
		this.requestRender();
	}

	private visibleIssues(): FlatIssue[] {
		return this.issues.filter((entry) => this.matchesFilters(entry));
	}

	private matchesFilters(entry: FlatIssue): boolean {
		return this.matchesSection(entry) && this.matchesSeverity(entry) && this.matchesQuery(entry);
	}

	private matchesSection(entry: FlatIssue): boolean {
		return this.sectionFilter === undefined || entry.sectionIndex === this.sectionFilter;
	}

	private matchesSeverity(entry: FlatIssue): boolean {
		return !this.severityFilter || issueSeverity(entry) === this.severityFilter;
	}

	private matchesQuery(entry: FlatIssue): boolean {
		return !this.query || issueSearchText(entry).includes(this.query.toLocaleLowerCase());
	}

	private selection(): FlatIssue[] {
		if (this.marked.size) return this.issues.filter((entry) => this.marked.has(entry.id));
		const current = this.currentIssue();
		return current ? [current] : [];
	}

	private togglePromptDetail(): void {
		this.includeFullDetails = !this.includeFullDetails;
		this.changed();
	}

	private promptDetail(): FallowPromptDetail {
		return this.includeFullDetails ? "full" : "compact";
	}

	private finishWithPrompt(): void {
		const issues = this.selection();
		if (!issues.length) return;
		if (!issues.some((entry) => entry.item.raw === undefined)) {
			this.emitPrompt(issues);
			return;
		}
		if (!this.options.fullOutputPath) {
			this.emitPrompt(issues, "Complete report path is unavailable; using retained finding details.");
			return;
		}
		this.preparingPrompt = true;
		this.changed();
		void this.hydrateAndEmitPrompt(issues);
	}

	private async hydrateAndEmitPrompt(issues: FlatIssue[]): Promise<void> {
		try {
			const hydrated = await this.hydrateIssues(issues);
			this.emitPrompt(hydrated);
		} catch {
			this.emitPrompt(issues, "Complete report could not be loaded; using retained finding details.");
		}
	}

	private async hydrateIssues(issues: FlatIssue[]): Promise<FlatIssue[]> {
		const reportText = await readFile(this.options.fullOutputPath!, "utf8");
		const hydratedOverview = buildFallowOverview(JSON.parse(reportText), 0, { includeAllRaw: true });
		if (!hydratedOverview) throw new Error("Complete report has no structured overview.");
		return issues.map((entry) => ({
			...entry,
			item: hydratedOverview.sections[entry.sectionIndex]?.items[entry.itemIndex] ?? entry.item,
		}));
	}

	private emitPrompt(issues: FlatIssue[], hydrationWarning?: string): void {
		const detail = this.promptDetail();
		const findings: FallowPromptFinding[] = issues.map((entry) => ({ sectionTitle: entry.section.title, item: entry.item }));
		this.onDone({
			type: "prompt",
			issueCount: issues.length,
			detail,
			prompt: buildFallowPrompt({
				findings,
				detail,
				command: this.options.command,
				fullOutputPath: this.options.fullOutputPath,
				hydrationWarning,
			}),
		});
	}

	private finishWithTrace(): void {
		const trace = this.currentTraceCandidate();
		if (!trace) return;
		this.onDone({ type: "trace", commandArgs: ["dead-code", "--trace-file", trace] });
	}

	private currentTraceCandidate(): string | null {
		const selected = this.currentIssue();
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
		return path.replace(/[\]\)>,.;:!?]+$/u, "").replace(/:\d+$/, "");
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
		return [
			`${key("↑↓/jk")} ${this.theme.fg("muted", "navigate")}`,
			`${key("enter")} ${this.theme.fg("muted", "expand")}`,
			`${key("s")} ${this.theme.fg("muted", "select")}`,
			`${key("A")} ${this.theme.fg("muted", "all visible")}`,
			`${key("/")} ${this.theme.fg("muted", "search")}`,
			`${key("f")} ${this.theme.fg("muted", "section")}`,
			`${key("v")} ${this.theme.fg("muted", "severity")}`,
			`${key("x")} ${this.theme.fg("muted", "reset filters")}`,
			`${key("c")} ${this.theme.fg("muted", "clear selected")}`,
			`${key("d")} ${this.theme.fg("muted", "prompt detail")}`,
			`${key("e/a")} ${this.theme.fg("muted", "load")}`,
			`${key("t")} ${this.theme.fg("muted", "trace")}`,
			`${key("q")} ${this.theme.fg("muted", "close")}`,
		].join("  ");
	}

	private issueLine(entry: FlatIssue, visibleIndex: number, width: number): string {
		const raw = this.issueLineRaw(entry, visibleIndex);
		return truncateToWidth(this.selected === visibleIndex ? this.theme.bg("selectedBg", raw) : raw, width);
	}

	private issueLineRaw(entry: FlatIssue, visibleIndex: number): string {
		const marker = this.issueLineMarker(visibleIndex);
		const check = this.issueLineCheck(entry);
		const expandMarker = this.issueExpandMarker(entry);
		return `    ${marker} ${check} ${expandMarker} ${this.buildIssueLineMain(entry)}`;
	}

	private issueLineMarker(visibleIndex: number): string {
		return this.selected === visibleIndex ? purple("❯") : this.theme.fg("dim", " ");
	}

	private issueLineCheck(entry: FlatIssue): string {
		return this.marked.has(entry.id) ? this.theme.fg("success", "☑") : this.theme.fg("dim", "☐");
	}

	private issueExpandMarker(entry: FlatIssue): string {
		if (!entry.item.action) return this.theme.fg("dim", "·");
		return this.expanded.has(entry.id) ? amber("▾") : violet("▸");
	}

	private buildIssueLineMain(entry: FlatIssue): string {
		const location = entry.item.path ? cyan(`${entry.item.path}${entry.item.line ? `:${entry.item.line}` : ""}`) : undefined;
		return [
			this.theme.fg("text", entry.item.label),
			location,
			this.issueSeverityLabel(entry.item),
			entry.item.meta ? this.theme.fg("dim", entry.item.meta) : undefined,
		].filter(Boolean).join(this.theme.fg("dim", " · "));
	}

	private issueSeverityLabel(item: FallowIssueLine): string | undefined {
		if (!item.severity) return undefined;
		if (item.meta?.toLocaleLowerCase().includes(item.severity.toLocaleLowerCase())) return undefined;
		return this.theme.fg("dim", item.severity);
	}

	private detailLines(entry: FlatIssue, width: number): string[] {
		if (!entry.item.action) return [];
		return wrapTextWithAnsi(this.detailActionLine(entry.item), width);
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

function issueSeverity(entry: FlatIssue): string {
	const severity = entry.item.severity?.trim().toLocaleLowerCase();
	return severity || "unspecified";
}

function issueSearchText(entry: FlatIssue): string {
	return [entry.section.title, entry.item.label, entry.item.path, entry.item.meta, entry.item.action, entry.item.severity]
		.filter(Boolean)
		.join("\n")
		.toLocaleLowerCase();
}

function compareSeverities(left: string, right: string): number {
	const leftIndex = SEVERITY_ORDER.indexOf(left);
	const rightIndex = SEVERITY_ORDER.indexOf(right);
	if (leftIndex !== rightIndex) return normalizedSeverityIndex(leftIndex) - normalizedSeverityIndex(rightIndex);
	return left.localeCompare(right);
}

function normalizedSeverityIndex(index: number): number {
	return index === -1 ? SEVERITY_ORDER.length : index;
}

function nextOption<T>(options: T[], current: T): T {
	const currentIndex = options.findIndex((option) => option === current);
	return options[(currentIndex + 1) % options.length]!;
}

function clampSelection(index: number, visibleCount: number): number {
	return Math.max(0, Math.min(Math.max(0, visibleCount - 1), index));
}

function removeLastCharacter(value: string): string {
	return [...value].slice(0, -1).join("");
}

function isPrintableCharacter(value: string): boolean {
	return [...value].length === 1 && value >= " ";
}

function pickPathFromText(text: string, pattern: RegExp): string | null {
	const match = text.match(pattern);
	return match?.[1] ?? null;
}

function normalizeMaxWidth(maxWidth: number): number {
	if (!Number.isFinite(maxWidth)) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor(maxWidth));
}
