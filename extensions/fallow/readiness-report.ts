import type { CapabilityPhase } from "./optional-analysis";

export type ReadinessView = "similar-code" | "runtime-coverage";
export interface ReadinessReport {
	phase: CapabilityPhase;
	summary: string;
	details: string[];
	next: string;
}
export type ReadinessCheck = (view: ReadinessView, signal: AbortSignal) => Promise<ReadinessReport>;

export function readinessNext(phase: CapabilityPhase): string {
	if (phase === "ready") return "Use o for the existing configuration/run dialogs. No analysis has run here.";
	if (phase === "missing") return "Inspect details/location; refresh after external setup, or use o to review setup (confirmation required).";
	return "Inspect details, verify the configured installation, then press r to retry. No reinstall is performed automatically.";
}

export function readinessFailure(error: unknown): ReadinessReport {
	return { phase: "error", summary: boundedReadinessText(error instanceof Error ? error.message : String(error)), details: [], next: readinessNext("error") };
}

export function boundedReadinessText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�").slice(0, 1_000);
}
