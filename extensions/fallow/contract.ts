import { fallowRunParams } from "./schema";

export const fallowToolContract = {
	name: "fallow_run",
	label: "Fallow",
	description: "Run Fallow audits, dead-code, duplication, health, type-aware impact/coupling, inspect, trace, security, architecture, and fixes. Pass CLI flags and values as separate args items.",
	parameters: fallowRunParams,
} as const;
