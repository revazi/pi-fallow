import { asRecord } from "../data";

const MAX_GATE_SUMMARIES = 8;

type IssueReport = Record<string, any>;

// Gate names are an open upstream set, but never copy arbitrary report text into the transcript.
export function projectIssueGateNotes(combined: IssueReport, security: IssueReport): string[] {
	const gates: string[] = [];
	// Failures take precedence over warnings when the display budget is exhausted.
	for (const status of ["fail", "warn"]) {
		appendGateNotes(gates, "combined", combined, status);
		appendGateNotes(gates, "security", security, status);
	}
	return [...gates, ...baselineNotes(combined)];
}

function appendGateNotes(notes: string[], source: string, report: IssueReport, status: string): void {
	const outcomes = asRecord(report.gate_outcomes) ?? {};
	Object.entries(outcomes).some(([name, value]) => {
		appendGateNote(notes, source, name, value, status);
		return notes.length >= MAX_GATE_SUMMARIES;
	});
}

function appendGateNote(notes: string[], source: string, name: string, value: unknown, status: string): void {
	if (notes.length < MAX_GATE_SUMMARIES && isMatchingGate(name, value, status)) {
		notes.push(`Gate ${name} (${source}): ${status}; enforced.`);
	}
}

function isMatchingGate(name: string, value: unknown, status: string): boolean {
	const gate = asRecord(value);
	return /^[a-z][a-z0-9-]{0,63}$/.test(name) && gate?.enforced === true && gate.status === status;
}

// A failing enforced gate is a failed aggregate even when it has no issue entries.
// Examine both complete outcome sets rather than the bounded presentation notes.
export function hasEnforcedGateFailure(combined: IssueReport, security: IssueReport): boolean {
	return [combined, security].some((report) => Object.values(asRecord(report.gate_outcomes) ?? {})
		.some((value) => {
			const gate = asRecord(value);
			return gate?.enforced === true && gate.status === "fail";
		}));
}

function baselineNotes(combined: IssueReport): string[] {
	const sections = [["dead-code", combined.check ?? combined.dead_code], ["dupes", combined.dupes ?? combined.duplication], ["health", combined.health]];
	return sections.flatMap(([name, section]) => baselineNote(name, section));
}

function baselineNote(name: string, section: unknown): string[] {
	const staleness = asRecord(asRecord(section)?.baseline_staleness);
	if (isUnrecognisedBaseline(staleness)) {
		return [`Baseline advisory (${name}): unrecognised format; excluded from issue counts.`];
	}
	if (!isStaleBaseline(staleness)) return [];
	return [`Baseline advisory (${name}): stale; excluded from issue counts.`];
}

function isUnrecognisedBaseline(staleness: IssueReport | undefined): boolean {
	return staleness?.change_scoped === false && staleness.unrecognised_format === true && staleness.gate_trips === true;
}

function isStaleBaseline(staleness: IssueReport | undefined): boolean {
	return staleness?.change_scoped === false && (staleness.gate_trips === true || staleness.stale === true);
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
