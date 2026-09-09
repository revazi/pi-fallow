import { matchesKey, Text } from "@earendil-works/pi-tui";
import type { ReadinessView } from "../readiness-report";
import { overlayFrame } from "./overlay-layout";

export type OverlaySetupRun = (
	view: ReadinessView, signal: AbortSignal,
	confirm: (title: string, preview: string) => Promise<boolean>,
	progress: (label?: string, output?: string) => void,
) => Promise<string>;

/** Setup is modal within the shell. Cancellation retains ownership until cleanup settles. */
export class OverlaySetup {
	active = false;
	private pending = false;
	private disposed = false;
	private controller?: AbortController;
	private confirmation?: (value: boolean) => void;
	private title = "Setup";
	private preview = "";
	private output = "";
	private notice = "";
	private scroll = 0;
	private pageRows = 1;
	private contentRows = 0;

	constructor(private run: OverlaySetupRun | undefined, private changed: () => void, private settled: (view: ReadinessView) => void) {}

	start(view: ReadinessView): void {
		if (this.active || this.disposed) return;
		this.active = true;
		this.pending = true;
		this.preview = this.output = this.notice = "";
		this.scroll = 0;
		this.title = "Preparing setup preview…";
		const controller = new AbortController();
		this.controller = controller;
		this.changed();
		void this.execute(view, controller);
	}

	private async execute(view: ReadinessView, controller: AbortController): Promise<void> {
		try {
			if (!this.run) throw new Error("Setup unavailable. Reopen a live /fallow report.");
			this.notice = await this.run(view, controller.signal, (title, preview) => this.confirm(title, preview), (label, output) => this.progress(label, output));
		} catch (error) {
			this.notice = `Setup failed: ${setupError(error)}`;
		} finally {
			this.pending = false;
			this.confirmation = undefined;
			if (!this.disposed) this.finish(view, controller.signal.aborted);
		}
	}

	private progress(label: string | undefined, output: string | undefined): void {
		if (this.disposed) return;
		this.updateTitle(label);
		if (output) this.output = (this.output + output).slice(-12_000);
		this.changed();
	}

	private updateTitle(label: string | undefined): void {
		if (label && !this.controller?.signal.aborted) this.title = label;
	}

	private finish(view: ReadinessView, cancelled: boolean): void {
		this.title = cancelled ? "Setup cancelled; process cleanup settled." : "Setup finished";
		if (cancelled) this.notice = "Cancelled. Partial cache files may remain; no automatic removal or retry.";
		this.preview = "";
		this.scroll = 0;
		this.settled(view);
		this.changed();
	}

	private confirm(title: string, preview: string): Promise<boolean> {
		if (this.disposed || this.controller?.signal.aborted) return Promise.resolve(false);
		this.title = title;
		this.preview = preview;
		this.output = "";
		this.scroll = 0;
		return new Promise((resolve) => { this.confirmation = resolve; this.changed(); });
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.answerConfirmation(data)) return;
		if (isBack(data)) this.back();
		else this.moveScroll(data);
		this.changed();
	}

	private answerConfirmation(data: string): boolean {
		if (!this.confirmation || !["y", "n"].includes(data)) return false;
		const confirm = this.confirmation;
		this.confirmation = undefined;
		this.title = data === "y" ? "Rechecking confirmed setup…" : "Setup declined";
		confirm(data === "y");
		this.changed();
		return true;
	}

	private back(): void {
		if (this.pending) this.cancel();
		else this.active = false;
	}

	private moveScroll(data: string): void {
		const moves: Array<[string, number]> = [["down", 1], ["up", -1], ["pageDown", this.pageRows], ["pageUp", -this.pageRows], ["home", -this.contentRows], ["end", this.contentRows]];
		const move = moves.find(([key]) => matchesKey(data, key));
		if (move) this.scroll = Math.max(0, Math.min(Math.max(0, this.contentRows - this.pageRows), this.scroll + move[1]));
	}

	private cancel(): void {
		this.controller?.abort();
		this.confirmation?.(false);
		this.confirmation = undefined;
		this.title = "Cancelling… waiting for process cleanup. Back/close disabled until settled.";
	}

	render(width: number, rows: number, readiness: string[]): string[] {
		const heading = new Text(clean(this.title), 0, 0).render(width);
		const footer = new Text(this.help(), 0, 0).render(width);
		const body = [this.title, this.preview, this.notice, ...(this.pending ? [] : readiness), this.output ? `Output (last 12000 characters):\n${this.output}` : ""].filter(Boolean).join("\n\n");
		const content = new Text(clean(body), 0, 0).render(width);
		const frame = overlayFrame(width, rows, heading, content, footer, this.scroll);
		this.pageRows = frame.pageRows;
		this.contentRows = frame.contentRows;
		this.scroll = frame.start;
		return frame.lines;
	}

	private help(): string {
		if (this.confirmation) return "y explicitly confirm install · n decline · Esc cancel · ↑↓/PgUp/PgDn scroll";
		return this.pending ? "Esc/q/Ctrl+C cancel and wait · view switching and close locked · ↑↓ scroll"
			: "Esc/Backspace/q Back to preserved form · ↑↓/PgUp/PgDn scroll";
	}

	dispose(): void { this.disposed = true; this.cancel(); }
}

function setupError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isBack(data: string): boolean {
	return ["q", "\x03"].includes(data) || matchesKey(data, "escape") || matchesKey(data, "backspace");
}

function clean(text: string): string { return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "�"); }
