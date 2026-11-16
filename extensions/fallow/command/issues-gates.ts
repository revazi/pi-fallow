import { asRecord } from "../data";

const MAX_GATE_SUMMARIES = 8;

// Gate names are an open upstream set, but never copy arbitrary report text into the transcript.
export function projectIssueGateNotes(combined: Record<string, any>, security: Record<string, any>): string[] {
	const notes: string[] = [];
	for (const [source, report] of [["combined", combined], ["security", security]] as const) {
		const outcomes = asRecord(report.gate_outcomes) ?? {};
		for (const [name, value] of Object.entries(outcomes)) {
			const gate = asRecord(value);
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || gate?.enforced !== true) continue;
			if (gate.status !== "warn" && gate.status !== "fail") continue;
			notes.push(`Gate ${name} (${source}): ${gate.status}; enforced.`);
			if (notes.length === MAX_GATE_SUMMARIES) break;
		}
		if (notes.length === MAX_GATE_SUMMARIES) break;
	}
	for (const [name, section] of [["dead-code", combined.check ?? combined.dead_code], ["dupes", combined.dupes ?? combined.duplication], ["health", combined.health]] as const) {
		const staleness = asRecord(asRecord(section)?.baseline_staleness);
		if (staleness?.unrecognised_format === true && staleness.gate_trips === true) {
			notes.push(`Baseline advisory (${name}): unrecognised format; excluded from issue counts.`);
		} else if (staleness?.change_scoped === false && (staleness.gate_trips === true || staleness.stale === true)) {
			notes.push(`Baseline advisory (${name}): stale; excluded from issue counts.`);
		}
	}
	return notes;
}

// The complete aggregate is retained on disk; inline output must not expose raw
// baseline details, gate payloads, or configuration supplied by a child report.
export function redactProjectIssueOutput(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactProjectIssueOutput);
	const record = asRecord(value);
	if (!record) return value;
	return Object.fromEntries(Object.entries(record)
		.filter(([key]) => !["gate_outcomes", "baseline_staleness", "config"].includes(key))
		.map(([key, child]) => [key, redactProjectIssueOutput(child)]));
}
