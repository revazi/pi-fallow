import { matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
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

const VIEW_LABELS = ["Findings", "Similar Code", "Runtime Coverage"];
const OPTIONAL_TEXT = [
	"Similar Code\n\nOpt-in semantic similarity; candidates are advisory, not proof that code can be consolidated.",
	"Runtime Coverage\n\nLocal runtime evidence is limited to the selected capture; cold code is not proof of safe deletion.",
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
		this.setup = new OverlaySetup(options.runSetup, requestRender, (view) => this.readiness.refresh(view));
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
		const size = `${width}:${rows}`;
		if (this.size !== size) { this.followFindings = true; this.size = size; }
		if (this.analysis.active) return this.analysis.render(width, rows);
		if (this.setup.active) return this.setup.render(width, rows, this.readiness.lines(this.optionalView()));
		return this.renderView(width, rows);
	}

	private renderView(width: number, rows: number): string[] {
		const content = this.view === 0 ? this.findings.render(width) : this.optionalContent(width);
		const anchor = this.view === 0 && this.followFindings ? this.findings.viewportAnchor : undefined;
		const frame = overlayFrame(width, rows, this.headerLines(width), content, this.footerLines(width), this.scroll[this.view]!, anchor);
		this.pageRows = frame.pageRows;
		this.contentRows = frame.contentRows;
		this.scroll[this.view] = frame.start;
		this.followFindings = false;
		return frame.lines;
	}

	private headerLines(width: number): string[] {
		const tabs = VIEW_LABELS.map((label, index) => this.theme.fg(
			index === this.view ? "accent" : "muted",
			index === this.view ? `[${index + 1} ${label}]` : `${index + 1} ${label}`,
		));
		const navigation = new Text(width < 64 ? "1 Findings · 2 Similar · 3 Coverage" : tabs.join("   "), 0, 0).render(width);
		const helpText = this.isFormEditing() ? "Esc finishes editing (retains values); then 1/2/3 switch view" : "1/2/3 switch view · q close";
		const help = new Text(this.theme.fg("dim", helpText), 0, 0).render(width);
		return [...navigation, ...help];
	}

	private footerLines(width: number): string[] {
		if (this.view === 0) return new Text(this.findingsFooter(), 0, 0).render(width);
		const help = this.isFormEditing() ? "Tab/Shift+Tab field · Enter validate · Esc finish editing" : "S Setup · R result · r refresh · i details · ↑↓ scroll · Esc findings";
		return new Text(this.theme.fg("dim", help), 0, 0).render(width);
	}

	private findingsFooter(): string {
		return this.findings.isModalInput ? "Enter choose/finish · Esc dismiss · text keys stay here" : "↑↓ findings · PgUp/PgDn viewport · 2/3 optional views · q close";
	}

	private optionalContent(width: number): string[] {
		const body = [OPTIONAL_TEXT[this.view - 1]!, ...this.readiness.lines(this.optionalView()),
			"", "Checks never install, download models, or change setup state.",
			"S previews Setup (never confirms installation). Run and results stay here; R reopens the last result. o opens Similar Code.",
		].join("\n");
		const form = this.currentForm()?.render(width) ?? [];
		return [...form, ...new Text(this.theme.fg("text", body), 0, 0).render(width)];
	}

	invalidate(): void {
		this.analysis.invalidate();
		this.findings.invalidate();
		this.similarCode.invalidate();
		this.runtimeCoverage.invalidate();
	}
}
