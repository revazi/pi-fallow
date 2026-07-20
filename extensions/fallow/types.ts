export interface FallowProjectState {
	configPath?: string;
	configSource: "file" | "flag" | "none";
	cacheEnabled: boolean;
	cacheFiles: string[];
}

export interface FallowPrSummary {
	baseRef?: string;
	gate: string;
	changedFilesCount?: number;
	newIssuesCount: number;
	passed: boolean;
	topAffectedFiles: string[];
	severityBuckets?: Array<{ severity: string; count: number }>;
}

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
	projectState?: FallowProjectState;
	prSummary?: FallowPrSummary;
}

export interface FallowSummaryLine {
	text: string;
	tone?: "dim" | "muted" | "success" | "warning" | "error" | "accent" | "text";
}

export interface FallowSummaryLines {
	lines: FallowSummaryLine[];
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
}

export type FallowNavigatorResult =
	| { type: "prompt"; prompt: string; issueCount: number }
	| { type: "trace"; commandArgs: string[] };
