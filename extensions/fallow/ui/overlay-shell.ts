import { matchesKey, Text, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ReadinessCheck, ReadinessView } from "../readiness-report";
import type { FallowNavigatorResult, FallowOverlayState } from "../types";
import type { OverlayAnalysisRun } from "../command/overlay-analysis";
import { OverlayAnalysis } from "./overlay-analysis";
import { SimilarCodeForm } from "./similar-code-form";
import { RuntimeCoverageForm } from "./runtime-coverage-form";
import type { FallowIssueNavigator } from "./navigator";
import { ReadinessState } from "./readiness-state";
import { OverlaySetup, type OverlaySetupRun } from "./overlay-setup";
import { overlayFrame, overlayRows } from "./overlay-layout";

import { purple, violet } from "./shared";

const VIEW_LABELS = ["Findings", "Similar Code", "Runtime Coverage"];
const OPTIONAL_TEXT = [
	"Semantic matches are advisory—not proof that code can be consolidated.",
	"Evidence covers only the selected capture; cold code is not proof of safe deletion.",
];

interface ShellOptions {
	runSetup?: OverlaySetupRun;
	projectRoot?: string;
	initialState?: FallowOverlayState;
	runAnalysis?: OverlayAnalysisRun;
	onAnalysisResult?: (result: FallowNavigatorResult | null) => void;
}

/** One mounted shell owns its children until the enclosing custom UI completes. */
export class FallowOverlayShell implements Component, Focusable {
	private view = 0;
	private scroll = [0, 0, 0];
	private pageRows = 10;
	private contentRows = 0;
	private _focused = false;
	private tooSmall = false;
	private paste?: string;
	private followFindings = true;
	private size = "";
	private readiness: ReadinessState;
	private setup: OverlaySetup;
	private analysis: OverlayAnalysis;
	private similarCode: SimilarCodeForm;
	private runtimeCoverage: RuntimeCoverageForm;

	constructor(
		private findings: FallowIssueNavigator,
		private theme: any,
		private requestRender: () => void,
		private terminalRows: () => number,
		checkReadiness?: ReadinessCheck,
		options: ShellOptions = {},
	) {
		this.readiness = new ReadinessState(checkReadiness, requestRender);
		this.setup = new OverlaySetup(options.runSetup, requestRender, (view) => this.readiness.refresh(view), theme);
		this.analysis = new OverlayAnalysis(options.runAnalysis, theme, requestRender, (result) => options.onAnalysisResult?.(result));
		this.similarCode = this.createSimilarForm(options);
		this.runtimeCoverage = this.createRuntimeForm(options, checkReadiness);
		this.restoreView(options.initialState?.view);
	}

	private createSimilarForm(options: ShellOptions): SimilarCodeForm {
		return new SimilarCodeForm({
			root: options.projectRoot ?? process.cwd(), initialValues: options.initialState?.similarCode,
			isReady: () => this.readiness.isReady("similar-code"), onRun: options.runAnalysis ? (request) => this.analysis.start(request) : undefined,
		}, this.requestRender);
	}

	private createRuntimeForm(options: ShellOptions, checkReadiness: ReadinessCheck | undefined): RuntimeCoverageForm {
		return new RuntimeCoverageForm({
			root: options.projectRoot ?? process.cwd(), initialState: options.initialState?.runtimeCoverage,
			readiness: () => this.readiness.currentReport("runtime-coverage"), checkReadiness,
			onRun: options.runAnalysis ? (request) => this.analysis.start(request) : undefined,
		}, this.requestRender);
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	handleInput(data: string): void {
		const input = this.collectPaste(data);
		if (input === undefined) return;
		this.handleCollectedInput(input);
	}

	private collectPaste(data: string): string | undefined {
		if (data.includes("\x1b[200~")) this.paste = "";
		if (this.paste === undefined) return data;
		this.paste = (this.paste + data).slice(0, 12_000);
		if (!data.includes("\x1b[201~")) return undefined;
		const value = this.paste;
		this.paste = undefined;
		return `${value.replace(/\x1b\[201~.*$/su, "")}\x1b[201~`;
	}

	private handleCollectedInput(data: string): void {
		if (this.handleSmallInput(data)) return;
		// Findings modals and form editing own text, including digits and shell shortcut letters.
		if (this.handleModalInput(data)) return;
		this.handleViewInput(data);
	}

	private handleViewInput(data: string): void {
		if (this.handleViewKeys(data)) return;
		if (this.view === 0) { this.handleFindingsInput(data); return; }
		this.handleOptionalInput(data);
	}

	private handleViewKeys(data: string): boolean {
		if (data === "o") { this.switchView(1); return true; }
		if (!["1", "2", "3"].includes(data)) return false;
		this.switchView(Number(data) - 1);
		return true;
	}

	private handleSmallInput(data: string): boolean {
		if (!this.tooSmall) return false;
		if (["q", "\x1b", "\x03"].includes(data)) this.cancelVisible();
		return true;
	}

	private cancelVisible(): void {
		if (this.setup.active) this.setup.handleInput("\x1b");
		else if (this.analysis.active) this.analysis.handleInput("\x1b");
		else this.findings.handleInput("\x1b");
	}

	private handleFindingsInput(data: string): void {
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) { this.followFindings = false; this.scrollOptional(data); return; }
		this.followFindings = true;
		this.findings.handleInput(data);
	}

	private handleModalInput(data: string): boolean {
		if (this.setup.active) { this.setup.handleInput(data); return true; }
		if (this.analysis.active) return this.analysis.handleInput(data);
		return this.handleEditorInput(data);
	}

	private handleEditorInput(data: string): boolean {
		if (this.findings.hasModalInput) { this.findings.handleInput(data); return true; }
		if (this.isFormEditing()) { this.currentForm()!.handleInput(data); return true; }
		return false;
	}

	private currentForm(): SimilarCodeForm | RuntimeCoverageForm | undefined {
		if (this.view === 1) return this.similarCode;
		if (this.view === 2) return this.runtimeCoverage;
		return undefined;
	}

	private isFormEditing(): boolean {
		if (this.view === 1) return this.similarCode.isEditing;
		return this.view === 2 && this.runtimeCoverage.isEditing;
	}

	private handleOptionalInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			this.switchView(0);
			return;
		}
		if (data === "q") {
			this.findings.handleInput(data);
			return;
		}
		this.handleViewControls(data);
	}

	private handleViewControls(data: string): void {
		if (data === "R") { this.cancelFormTasks(); this.analysis.show(this.optionalView()); return; }
		if (data === "S") {
			this.cancelFormTasks();
			this.setup.start(this.optionalView());
			return;
		}
		if (this.currentForm()?.handleInput(data)) { this.scroll[this.view] = 0; return; }
		this.handleReadinessInput(data);
	}

	private handleReadinessInput(data: string): void {
		if (data === "r") this.readiness.refresh(this.optionalView());
		else if (data === "i") this.readiness.toggleDetails(this.optionalView());
		else this.scrollOptional(data);
	}

	private scrollOptional(data: string): void {
		const movements: Array<[string, number]> = [
			["down", 1], ["j", 1], ["up", -1], ["k", -1],
			["pageDown", this.pageRows], ["pageUp", -this.pageRows],
			["home", -this.contentRows], ["end", this.contentRows],
		];
		const movement = movements.find(([key]) => matchesKey(data, key));
		if (!movement) return;
		this.scroll[this.view] = Math.max(0, Math.min(
			Math.max(0, this.contentRows - this.pageRows), this.scroll[this.view]! + movement[1],
		));
		this.requestRender();
	}

	private switchView(view: number): void {
		this.analysis.hide();
		this.cancelFormTasks();
		this.view = view;
		if (view !== 0) this.readiness.enter(this.optionalView());
		this.syncFocus();
		this.requestRender();
	}

	private cancelFormTasks(): void {
		this.similarCode.cancelPending();
		this.runtimeCoverage.cancelPending();
	}

	private optionalView(): ReadinessView {
		return this.view === 1 ? "similar-code" : "runtime-coverage";
	}

	snapshotState(): FallowOverlayState { return { view: this.view, similarCode: this.similarCode.snapshot(), runtimeCoverage: this.runtimeCoverage.snapshot() }; }

	private restoreView(view: number | undefined): void {
		if (view === undefined) return;
		if ([0, 1, 2].includes(view)) this.switchView(view);
	}

	dispose(): void {
		this.setup.dispose();
		this.analysis.dispose();
		this.readiness.dispose();
		this.similarCode.dispose();
		this.runtimeCoverage.dispose();
	}

	private syncFocus(): void {
		this.analysis.focused = this._focused;
		this.analysis.invalidate();
		this.findings.focused = this._focused && this.view === 0;
		this.similarCode.focused = this._focused && this.view === 1;
		this.runtimeCoverage.focused = this._focused && this.view === 2;
		this.findings.invalidate();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const rows = overlayRows(this.terminalRows());
		this.tooSmall = width < 40 || rows < 11;
		if (this.tooSmall) return new Text("Resize to at least 40 columns / 12 rows. Esc/q cancels or closes; editing and confirmation paused.", 0, 0).render(width).slice(0, rows);
		return this.renderSized(width, rows);
	}

	private renderSized(width: number, rows: number): string[] {
		this.trackSize(width, rows);
		if (this.analysis.active) return this.bordered(this.analysis.render(width - 4, rows - 2), width, ` ✦ ${VIEW_LABELS[this.view]} · Analysis `);
		if (this.setup.active) return this.bordered(this.setup.render(width - 4, rows - 2, this.readiness.lines(this.optionalView())), width, ` ✦ ${VIEW_LABELS[this.view]} · Setup `);
		if (this.view !== 0) return this.bordered(this.renderView(width - 4, rows - 2), width, ` ✦ ${VIEW_LABELS[this.view]} `);
		return this.renderView(width, rows);
	}

	private trackSize(width: number, rows: number): void {
		const size = `${width}:${rows}`;
		if (this.size !== size) { this.followFindings = true; this.size = size; }
	}

	private renderView(width: number, rows: number): string[] {
		if (this.view === 0) return this.renderFindingsView(width, rows);
		return this.applyFrame(overlayFrame(width, rows, this.headerLines(width), this.optionalContent(width), this.footerLines(width), this.scroll[this.view]!));
	}

	private renderFindingsView(width: number, rows: number): string[] {
		const content = this.findings.render(width, this.navigationLine(width - 4));
		const fixedRows = Math.min(3, content.findIndex((line) => line.includes("[1 Findings]")) + 1);
		const anchor = this.followFindings ? this.findings.viewportAnchor : undefined;
		const adjustedAnchor = anchor === undefined ? undefined : Math.max(0, anchor - fixedRows);
		return this.applyFrame(overlayFrame(
			width, rows, content.slice(0, fixedRows), content.slice(fixedRows, -1),
			this.bordered(this.footerLines(width - 4), width).slice(1), this.scroll[0]!, adjustedAnchor,
		));
	}

	private applyFrame(frame: ReturnType<typeof overlayFrame>): string[] {
		this.pageRows = frame.pageRows;
		this.contentRows = frame.contentRows;
		this.scroll[this.view] = frame.start;
		this.followFindings = false;
		return frame.lines;
	}

	private bordered(lines: string[], width: number, title = ""): string[] {
		const inner = width - 4;
		const label = truncateToWidth(this.theme.fg("accent", this.theme.bold?.(title) ?? title), inner);
		return [purple("╭") + label + purple("─".repeat(width - 2 - visibleWidth(label)) + "╮"), ...lines.map((line) => {
			if ([purple("─".repeat(inner)), this.theme.fg("border", "─".repeat(inner))].includes(line)) return purple("├" + "─".repeat(width - 2) + "┤");
			const clipped = truncateToWidth(line, inner);
			return purple("│ ") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + purple(" │");
		}), purple("╰" + "─".repeat(width - 2) + "╯")];
	}

	private navigationLine(width: number): string {
		const narrow = width < 64;
		const labels = narrow ? ["Findings", "Similar", "Coverage"] : VIEW_LABELS;
		const tabs = labels.map((label, index) => this.tab(label, index, narrow));
		return tabs.join(this.theme.fg("borderMuted", narrow ? " " : "  │  "));
	}

	private tab(label: string, index: number, narrow: boolean): string {
		const text = `${index + 1} ${label}`;
		if (index !== this.view) return this.theme.fg("muted", text);
		const selected = [ `◆ [${text}]`, `[${text}]` ][Number(narrow)]!;
		return this.selectedTab(this.bold(selected));
	}

	private bold(text: string): string {
		if (!this.theme.bold) return text;
		return this.theme.bold(text);
	}

	private selectedTab(text: string): string {
		const active = this.theme.fg("accent", text);
		if (!this.theme.bg) return active;
		return this.theme.bg("selectedBg", active);
	}

	private headerLines(width: number): string[] {
		const navigation = new Text(this.navigationLine(width), 0, 0).render(width);
		const helpText = this.isFormEditing()
			? (width < 60 ? "Esc finish edit · Tab next field" : "Esc finishes editing (retains values); then 1/2/3 switch view")
			: (width < 60 ? `${violet("S")} setup · ${violet("r")} refresh · ${violet("q")} close` : `${violet("S")} setup   ${violet("R")} result   ${violet("r")} refresh   ${violet("i")} details   ${violet("q")} close`);
		const help = new Text(this.theme.fg("dim", helpText), 0, 0).render(width);
		return [...navigation, ...help, purple("─".repeat(width))];
	}

	private footerLines(width: number): string[] {
		if (this.view === 0) return new Text(this.findingsFooter(), 0, 0).render(width);
		const help = this.isFormEditing() ? "Tab/Shift+Tab field · Enter validate · Esc finish editing" : "S Setup · R result · r refresh · i details · ↑↓ scroll · Esc findings";
		return [purple("─".repeat(width)), ...new Text(this.theme.fg("muted", help), 0, 0).render(width)];
	}

	private findingsFooter(): string {
		return this.findings.isModalInput ? "Enter choose/finish · Esc dismiss · text keys stay here" : "q close · ↑↓ findings · PgUp/PgDn viewport · 2/3 optional views";
	}

	private optionalContent(width: number): string[] {
		const form = this.currentForm()?.render(width, this.theme) ?? [];
		return [
			...form,
			purple("─".repeat(width)),
			...this.readinessContent(width),
			"",
			...new Text(this.theme.fg("dim", OPTIONAL_TEXT[this.view - 1]!), 0, 0).render(width),
		];
	}

	private readinessContent(width: number): string[] {
		const lines = this.readiness.lines(this.optionalView());
		const tone = readinessTone(lines[0]);
		const heading = `${this.theme.fg(tone, "●")} ${this.theme.fg("accent", this.theme.bold("Component readiness"))}`;
		const details = lines.flatMap((line, index) => new Text(this.readinessLine(line, index, tone), 0, 0).render(width));
		const safety = this.theme.fg("dim", "Checks never install or download automatically · setup requires confirmation");
		return [heading, ...details, safety];
	}

	private readinessLine(line: string, index: number, tone: string): string {
		if (index === 0) return this.theme.fg(tone, this.theme.bold(line));
		return this.theme.fg(line.startsWith("Press ") ? "accent" : "muted", line);
	}

	invalidate(): void {
		this.analysis.invalidate();
		this.findings.invalidate();
		this.similarCode.invalidate();
		this.runtimeCoverage.invalidate();
	}
}

function readinessTone(status = "Readiness: unknown"): "success" | "warning" | "error" {
	const tones: Array<[RegExp, "success" | "warning" | "error"]> = [
		[/ready$/u, "success"], [/failed|corrupt/u, "error"], [/loading|not checked|missing|incompatible|unknown/u, "warning"],
	];
	return tones.find(([pattern]) => pattern.test(status))?.[1] ?? "warning";
}
