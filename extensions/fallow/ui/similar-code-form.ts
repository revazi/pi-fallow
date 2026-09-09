import { Input, matchesKey, Text, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { boundedReadinessText } from "../readiness-report";
import { emptySimilarCodeValues, validateSimilarCodeOptions, type SimilarCodeField, type SimilarCodeFormValues, type SimilarCodeRunRequest, type SimilarCodeValidation } from "../similar-code-options";

const FIELDS: SimilarCodeField[] = ["scope", "threshold", "top"];
const LABELS = { scope: "s Scope (blank: whole project)", threshold: "t Threshold (0..1; blank: Fallow default)", top: "l Result limit (1..100000; blank: Fallow default)" };
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
	private input = new Input();
	private values: SimilarCodeFormValues;
	private editing?: SimilarCodeField;
	private pasting = false;
	private errors: Partial<Record<SimilarCodeField, string>> = {};
	private notice = "";
	private revision = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private _focused = false;

	constructor(private options: FormOptions, private requestRender: () => void) {
		this.values = { ...emptySimilarCodeValues(), ...options.initialValues };
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value && this.editing !== undefined; }
	get isEditing(): boolean { return this.editing !== undefined; }

	snapshot(): SimilarCodeFormValues { return { ...this.values }; }

	handleInput(data: string): boolean {
		if (this.disposed) return false;
		if (this.editing) { this.handleEditorInput(data); return true; }
		return this.handleControls(data);
	}

	private handleControls(data: string): boolean {
		const actions = new Map<string, () => void>([
			["s", () => this.edit("scope")], ["t", () => this.edit("threshold")], ["l", () => this.edit("top")],
			["v", () => this.validate(false)],
		]);
		const action = actions.get(data);
		if (action) { action(); return true; }
		if (matchesKey(data, "enter")) { this.validate(true); return true; }
		return false;
	}

	private edit(field: SimilarCodeField): void {
		this.cancelPending();
		this.editing = field;
		// Do not carry undo/kill-ring/paste state from one field into another.
		this.input = new Input();
		this.pasting = false;
		this.input.setValue(this.values[field]);
		this.input.handleInput("\x1b[F");
		this.focused = this._focused;
		this.changed();
	}

	private handleEditorInput(data: string): void {
		if (data.includes("\x1b[200~")) this.pasting = true;
		if (!this.pasting) { this.handleEditing(data); return; }
		// Paste chunks are text, never field navigation or Run keystrokes. Keep protocol markers only.
		const safe = data.replace(/(\x1b\[200~|\x1b\[201~)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, (_match, marker) => marker ?? "�");
		this.editText(safe);
		if (data.includes("\x1b[201~")) this.pasting = false;
	}

	private handleEditing(data: string): void {
		if (matchesKey(data, "escape")) { this.endEditing(); return; }
		if (matchesKey(data, "enter")) { this.endEditing(); this.validate(false); return; }
		const movement = [["tab", 1], ["shift+tab", -1]] as const;
		const step = movement.find(([key]) => matchesKey(data, key));
		if (step) { this.edit(FIELDS[(FIELDS.indexOf(this.editing!) + step[1] + FIELDS.length) % FIELDS.length]!); return; }
		this.editText(data);
	}

	private editText(data: string): void {
		this.input.handleInput(data);
		const value = this.input.getValue();
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
		this.input.focused = false;
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

	render(width: number): string[] {
		if (width < 1) return [];
		const lines = [...new Text("Similar Code — opt-in, advisory", 0, 0).render(width), ...FIELDS.flatMap((field) => this.fieldLines(field, width))];
		return [...lines, ...new Text([this.controls(), this.notice].filter(Boolean).join("\n"), 0, 0).render(width)];
	}

	private fieldLines(field: SimilarCodeField, width: number): string[] {
		const value = displayedValue(this.values[field]);
		const text = field === this.editing ? LABELS[field] : `${LABELS[field]}: ${value}`;
		const lines = new Text(text, 0, 0).render(width);
		if (field === this.editing) lines.push(...this.input.render(Math.max(4, width)).map((line) => truncateToWidth(line, width)));
		if (this.errors[field]) lines.push(...new Text(`Error: ${this.errors[field]}`, 0, 0).render(width));
		return lines;
	}

	private controls(): string {
		if (this.editing) return "Tab/Shift+Tab next field · Enter finish & validate · Esc finish editing (values retained)";
		if (!this.options.onRun) return "s/t/l edit · v validate · Run unavailable in this context";
		return this.options.isReady() ? "s/t/l edit · v validate only · Enter validate & Run (existing loader; leaves overlay)" : "s/t/l edit · v validate · Run disabled until readiness is ready";
	}

	private changed(): void { if (!this.disposed) this.requestRender(); }
	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.disposed = true; this.cancelPending(); }
}

function displayedValue(value: string): string { return boundedReadinessText(value) || "(blank)"; }
