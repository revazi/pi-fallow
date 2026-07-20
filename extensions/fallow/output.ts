import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { asRecord } from "./data";
import type { ParsedFallowOutput } from "./json";
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
	const healthScore = asRecord(data.health_score);
	if (!healthScore) return;
	const formatted = formatHealthScoreText(healthScore);
	if (formatted === null) return;
	lines.push(formatted);
}

function formatHealthScoreText(healthScore: Record<string, any>): string | null {
	const score = healthScore.score ?? healthScore.value;
	if (score === undefined) return null;
	const grade = healthScore.grade ? ` (${healthScore.grade})` : "";
	return `health_score: ${score}${grade}`;
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

export async function formatToolOutput(
	parsed: ParsedFallowOutput,
	cwd: string,
	exitCode = 0,
): Promise<{
	text: string;
	summary: string;
	overview?: FallowOverview;
	fullOutputPath?: string;
	truncated?: boolean;
}> {
	const { overview, summary } = buildToolOutputSummary(parsed, exitCode);
	const rawText = getFormattedRawText(parsed);
	const truncation = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const fullOutputPath = await writeOutputPathIfTruncated(truncation, rawText);
	const text = buildToolOutputText(parsed, summary, truncation, fullOutputPath);

	return { text, summary, overview, fullOutputPath, truncated: truncation.truncated };
}

function buildToolOutputSummary(
	parsed: ParsedFallowOutput,
	exitCode: number,
): { overview: FallowOverview | undefined; summary: string } {
	const overview = parsed.parsed ? buildFallowOverview(parsed.data, exitCode) : undefined;
	const summaryLines = parsed.parsed ? summarizeObject(parsed.data) : [];
	const summary = summaryLines.length ? summaryLines.join("\n") : "No structured summary available.";
	return { overview, summary };
}

function getFormattedRawText(parsed: ParsedFallowOutput): string {
	return parsed.parsed ? JSON.stringify(parsed.data, null, 2) : parsed.raw;
}

async function writeOutputPathIfTruncated(truncation: ReturnType<typeof truncateHead>, rawText: string): Promise<string | undefined> {
	if (!truncation.truncated) return undefined;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-fallow-"));
	const fullOutputPath = join(tempDir, "fallow-output.json");
	await withFileMutationQueue(fullOutputPath, async () => writeFile(fullOutputPath, rawText, "utf8"));
	return fullOutputPath;
}

function buildToolOutputText(
	parsed: ParsedFallowOutput,
	summary: string,
	truncation: ReturnType<typeof truncateHead>,
	fullOutputPath?: string,
): string {
	const header = buildToolOutputHeader(summary);
	const payloadType = buildPayloadType(parsed, truncation.truncated);
	const truncationSuffix = buildTruncationSuffix(truncation, fullOutputPath);
	return `${header}\n${payloadType}:\n${truncation.content}${truncationSuffix}`;
}

function buildPayloadType(parsed: ParsedFallowOutput, isTruncated: boolean): string {
	const baseType = parsed.parsed ? "Raw JSON" : "Raw output";
	return `${baseType}${isTruncated ? " (truncated)" : ""}`;
}

function buildTruncationSuffix(truncation: ReturnType<typeof truncateHead>, fullOutputPath?: string): string {
	if (!truncation.truncated || !fullOutputPath) return "";
	return `\n\n${buildTruncationNotice(truncation, fullOutputPath)}`;
}

function buildToolOutputHeader(summary: string): string {
	return `Fallow summary:\n${summary}`;
}

function buildTruncationNotice(truncation: ReturnType<typeof truncateHead>, fullOutputPath: string): string {
	return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}
