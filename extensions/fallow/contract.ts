import { fallowRunParams } from "./schema";

export const fallowToolContract = {
	name: "fallow_run",
	label: "Fallow",
	description: "Run Fallow with a command and separate CLI-token args, including opt-in similar-code.",
	promptSnippet: "Run Fallow project analysis, impact tracing, security checks, and fixes",
	promptGuidelines: [
		"fallow_run inspect/trace before deletion; incomplete evidence is advisory.",
		"fallow_run fix-preview before fix-apply; apply only requested changes.",
		"fallow_run similar-code only on request; no model/cache setup. Prefer summary/findings; raw for diagnostics.",
	],
	parameters: fallowRunParams,
} as const;
