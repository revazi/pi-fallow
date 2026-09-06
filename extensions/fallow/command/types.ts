import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FallowHistoryState } from "../history";
import type { OptionalAnalysisState } from "../optional-analysis";

export type FallowCommandState = {
	lastArgs: string[] | null;
	baseRefs: Map<string, string>;
	history: FallowHistoryState;
	optionalAnalysis: OptionalAnalysisState;
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
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		setEditorText(text: string): void;
	};
};
