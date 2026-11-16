import { asRecord } from "../data";

const MAX_GATE_SUMMARIES = 8;

type IssueReport = Record<string, any>;

// Gate names are an open upstream set, but never copy arbitrary report text into the transcript.
export function projectIssueGateNotes(combined: IssueReport, security: IssueReport): string[] {
	const gates = [...enforcedGateNotes("combined", combined), ...enforcedGateNotes("security", security)];
	return [...gates.slice(0, MAX_GATE_SUMMARIES), ...baselineNotes(combined)];
}

function enforcedGateNotes(source: string, report: IssueReport): string[] {
	const outcomes = asRecord(report.gate_outcomes) ?? {};
	return Object.entries(outcomes).slice(0, 100).flatMap(([name, value]) => gateNote(source, name, value));
}

function gateNote(source: string, name: string, value: unknown): string[] {
	const gate = asRecord(value);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !isEnforcedProblem(gate)) return [];
	return [`Gate ${name} (${source}): ${gate.status}; enforced.`];
}

function isEnforcedProblem(gate: IssueReport | undefined): boolean {
	return gate?.enforced === true && (gate.status === "warn" || gate.status === "fail");
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
	return staleness?.unrecognised_format === true && staleness.gate_trips === true;
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
