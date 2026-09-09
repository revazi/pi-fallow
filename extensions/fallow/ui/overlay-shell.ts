import { matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { FallowIssueNavigator } from "./navigator";

const VIEW_LABELS = ["Findings", "Similar Code", "Runtime Coverage"];
const OPTIONAL_TEXT = [
	"Similar Code\n\nOpt-in semantic similarity; candidates are advisory, not proof that code can be consolidated.\n\nInline readiness, configuration, setup, and execution controls are not available in this view yet.\n\nNo installation status has been checked by opening this view.\n\nPress o for the existing Status / Setup / Run dialog workflow. It leaves this overlay; opening it never installs anything.",
	"Runtime Coverage\n\nLocal runtime evidence is limited to the selected capture; cold code is not proof of safe deletion.\n\nInline readiness, artifact selection, setup, and execution controls are not available in this view yet.\n\nNo installation status has been checked by opening this view.\n\nPress o for the existing Status / Setup / Run dialog workflow. It leaves this overlay; opening it never installs anything.",
];

/** One mounted shell owns its children until the enclosing custom UI completes. */
export class FallowOverlayShell implements Component, Focusable {
	private view = 0;
	private scroll = [0, 0, 0];
	private pageRows = 10;
	private contentRows = 0;
	private _focused = false;

	constructor(
		private findings: FallowIssueNavigator,
		private theme: any,
		private requestRender: () => void,
		private terminalRows: () => number,
	) {}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	handleInput(data: string): void {
		// Search text (including digits) and action palettes retain input ownership.
		if (this.findings.hasModalInput) {
			this.findings.handleInput(data);
			return;
		}
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
		this.scrollOptional(data);
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
		this.view = view;
		this.syncFocus();
		this.requestRender();
	}

	private syncFocus(): void {
		this.findings.focused = this._focused && this.view === 0;
		this.findings.invalidate();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const tabs = VIEW_LABELS.map((label, index) => this.theme.fg(
			index === this.view ? "accent" : "muted",
			index === this.view ? `[${index + 1} ${label}]` : `${index + 1} ${label}`,
		));
		const navigation = new Text(tabs.join(width < 64 ? "\n" : "   "), 0, 0).render(width);
		const help = new Text(this.theme.fg("dim", "1/2/3 switch view · q close"), 0, 0).render(width);
		const header = [...navigation, ...help];
		if (this.view === 0) return [...header, ...this.findings.render(width)];
		return [...header, ...this.renderOptional(width, header.length)];
	}

	private renderOptional(width: number, headerRows: number): string[] {
		const footer = new Text(this.theme.fg("dim", "↑↓ scroll · Esc/Backspace findings · o existing dialogs"), 0, 0).render(width);
		const rows = this.terminalRows();
		const available = Number.isFinite(rows) && rows > 0 ? Math.floor(rows * 0.95) : 24;
		this.pageRows = Math.max(1, available - headerRows - footer.length - 1);
		const content = new Text(this.theme.fg("text", OPTIONAL_TEXT[this.view - 1]!), 0, 0).render(width);
		this.contentRows = content.length;
		const start = Math.min(this.scroll[this.view]!, Math.max(0, content.length - this.pageRows));
		this.scroll[this.view] = start;
		return [...content.slice(start, start + this.pageRows), ...footer];
	}

	invalidate(): void {
		this.findings.invalidate();
	}
}
