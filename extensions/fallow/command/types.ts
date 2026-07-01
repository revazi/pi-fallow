export type FallowCommandState = { lastArgs: string[] | null };

export type FallowCommandContext = {
	cwd: string;
	hasUI: boolean;
	signal?: AbortSignal | undefined;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		custom<T>(render: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any, options?: any): any;
		setEditorText(text: string): void;
	};
};
