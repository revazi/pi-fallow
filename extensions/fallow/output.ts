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

	if (data.error) lines.push(`${prefix}error: ${data.message ?? stringifyCompact(data.error)}`);
	if (data.verdict) lines.push(`${prefix}verdict: ${data.verdict}`);
	if (typeof data.total_issues === "number") lines.push(`${prefix}total_issues: ${data.total_issues}`);
	if (data.health_score) {
		const score = data.health_score.score ?? data.health_score.value;
		const grade = data.health_score.grade ? ` (${data.health_score.grade})` : "";
		if (score !== undefined) lines.push(`${prefix}health_score: ${score}${grade}`);
	}
	if (data.summary && typeof data.summary === "object") {
		lines.push(`${prefix}summary: ${stringifyCompact(data.summary)}`);
	}
	if (data.stats && typeof data.stats === "object") {
		lines.push(`${prefix}stats: ${stringifyCompact(data.stats)}`);
	}
	if (Array.isArray(data.findings)) lines.push(`${prefix}findings: ${data.findings.length}`);
	if (Array.isArray(data.clone_groups)) lines.push(`${prefix}clone_groups: ${data.clone_groups.length}`);
	if (Array.isArray(data.file_scores)) lines.push(`${prefix}file_scores: ${data.file_scores.length}`);
	if (Array.isArray(data.hotspots)) lines.push(`${prefix}hotspots: ${data.hotspots.length}`);
	if (Array.isArray(data.targets)) lines.push(`${prefix}targets: ${data.targets.length}`);

	const counts = countArrayFields(data);
	if (counts.length) lines.push(`${prefix}${counts.join(", ")}`);

	for (const section of ["check", "dead_code", "dupes", "duplication", "health", "runtime_coverage"] as const) {
		if (data[section] && typeof data[section] === "object") {
			lines.push(...summarizeObject(data[section], section));
		}
	}

	return [...new Set(lines)];
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
