import { matchesKey, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import { boundedReadinessText } from "../readiness-report";
import { InlineTextEditor } from "./inline-text-editor";
import { emptySimilarCodeValues, validateSimilarCodeOptions, type SimilarCodeField, type SimilarCodeFormValues, type SimilarCodeRunRequest, type SimilarCodeValidation } from "../similar-code-options";

const FIELDS: SimilarCodeField[] = ["scope", "threshold", "top"];
const LABELS = { scope: "Scope", threshold: "Threshold", top: "Result limit" };
const DEFAULT_VALUES = { scope: "whole project", threshold: "Fallow default", top: "Fallow default" };
const FIELD_KEYS = { scope: "s", threshold: "t", top: "l" };
const PLAIN_THEME = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
interface FormOptions {
	root: string;
	initialValues?: SimilarCodeFormValues;
	isReady: () => boolean;
	onRun?: (request: SimilarCodeRunRequest) => void;
	validate?: typeof validateSimilarCodeOptions;
	validationTimeoutMs?: number;
}

/** Session-local values; editing owns text input, never shell commands or configuration files. */
export class SimilarCodeForm implements Component, Focusable {
	private input: InlineTextEditor;
	private values: SimilarCodeFormValues;
	private editing?: SimilarCodeField;
	private errors: Partial<Record<SimilarCodeField, string>> = {};
	private notice = "";
	private revision = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private _focused = false;

	constructor(private options: FormOptions, private requestRender: () => void) {
		this.values = { ...emptySimilarCodeValues(), ...options.initialValues };
		this.input = new InlineTextEditor((value) => this.editText(value), (validate) => {
			this.endEditing();
			if (validate) this.validate(false);
		}, (delta) => this.edit(FIELDS[(FIELDS.indexOf(this.editing!) + delta + FIELDS.length) % FIELDS.length]!));
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value && this.editing !== undefined; }
	get isEditing(): boolean { return this.editing !== undefined; }

	snapshot(): SimilarCodeFormValues { return { ...this.values }; }

	handleInput(data: string): boolean {
		if (this.disposed) return false;
		if (this.editing) { this.input.handleInput(data); return true; }
		return this.handleControls(data);
	}

	private handleControls(data: string): boolean {
		const actions = new Map<string, () => void>([
			["s", () => this.edit("scope")], ["t", () => this.edit("threshold")], ["l", () => this.edit("top")],
			["v", () => this.validate(false)], ["c", () => this.toggleCache()],
		]);
		const action = actions.get(data);
		if (action) { action(); return true; }
		if (matchesKey(data, "enter")) { this.validate(true); return true; }
		return false;
	}

	private toggleCache(): void {
		this.cancelPending();
		this.values.reuseCache = this.values.reuseCache !== true;
		this.notice = "";
		this.changed();
	}

	private edit(field: SimilarCodeField): void {
		this.cancelPending();
		this.editing = field;
		this.input.start(this.values[field]);
		this.focused = this._focused;
		this.changed();
	}

	private editText(value: string): void {
		if (value !== this.values[this.editing!]) {
			this.cancelPending();
			this.values[this.editing!] = value;
			delete this.errors[this.editing!];
			this.notice = "";
		}
		this.changed();
	}

	private endEditing(): void {
		this.cancelPending();
		this.editing = undefined;
		this.input.stop();
		this.changed();
	}

	cancelPending(): void {
		this.revision++;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.notice = "Validation cancelled; values retained."; }
	}

	private validate(run: boolean): void {
		this.cancelPending();
		const revision = this.revision;
		const values = this.snapshot();
		this.notice = "Validating options…";
		this.timer = setTimeout(() => {
			this.cancelPending();
			this.notice = "Validation timed out. Check the local scope and press v to retry.";
			this.changed();
		}, this.options.validationTimeoutMs ?? 30_000);
		this.changed();
		Promise.resolve().then(() => this.evaluate(revision, values)).then(
			(result) => this.complete(revision, result, run),
			(error) => this.complete(revision, { ok: false, errors: { scope: boundedReadinessText(String(error)) } }, false),
		);
	}

	private async evaluate(revision: number, values: SimilarCodeFormValues): Promise<SimilarCodeValidation> {
		if (revision !== this.revision || this.disposed) return { ok: false, errors: {} };
		return (this.options.validate ?? validateSimilarCodeOptions)(this.options.root, values);
	}

	private complete(revision: number, result: SimilarCodeValidation, run: boolean): void {
		if (revision !== this.revision || this.disposed) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.applyValidation(result, run);
		this.changed();
	}

	private applyValidation(result: SimilarCodeValidation, run: boolean): void {
		if (!result.ok) { this.errors = result.errors; this.notice = "Invalid options; no run requested."; return; }
		this.errors = {};
		this.notice = "Options valid. Blank fields retain Fallow defaults; no run requested.";
		if (run) this.dispatch(result.request);
	}

	private dispatch(request: SimilarCodeRunRequest): void {
		if (!this.options.isReady()) { this.notice = "Run blocked: refresh readiness with r and wait for a ready, integrity-verified model."; return; }
		if (!this.options.onRun) { this.notice = "Run unavailable in this context; reopen a live /fallow report."; return; }
		try { this.options.onRun(request); }
		catch (error) { this.notice = `Run request failed: ${boundedReadinessText(String(error))}`; }
	}

	render(width: number, theme?: any): string[] {
		if (width < 1) return [];
		const ui = theme ?? PLAIN_THEME;
		const title = `${ui.fg("accent", "●")} ${ui.fg("accent", ui.bold("Analysis options"))}${wideContext(width, ui, "· local semantic model")}`;
		const lines = [...new Text(title, 0, 0).render(width), ...FIELDS.flatMap((field) => this.fieldLines(field, width, ui)),
			...new Text(this.cacheLine(width, ui), 0, 0).render(width)];
		return [...lines, ...new Text(this.formStatus(ui), 0, 0).render(width)];
	}

	private formStatus(theme: any): string {
		const lines = ["", theme.fg("dim", this.controls())];
		if (!this.notice) return lines.join("\n");
		const tone = this.noticeTone();
		const icons = { success: "✓", warning: "!", error: "!" };
		lines.push(`${theme.fg(tone, icons[tone])} ${theme.fg(tone, this.notice)}`);
		return lines.join("\n");
	}

	private noticeTone(): "success" | "warning" | "error" {
		if (Object.keys(this.errors).length) return "error";
		if (this.notice.startsWith("Options valid")) return "success";
		return "warning";
	}

	private cacheLine(width: number, theme: any): string {
		const mode = this.cacheMode(theme);
		const label = "Reuse embeddings".padEnd(labelWidth(width));
		const hint = width < 50 ? "" : `  ${theme.fg("dim", mode.hint)}`;
		return `  ${theme.fg("accent", "c")} ${label} ${mode.value}${hint}`;
	}

	private cacheMode(theme: any): { value: string; hint: string } {
		if (this.values.reuseCache === true) return { value: theme.fg("success", "☑ ON"), hint: "Run reads/writes user-local cache" };
		return { value: theme.fg("muted", "☐ OFF"), hint: "off; no cache writes" };
	}

	private fieldLines(field: SimilarCodeField, width: number, theme: any): string[] {
		const lines = new Text(this.fieldText(field, width, theme), 0, 0).render(width);
		if (field === this.editing) lines.push(...this.input.render(width));
		if (this.errors[field]) lines.push(...new Text(`    ${theme.fg("error", `! Error: ${this.errors[field]}`)}`, 0, 0).render(width));
		return lines;
	}

	private fieldText(field: SimilarCodeField, width: number, theme: any): string {
		const value = boundedReadinessText(this.values[field]) || DEFAULT_VALUES[field];
		const label = `  ${theme.fg("accent", FIELD_KEYS[field])} ${theme.fg("text", LABELS[field].padEnd(labelWidth(width)))}`;
		if (field === this.editing) return `${label} ${theme.fg("accent", "editing")}`;
		return `${label} ${theme.fg("accent", value)}`;
	}

	private controls(): string {
		if (this.editing) return "Tab/Shift+Tab next field · Enter finish & validate · Esc finish editing (values retained)";
		if (!this.options.onRun) return "s/t/l edit · v validate · Run unavailable in this context";
		return this.options.isReady() ? "s/t/l edit · v validate only · Enter validate & Run in overlay (fresh readiness; no install)" : "s/t/l edit · v validate · Run disabled until readiness is ready";
	}

	private changed(): void { if (!this.disposed) this.requestRender(); }
	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.disposed = true; this.cancelPending(); }
}

function labelWidth(width: number): number { return width < 50 ? 12 : 18; }
function wideContext(width: number, theme: any, text: string): string {
	return width < 50 ? "" : ` ${theme.fg("dim", text)}`;
}
