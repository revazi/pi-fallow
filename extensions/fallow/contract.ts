import { fallowRunParams } from "./schema";

export const fallowToolContract = {
	name: "fallow_run",
	label: "Fallow",
	description: "Run Fallow audits, dead-code, duplication, health, type-aware impact/coupling, inspect, trace, security, architecture, and fixes. Pass CLI flags and values as separate args items.",
	promptSnippet: "Run Fallow project analysis, impact tracing, security checks, and fixes",
	promptGuidelines: [
		"Use fallow_run inspect or trace-symbol before deletion; incomplete type-aware evidence is advisory.",
		"Use fallow_run fix-preview before fix-apply; apply only user-requested changes.",
		"Use fallow_run detail summary or findings routinely; use raw only for necessary diagnostics.",
	],
	parameters: fallowRunParams,
} as const;
