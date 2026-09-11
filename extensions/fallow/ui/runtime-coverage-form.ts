import { matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import { boundedReadinessText, type ReadinessCheck, type ReadinessReport } from "../readiness-report";
import { buildRuntimeCoverageRequest, inspectCoverageArtifact, readyRuntimeBinding, revalidateRuntimeCoverageRequest, type RuntimeCoverageFormState, type RuntimeCoverageRunRequest } from "../runtime-coverage-options";
import { InlineTextEditor } from "./inline-text-editor";
import { LatestFormTask } from "./latest-form-task";

const PLAIN_THEME = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

interface CoverageFormOptions {
	root: string;
	initialState?: RuntimeCoverageFormState;
	readiness: () => ReadinessReport | undefined;
	checkReadiness?: ReadinessCheck;
	onRun?: (request: RuntimeCoverageRunRequest) => void;
	inspectArtifact?: typeof inspectCoverageArtifact;
	timeoutMs?: number;
}

export class RuntimeCoverageForm implements Component, Focusable {
	private state: RuntimeCoverageFormState;
	private editor: InlineTextEditor;
	private task: LatestFormTask;
	private disposed = false;

	constructor(private options: CoverageFormOptions, private changed: () => void) {
		this.state = { input: "", feedback: "No artifact selected.", ...options.initialState };
		this.editor = new InlineTextEditor((value) => this.updateInput(value), (validate) => this.finishEditing(validate), () => {});
		this.task = new LatestFormTask(changed, (message) => { this.state.feedback = `Check failed: ${message}`; }, options.timeoutMs);
	}

	get focused(): boolean { return this.editor.focused; }
	set focused(value: boolean) { this.editor.focused = value; }
	get isEditing(): boolean { return this.editor.isEditing; }
	snapshot(): RuntimeCoverageFormState { return structuredClone(this.state); }

	handleInput(data: string): boolean {
		if (this.disposed) return false;
		if (this.isEditing) { this.editor.handleInput(data); return true; }
		return this.handleControls(data);
	}

	private handleControls(data: string): boolean {
		if (data === "a") { this.cancelPending(); this.editor.start(this.state.input); this.changed(); return true; }
		if (data === "v") { this.preview(); return true; }
		if (matchesKey(data, "enter")) { this.confirmRun(); return true; }
		return false;
	}

	private updateInput(value: string): void {
		if (value !== this.state.input) {
			this.cancelPending();
			this.state = { input: value, feedback: "Path changed; preview before Run." };
		}
		this.changed();
	}

	private finishEditing(validate: boolean): void {
		this.editor.stop();
		if (validate) this.preview();
		this.changed();
	}

	private preview(): void {
		this.state.preview = undefined;
		this.state.sidecar = undefined;
		const input = this.state.input;
		this.state.feedback = "Validating the selected local path…";
		this.task.run(async (signal) => {
			const artifact = await (this.options.inspectArtifact ?? inspectCoverageArtifact)(this.options.root, input);
			signal.throwIfAborted();
			return artifact;
		}, (artifact) => {
			this.state.preview = artifact;
			this.state.sidecar = readyRuntimeBinding(this.options.readiness());
			this.state.feedback = "Path validated. Review this cached preview; a separate Enter requests Run with fresh checks.";
		});
		this.changed();
	}

	private confirmRun(): void {
		if (!this.state.preview) { this.preview(); return; }
		if (!this.canRun()) { this.state.feedback = "Run disabled: refresh readiness with r, then press v for a new preview."; this.changed(); return; }
		if (!this.options.onRun) { this.state.feedback = "Run unavailable in this context; reopen a live /fallow report."; this.changed(); return; }
		this.recheckAndRun(buildRuntimeCoverageRequest(this.state.preview, this.state.sidecar!));
	}

	private recheckAndRun(request: RuntimeCoverageRunRequest): void {
		this.state.feedback = "Rechecking artifact and signed sidecar before Run…";
		this.task.run(async (signal) => {
			if (!this.options.checkReadiness) throw new Error("Readiness checker unavailable; reopen a live /fallow report.");
			await revalidateRuntimeCoverageRequest(request, signal, (_root, abort) => this.options.checkReadiness!("runtime-coverage", abort));
			return request;
		}, (validated) => {
			this.state.feedback = "Validated local preview retained. Every Run rechecks artifact and sidecar again.";
			try { this.options.onRun!(validated); }
			catch (error) { this.state.feedback = `Run request failed: ${boundedReadinessText(String(error))}`; }
		});
		this.changed();
	}

	cancelPending(): void {
		if (this.task.pending) this.state.feedback = "Check cancelled; entered path retained. Re-preview before Run.";
		this.task.cancel();
	}

	render(width: number, theme?: any): string[] {
		if (width < 1) return [];
		const ui = theme ?? PLAIN_THEME;
		const lines = new Text(`${this.titleLine(width, ui)}\n${ui.fg("dim", "Local/unknown-production evidence only; cold code is not proof of safe deletion.")}`, 0, 0).render(width);
		lines.push(...this.pathLines(width, ui));
		if (this.state.preview) lines.push("", ...this.styledPreviewLines(width, ui));
		lines.push(...new Text(`\n${this.feedbackLine(ui)}\n${ui.fg("dim", this.controls())}`, 0, 0).render(width));
		return lines;
	}

	private titleLine(width: number, theme: any): string {
		const context = width < 50 ? "" : ` ${theme.fg("dim", "· local V8/Istanbul capture")}`;
		return `${theme.fg("accent", "●")} ${theme.fg("accent", theme.bold("Evidence source"))}${context}`;
	}

	private feedbackLine(theme: any): string {
		const feedback = boundedReadinessText(this.state.feedback);
		const success = /validated|retained/u.test(feedback);
		const tone = success ? "success" : /failed|disabled|cancelled|changed/u.test(feedback) ? "error" : "warning";
		return `${theme.fg(tone, success ? "✓" : "!")} ${theme.fg(tone, feedback)}`;
	}

	private pathLines(width: number, theme: any): string[] {
		if (this.isEditing) {
			const label = `  ${theme.fg("accent", "a")} ${theme.fg("text", "Artifact path")} ${theme.fg("accent", "editing")}`;
			return [...new Text(label, 0, 0).render(width), ...this.editor.render(width)];
		}
		const value = boundedReadinessText(this.state.input) || "not selected";
		const label = `  ${theme.fg("accent", "a")} ${theme.fg("text", "Artifact".padEnd(labelWidth(width)))} ${theme.fg("accent", value)}`;
		return new Text(label, 0, 0).render(width);
	}

	private styledPreviewLines(width: number, theme: any): string[] {
		const heading = `${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold("Validated preview"))}`;
		return [...new Text(heading, 0, 0).render(width), ...this.previewLines().flatMap((line, index) => new Text(theme.fg(index < 3 ? "muted" : "dim", line), 0, 0).render(width))];
	}

	private previewLines(): string[] {
		const preview = this.state.preview;
		if (!preview) return [];
		return [
			`Cached preview (${preview.kind}): ${boundedReadinessText(preview.path)}`,
			`Project source scope: ${boundedReadinessText(preview.projectRoot)}`,
			`Signed sidecar: ${boundedReadinessText(this.state.sidecar?.binaryPath ?? "not ready; refresh and preview again")}`,
			"Run reads this artifact and project source locally, with analysis caching disabled. No capture or upload; cloud/API credential variables are removed from the child.",
			"Format validity is checked by Fallow. Directory contents are not recursively snapshotted; use a completed capture for stable evidence.",
		];
	}

	private controls(): string {
		if (this.isEditing) return "Enter finish & preview (no run) · Esc finish editing (draft retained)";
		if (this.task.pending) return "Checking… a edit · v restart preview · Esc back/cancel";
		return this.runControls();
	}

	private canRun(): boolean { return Boolean(this.state.sidecar && readyRuntimeBinding(this.options.readiness())); }

	private runControls(): string {
		if (!this.state.preview) return "a edit path · v/Enter preview (no Run yet)";
		if (!this.canRun()) return "a edit · v preview · Run disabled: r refresh readiness, then v preview again";
		if (!this.options.onRun) return "a edit · v preview · Run unavailable in this context";
		return "a edit path · v preview · Enter Run in overlay (fresh checks; no install)";
	}

	invalidate(): void { this.editor.invalidate(); }
	dispose(): void { this.disposed = true; this.task.dispose(); this.editor.stop(); }
}

function labelWidth(width: number): number { return width < 50 ? 12 : 18; }
