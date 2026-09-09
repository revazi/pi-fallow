import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

/** Shared inline editing semantics: paste/text owns keys until editing ends. */
export class InlineTextEditor implements Component, Focusable {
	private input = new Input();
	private pasting = false;
	private active = false;
	private _focused = false;

	constructor(private changed: (value: string) => void, private finished: (validate: boolean) => void, private next: (delta: number) => void) {}
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value && this.active; }
	get isEditing(): boolean { return this.active; }

	start(value: string): void {
		this.input = new Input(); // No undo/kill-ring/paste state leaks between fields.
		this.pasting = false;
		this.active = true;
		this.input.setValue(value);
		this.input.handleInput("\x1b[F");
		this.focused = this._focused;
	}

	stop(): void { this.active = false; this.input.focused = false; }

	handleInput(data: string): void {
		if (data.includes("\x1b[200~")) this.pasting = true;
		if (!this.pasting) { this.handleKeys(data); return; }
		const safe = data.replace(/(\x1b\[200~|\x1b\[201~)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, (_match, marker) => marker ?? "�");
		this.insert(safe);
		if (data.includes("\x1b[201~")) this.pasting = false;
	}

	private handleKeys(data: string): void {
		if (matchesKey(data, "escape")) { this.finished(false); return; }
		if (matchesKey(data, "enter")) { this.finished(true); return; }
		const movements = [["tab", 1], ["shift+tab", -1]] as const;
		const movement = movements.find(([key]) => matchesKey(data, key));
		if (movement) { this.next(movement[1]); return; }
		this.insert(data);
	}

	private insert(data: string): void { this.input.handleInput(data); this.changed(this.input.getValue()); }
	render(width: number): string[] {
		if (width < 1) return [];
		return this.input.render(Math.max(4, width)).map((line) => truncateToWidth(line, width));
	}
	invalidate(): void { this.input.invalidate(); }
}
