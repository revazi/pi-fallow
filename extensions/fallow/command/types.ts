import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FallowCommandState = {
	lastArgs: string[] | null;
	baseRefs: Map<string, string>;
};
export type FallowRunMode = ExtensionContext["mode"];

export type FallowCommandContext = {
	cwd: string;
	mode: FallowRunMode;
	hasUI: boolean;
	signal?: AbortSignal | undefined;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		custom<T>(render: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any, options?: any): any;
		setEditorText(text: string): void;
	};
};
