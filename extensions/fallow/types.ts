export interface FallowDetails {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	elapsedMs: number;
	parsed: boolean;
	summary: string;
	overview?: FallowOverview;
	fullOutputPath?: string;
	truncated?: boolean;
}

export interface FallowIssueLine {
	label: string;
	path?: string;
	line?: number;
	meta?: string;
	action?: string;
	severity?: string;
	raw?: unknown;
}

export interface FallowOverviewSection {
	title: string;
	count?: number;
	items: FallowIssueLine[];
	color?: "success" | "warning" | "error" | "accent" | "muted";
}

export interface FallowOverview {
	title: string;
	status: "success" | "warning" | "error";
	stats: Array<{ label: string; value: string | number }>;
	sections: FallowOverviewSection[];
	notes: string[];
