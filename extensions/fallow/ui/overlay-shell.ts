import { CURSOR_MARKER, matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ReadinessCheck, ReadinessView } from "../readiness-report";
import type { FallowNavigatorResult, FallowOverlayState } from "../types";
import type { OverlayAnalysisRun } from "../command/overlay-analysis";
import { OverlayAnalysis } from "./overlay-analysis";
import { SimilarCodeForm } from "./similar-code-form";
import { RuntimeCoverageForm } from "./runtime-coverage-form";
import type { FallowIssueNavigator } from "./navigator";
import { ReadinessState } from "./readiness-state";
import { OverlaySetup, type OverlaySetupRun } from "./overlay-setup";

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
		// Findings modals and form editing own text, including digits and shell shortcut letters.
		if (this.handleModalInput(data)) return;
		if (["1", "2", "3"].includes(data)) {
			this.switchView(Number(data) - 1);
			return;
		}
		if (this.view === 0) {
			this.findings.handleInput(data);
			return;
		}
		this.handleOptionalInput(data);
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
		// Compatibility only: these are the existing explicit close/legacy actions.
		if (["q", "o"].includes(data)) {
			this.findings.handleInput(data);
			return;
		}
		this.handleViewControls(data);
	}

	private handleViewControls(data: string): void {
		if (data === "R") { this.analysis.show(this.optionalView()); return; }
		if (data === "S") {
			this.similarCode.cancelPending();
			this.runtimeCoverage.cancelPending();
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
		this.similarCode.cancelPending();
		this.runtimeCoverage.cancelPending();
		this.view = view;
		if (view !== 0) this.readiness.enter(this.optionalView());
		this.syncFocus();
		this.requestRender();
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
		if (this.analysis.active) return this.analysis.render(width, Math.max(1, Math.floor(this.terminalRows() * 0.95)));
		if (this.setup.active) return this.setup.render(width, Math.max(1, Math.floor(this.terminalRows() * 0.95)), this.readiness.lines(this.optionalView()));
		return this.renderView(width);
	}

	private renderView(width: number): string[] {
		const header = this.headerLines(width);
		if (this.view === 0) return [...header, ...this.findings.render(width)];
		return [...header, ...this.renderOptional(width, header.length)];
	}

	private headerLines(width: number): string[] {
		const tabs = VIEW_LABELS.map((label, index) => this.theme.fg(
			index === this.view ? "accent" : "muted",
			index === this.view ? `[${index + 1} ${label}]` : `${index + 1} ${label}`,
		));
		const navigation = new Text(tabs.join(width < 64 ? "\n" : "   "), 0, 0).render(width);
		const helpText = this.isFormEditing() ? "Esc finishes editing (retains values); then 1/2/3 switch view" : "1/2/3 switch view · q close";
		const help = new Text(this.theme.fg("dim", helpText), 0, 0).render(width);
		return [...navigation, ...help];
	}

	private renderOptional(width: number, headerRows: number): string[] {
		const footerText = this.isFormEditing() ? "Tab/Shift+Tab field · Enter finish & validate · Esc finish editing" : "S Setup · R last result · r refresh · i details · ↑↓ scroll · Esc/Backspace findings · o existing dialogs";
		const footer = new Text(this.theme.fg("dim", footerText), 0, 0).render(width);
		const rows = this.terminalRows();
		const available = Number.isFinite(rows) && rows > 0 ? Math.floor(rows * 0.95) : 24;
		this.pageRows = Math.max(1, available - headerRows - footer.length - 1);
		const content = this.optionalContent(width);
		this.contentRows = content.length;
		const start = this.visibleStart(content);
		this.scroll[this.view] = start;
		return [...content.slice(start, start + this.pageRows), ...footer];
	}

	private optionalContent(width: number): string[] {
		const body = [OPTIONAL_TEXT[this.view - 1]!, ...this.readiness.lines(this.optionalView()),
			"", "Checks never install, download models, or change setup state.",
			"Press S for Setup preview (never confirms installation). Run and results stay here; R reopens the last result. o opens legacy dialogs.",
		].join("\n");
		const form = this.currentForm()?.render(width) ?? [];
		return [...form, ...new Text(this.theme.fg("text", body), 0, 0).render(width)];
	}

	private visibleStart(content: string[]): number {
		const cursor = content.findIndex((line) => line.includes(CURSOR_MARKER));
		const start = Math.min(this.scroll[this.view]!, Math.max(0, content.length - this.pageRows));
		if (cursor < 0) return start;
		return Math.max(0, Math.min(cursor, Math.max(start, cursor - this.pageRows + 1)));
	}

	invalidate(): void {
		this.analysis.invalidate();
		this.findings.invalidate();
		this.similarCode.invalidate();
		this.runtimeCoverage.invalidate();
	}
}
