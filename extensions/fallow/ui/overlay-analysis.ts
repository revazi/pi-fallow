import { matchesKey, Text, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import type { OverlayAnalysisRequest, OverlayAnalysisRun } from "../command/overlay-analysis";
import type { FallowCommandResult } from "../command/loader";
import { resolveFallowNavigatorMode, resolveFallowNavigatorVisibleRows } from "../command/navigator";
import type { ReadinessView } from "../readiness-report";
import type { FallowNavigatorResult, FallowOverview } from "../types";
import { FallowIssueNavigator } from "./navigator";
import { overlayFrame } from "./overlay-layout";

interface AnalysisView {
	request: OverlayAnalysisRequest;
	controller: AbortController;
	label: string;
	output: string;
	result?: FallowCommandResult;
	navigator?: FallowIssueNavigator;
	layout?: { visibleRows: number };
	details: boolean;
	scroll: number;
	follow?: boolean;
	width?: number;
}

/** One process owner, at most one retained result per optional view, no detached completions. */
export class OverlayAnalysis implements Focusable {
	focused = false;
	active = false;
	private disposed = false;
	private views = new Map<ReadinessView, AnalysisView>();
	private current?: AnalysisView;
	private pending = false;
	private pageRows = 1;
	private contentRows = 0;

	constructor(private run: OverlayAnalysisRun | undefined, private theme: any, private requestRender: () => void, private done: (result: FallowNavigatorResult | null) => void) {}

	start(request: OverlayAnalysisRequest): void {
		if (this.pending || this.disposed) return;
		const entry: AnalysisView = { request: structuredClone(request), controller: new AbortController(), label: "Preparing local analysis…", output: "", details: false, scroll: 0, follow: true };
		this.views.set(requestView(request), entry);
		this.current = entry;
		this.active = this.pending = true;
		this.changed();
		void this.execute(entry);
	}

	show(view: ReadinessView): void {
		if (this.pending || this.disposed) return;
		this.current = this.views.get(view);
		this.active = this.current !== undefined;
		this.changed();
	}

	hide(): void { if (!this.pending) this.active = false; }

	private async execute(entry: AnalysisView): Promise<void> {
		try {
			if (!this.run) throw new Error("Run unavailable; reopen a live /fallow report.");
			const result = await this.run(entry.request, entry.controller.signal, (label, output) => this.progress(entry, label, output));
			this.applyResult(entry, result);
		} catch (error) {
			entry.label = `Run failed: ${analysisError(error)}`;
		} finally {
			if (this.isCurrent(entry)) this.settle(entry);
		}
	}

	private applyResult(entry: AnalysisView, result: FallowCommandResult): void {
		if (!this.isCurrent(entry)) return;
		entry.result = result;
		entry.label = resultLabel(result);
		this.createNavigator(entry, result);
	}

	private progress(entry: AnalysisView, label: string, output = ""): void {
		if (!this.isCurrent(entry)) return;
		if (!entry.controller.signal.aborted) entry.label = label;
		entry.output = (entry.output + output).slice(-12_000);
		this.changed();
	}

	private settle(entry: AnalysisView): void {
		if (entry.controller.signal.aborted) entry.label = "Analysis cancelled; process cleanup settled. Any returned evidence is incomplete.";
		this.pending = false;
		entry.scroll = 0;
		this.changed();
	}

	private createNavigator(entry: AnalysisView, result: FallowCommandResult): void {
		const overview = result.formatted.overview;
		if (!overview) { entry.details = true; return; }
		const layout = { visibleRows: 3, command: [result.binary, ...result.args].join(" "), commandArgs: [...result.args],
			fullOutputPath: result.formatted.fullOutputPath, truncated: result.formatted.truncated,
			informationalMode: resolveFallowNavigatorMode(overview, true) === "informational",
		};
		entry.layout = layout;
		entry.navigator = new FallowIssueNavigator(overview, this.theme, (value) => {
			if (this.isCurrent(entry) && this.active) this.done(value);
		}, () => { if (this.isCurrent(entry) && this.active) this.changed(); }, layout);
	}

	/** False lets the shell switch tabs, but only after this run has settled. */
	handleInput(data: string): boolean {
		const entry = this.current;
		if (!entry || this.disposed) return false;
		return this.routeInput(data, entry);
	}

	private routeInput(data: string, entry: AnalysisView): boolean {
		if (this.pending) { this.handleRunning(data, entry); return true; }
		if (entry.navigator?.hasModalInput) { entry.navigator.handleInput(data); return true; }
		return this.handleResult(data, entry);
	}

	private handleRunning(data: string, entry: AnalysisView): void {
		if (isBack(data) || data === "q" || matchesKey(data, "ctrl+c")) {
			entry.controller.abort();
			entry.label = "Cancelling analysis… waiting for process cleanup; Back/close and view switching are locked.";
		} else this.movePage(data, entry);
		this.changed();
	}

	private handleResult(data: string, entry: AnalysisView): boolean {
		if (["1", "2", "3"].includes(data)) return false;
		if (isBack(data)) this.hide();
		else if (data === "q") this.done(null);
		else this.handleResultControls(data, entry);
		this.changed();
		return true;
	}

	private handleResultControls(data: string, entry: AnalysisView): void {
		if (data === "r") { this.start(entry.request); return; }
		if (data === "I") { entry.details = !entry.details; entry.scroll = 0; entry.follow = true; return; }
		if (this.movePage(data, entry)) return;
		this.handleNavigatorInput(data, entry);
	}

	private handleNavigatorInput(data: string, entry: AnalysisView): void {
		if (entry.details) return;
		entry.navigator?.handleInput(data);
		entry.follow = true;
	}

	private movePage(data: string, entry: AnalysisView): boolean {
		const moves: Array<[string, number]> = [["pageDown", this.pageRows], ["pageUp", -this.pageRows]];
		const move = moves.find(([key]) => matchesKey(data, key));
		if (!move) return false;
		entry.follow = false;
		entry.scroll = Math.max(0, Math.min(Math.max(0, this.contentRows - this.pageRows), entry.scroll + move[1]));
		return true;
	}

	render(width: number, rows: number): string[] {
		const entry = this.current;
		if (!entry || width < 1) return [];
		const heading = new Text(`${clean(entry.label).slice(0, 180)}\n${advisory(entry.request)}`, 0, 0).render(width);
		const footer = new Text(this.footerHelp(entry), 0, 0).render(width);
		const content = this.content(entry, width, rows);
		const frame = overlayFrame(width, rows, heading, content, footer, entry.scroll, this.resultAnchor(entry));
		this.pageRows = frame.pageRows;
		this.contentRows = frame.contentRows;
		entry.scroll = frame.start;
		entry.follow = false;
		return frame.lines;
	}

	private footerHelp(entry: AnalysisView): string {
		if (this.pending) return "Esc/b/q/Ctrl+C cancel & wait · PgUp/PgDn output";
		return entry.navigator?.isModalInput ? "Enter choose/finish · Esc dismiss · text keys stay here" : "Esc/b form · r retry · I details/output · q close · 1/2/3 views · PgUp/PgDn scroll";
	}

	private resultAnchor(entry: AnalysisView): number | undefined {
		return entry.follow && !entry.details ? entry.navigator?.viewportAnchor : undefined;
	}

	private content(entry: AnalysisView, width: number, rows: number): string[] {
		if ([this.pending, entry.details, !entry.navigator].some(Boolean)) return new Text(clean(detailText(entry)), 0, 0).render(width);
		return this.renderNavigator(entry, width, rows);
	}

	private renderNavigator(entry: AnalysisView, width: number, rows: number): string[] {
		entry.navigator!.focused = this.focused;
		if (entry.width !== width) { entry.width = width; entry.follow = true; }
		const count = resolveFallowNavigatorVisibleRows(rows - 5, false);
		if (entry.layout && entry.layout.visibleRows !== count) { entry.layout.visibleRows = count; entry.follow = true; entry.navigator!.invalidate(); }
		return entry.navigator!.render(width).map((line) => truncateToWidth(line, width));
	}

	private changed(): void { if (!this.disposed) this.requestRender(); }
	private isCurrent(entry: AnalysisView): boolean { return !this.disposed && this.current === entry; }
	invalidate(): void { for (const entry of this.views.values()) entry.navigator?.invalidate(); }
	dispose(): void { this.disposed = true; this.current?.controller.abort(); this.views.clear(); }
}

function analysisError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requestView(request: OverlayAnalysisRequest): ReadinessView { return "sidecar" in request ? "runtime-coverage" : "similar-code"; }
function isBack(data: string): boolean { return data === "b" || matchesKey(data, "escape") || matchesKey(data, "backspace"); }
function clean(text: string): string { return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "�"); }
function advisory(request: OverlayAnalysisRequest): string {
	return "sidecar" in request ? "Local capture only; cold code is not proof of safe deletion." : "Semantic candidates are advisory, not proof that code can be consolidated.";
}
function resultLabel(result: FallowCommandResult): string {
	const metadata = result.reportMetadata;
	if (!metadata.complete) return `Analysis incomplete: ${metadata.completenessReason ?? "unverified completion"} (exit ${result.execution.code}). I: details/output`;
	if (!result.formatted.overview) return `Analysis returned no recognized report (exit ${result.execution.code}). I: details/output`;
	return `Analysis complete (exit ${result.execution.code}). I: provenance and complete output`;
}
function overviewDetails(overview: FallowOverview | undefined): string[] {
	if (!overview) return [];
	return [...overview.notes, ...overview.stats.map((stat) => `${stat.label}: ${stat.value}`)];
}
function resultDetails(result: FallowCommandResult): string[] {
	return [
		`Command: ${result.binary} ${result.args.join(" ")}`, `Project: ${result.details.cwd}`,
		`Report metadata: ${JSON.stringify(result.reportMetadata)}`, `Complete output: ${result.formatted.fullOutputPath ?? "unavailable"}`,
		...overviewDetails(result.formatted.overview), result.formatted.summary,
	];
}
function detailText(entry: AnalysisView): string {
	const lines = entry.result ? resultDetails(entry.result) : [];
	return [entry.label, ...lines, "Output tail (last 12000 characters; no automatic retry or installation):", entry.output].join("\n\n");
}
