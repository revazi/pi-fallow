import { CURSOR_MARKER, matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ReadinessCheck, ReadinessView } from "../readiness-report";
import type { FallowOverlayState } from "../types";
import type { SimilarCodeRunRequest } from "../similar-code-options";
import { SimilarCodeForm } from "./similar-code-form";
import type { FallowIssueNavigator } from "./navigator";
import { ReadinessState } from "./readiness-state";

const VIEW_LABELS = ["Findings", "Similar Code", "Runtime Coverage"];
const OPTIONAL_TEXT = [
	"Similar Code\n\nOpt-in semantic similarity; candidates are advisory, not proof that code can be consolidated.",
	"Runtime Coverage\n\nLocal runtime evidence is limited to the selected capture; cold code is not proof of safe deletion.",
];

interface ShellOptions {
	projectRoot?: string;
	initialState?: FallowOverlayState;
	onSimilarCodeRun?: (request: SimilarCodeRunRequest) => void;
}

/** One mounted shell owns its children until the enclosing custom UI completes. */
export class FallowOverlayShell implements Component, Focusable {
	private view = 0;
	private scroll = [0, 0, 0];
	private pageRows = 10;
	private contentRows = 0;
	private _focused = false;
	private readiness: ReadinessState;
	private similarCode: SimilarCodeForm;

	constructor(
		private findings: FallowIssueNavigator,
		private theme: any,
		private requestRender: () => void,
		private terminalRows: () => number,
		checkReadiness?: ReadinessCheck,
		options: ShellOptions = {},
	) {
		this.readiness = new ReadinessState(checkReadiness, requestRender);
		this.similarCode = new SimilarCodeForm({
			root: options.projectRoot ?? process.cwd(), initialValues: options.initialState?.similarCode,
			isReady: () => this.readiness.isReady("similar-code"), onRun: options.onSimilarCodeRun,
		}, requestRender);
		this.restoreView(options.initialState?.view);
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
		if (this.findings.hasModalInput) { this.findings.handleInput(data); return true; }
		if (this.isFormEditing()) { this.similarCode.handleInput(data); return true; }
		return false;
	}

	private isFormEditing(): boolean { return this.view === 1 && this.similarCode.isEditing; }

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
		if (this.view === 1 && this.similarCode.handleInput(data)) { this.scroll[1] = 0; return; }
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
		this.similarCode.cancelPending();
		this.view = view;
		if (view !== 0) this.readiness.enter(this.optionalView());
		this.syncFocus();
		this.requestRender();
	}

	private optionalView(): ReadinessView {
		return this.view === 1 ? "similar-code" : "runtime-coverage";
	}

	snapshotState(): FallowOverlayState { return { view: this.view, similarCode: this.similarCode.snapshot() }; }

	private restoreView(view: number | undefined): void {
		if (view === undefined) return;
		if ([0, 1, 2].includes(view)) this.switchView(view);
	}

	dispose(): void {
		this.readiness.dispose();
		this.similarCode.dispose();
	}

	private syncFocus(): void {
		this.findings.focused = this._focused && this.view === 0;
		this.similarCode.focused = this._focused && this.view === 1;
		this.findings.invalidate();
	}

	render(width: number): string[] {
		if (width < 1) return [];
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
		const footerText = this.isFormEditing() ? "Tab/Shift+Tab field · Enter finish & validate · Esc finish editing" : "r refresh · i details · ↑↓ scroll · Esc/Backspace findings · o existing dialogs";
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
			"Inline setup and shared in-overlay execution are follow-up work. Press o for existing dialogs (leaves this overlay).",
		].join("\n");
		const form = this.view === 1 ? this.similarCode.render(width) : [];
		return [...form, ...new Text(this.theme.fg("text", body), 0, 0).render(width)];
	}

	private visibleStart(content: string[]): number {
		const cursor = content.findIndex((line) => line.includes(CURSOR_MARKER));
		const start = Math.min(this.scroll[this.view]!, Math.max(0, content.length - this.pageRows));
		if (cursor < 0) return start;
		return Math.max(0, Math.min(cursor, Math.max(start, cursor - this.pageRows + 1)));
	}

	invalidate(): void {
		this.findings.invalidate();
		this.similarCode.invalidate();
	}
}
