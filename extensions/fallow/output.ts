import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { buildFallowOverview } from "./overview";
import type { FallowOverview } from "./types";

function stringifyCompact(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function countArrayFields(obj: Record<string, unknown>): string[] {
	const skip = new Set([
		"actions", "findings", "files", "imports", "exports", "plugins", "entry_points", "workspaces",
		"schema_version", "version", "elapsed_ms", "summary", "_meta", "stats", "config", "rules",
	]);
	return Object.entries(obj)
		.filter(([key, value]) => Array.isArray(value) && !skip.has(key))
		.map(([key, value]) => `${key}: ${(value as unknown[]).length}`);
}

function summarizeObject(data: any, label?: string): string[] {
	if (!data || typeof data !== "object") return [];
	const lines: string[] = [];
	const prefix = label ? `${label}: ` : "";
	const maybePush = (value: unknown, key: string): void => {
		if (value !== undefined && value !== null && value !== "") lines.push(`${prefix}${key}: ${value}`);
	};

	addCoreSummaries(data, prefix, maybePush, lines);
	addKnownArraySummaries(data, prefix, lines);
	addCountSummaries(lines, data, prefix);
	addNestedSummaries(lines, data);

	return [...new Set(lines)];
}

function addCoreSummaries(
	data: any,
	prefix: string,
	maybePush: (value: unknown, key: string) => void,
	lines: string[],
): void {
	addSimpleSummaryField(maybePush, data.verdict, "verdict");
	addSimpleSummaryField(maybePush, data.error && (data.message ?? stringifyCompact(data.error)), "error");
	addSimpleSummaryField(maybePush, typeof data.total_issues === "number" ? data.total_issues : undefined, "total_issues");
	addHealthScoreSummary(data, prefix, lines);
	addObjectSummary(data.summary, "summary", prefix, lines);
	addObjectSummary(data.stats, "stats", prefix, lines);
}

function addSimpleSummaryField(
	maybePush: (value: unknown, key: string) => void,
	value: unknown,
	key: string,
): void {
	maybePush(value, key);
}

function addHealthScoreSummary(data: any, prefix: string, lines: string[]): void {
	const score = data.health_score?.score ?? data.health_score?.value;
	const grade = data.health_score?.grade ? ` (${data.health_score.grade})` : "";
	if (score === undefined) return;
	lines.push(`${prefix}health_score: ${score}${grade}`);
}

function addObjectSummary(data: unknown, key: string, prefix: string, lines: string[]): void {
	if (!data || typeof data !== "object") return;
	lines.push(`${prefix}${key}: ${stringifyCompact(data)}`);
}
function addKnownArraySummaries(data: any, prefix: string, lines: string[]): void {
	for (const key of ["findings", "clone_groups", "file_scores", "hotspots", "targets"] as const) {
		const value = data[key];
		if (Array.isArray(value)) lines.push(`${prefix}${key}: ${value.length}`);
	}
}

function addCountSummaries(lines: string[], data: any, prefix: string): void {
	const counts = countArrayFields(data);
	if (counts.length) lines.push(`${prefix}${counts.join(", ")}`);
}

function addNestedSummaries(lines: string[], data: any): void {
	for (const section of ["check", "dead_code", "dupes", "duplication", "health", "runtime_coverage"] as const) {
		const nested = data[section];
		if (nested && typeof nested === "object") lines.push(...summarizeObject(nested, section));
	}
}
function tryParseJson(raw: string): { ok: true; data: unknown; raw: string } | { ok: false } {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false };
	try {
		return { ok: true, data: JSON.parse(trimmed), raw: trimmed };
	} catch {
		const firstObject = trimmed.indexOf("{");
		const firstArray = trimmed.indexOf("[");
		const starts = [firstObject, firstArray].filter((index) => index >= 0);
		if (!starts.length) return { ok: false };
		const start = Math.min(...starts);
		const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
		if (end <= start) return { ok: false };
		const candidate = trimmed.slice(start, end + 1);
		try {
			return { ok: true, data: JSON.parse(candidate), raw: candidate };
		} catch {
			return { ok: false };
		}
	}
}

export function parseJson(stdout: string, stderr: string): { parsed: boolean; data?: unknown; raw: string } {
	for (const raw of [stdout, stderr, `${stdout}\n${stderr}`]) {
		const parsed = tryParseJson(raw);
		if (parsed.ok) return { parsed: true, data: parsed.data, raw: parsed.raw };
	}
	return { parsed: false, raw: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() };
}

export async function formatToolOutput(parsed: { parsed: boolean; data?: unknown; raw: string }, cwd: string, exitCode = 0): Promise<{
	text: string;
	summary: string;
	overview?: FallowOverview;
	fullOutputPath?: string;
	truncated?: boolean;
}> {
	const overview = parsed.parsed ? buildFallowOverview(parsed.data, exitCode) : undefined;
	const summaryLines = parsed.parsed ? summarizeObject(parsed.data) : [];
	const summary = summaryLines.length ? summaryLines.join("\n") : "No structured summary available.";
	const rawText = parsed.parsed ? JSON.stringify(parsed.data, null, 2) : parsed.raw;
	const truncation = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

	let fullOutputPath: string | undefined;
	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-fallow-"));
		fullOutputPath = join(tempDir, "fallow-output.json");
		await withFileMutationQueue(fullOutputPath, async () => writeFile(fullOutputPath!, rawText, "utf8"));
	}

	let text = `Fallow summary:\n${summary}\n\n`;
	text += parsed.parsed ? "Raw JSON" : "Raw output";
	text += truncation.truncated ? " (truncated)" : "";
	text += `:\n${truncation.content}`;
	if (truncation.truncated && fullOutputPath) {
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		text += ` Full output saved to: ${fullOutputPath}]`;
	}

	return { text, summary, overview, fullOutputPath, truncated: truncation.truncated };
}
