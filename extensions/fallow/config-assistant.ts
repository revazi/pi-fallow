import { constants } from "node:fs";
import { lstat, link, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { asRecord } from "./data";
import { createFallowRuleConfig, editFallowRuleConfig } from "./config-edit";
import { readSizedFile } from "./read-sized-file";
import { createFallowRunner } from "./runner";

const MAX_CONFIG_BYTES = 1_048_576;
const CONFIG_TIMEOUT_SECS = 30;
const PROJECT_CONFIG_NAMES = new Set([".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"]);
const SEVERITIES = new Set(["error", "warn", "off"]);

type ConfigOwnership = "project" | "inherited" | "none";
type AssistantRunner = ReturnType<typeof createFallowRunner>;

type SourceSnapshot = {
	path?: string;
	digest?: string;
	content?: string;
	mode?: number;
};

interface FallowConfigInspection {
	status: "ready" | "invalid" | "unavailable";
	source?: string;
	ownership: ConfigOwnership;
	format?: "jsonc" | "toml";
	summary: string;
	counts?: { entries: number; rules: number; workspaces: number; plugins: number; boundaries: number; overrides: number };
	diagnostic?: string;
}

export interface FallowConfigPreview {
	status: "change" | "unchanged";
	source: string;
	ownership: "project";
	format: "jsonc" | "toml";
	schemaPath: string;
	change: string;
	backupPolicy: string;
	writePolicy: string;
}

interface FallowConfigPlan {
	preview: FallowConfigPreview;
	targetPath: string;
	candidate: string;
	source: SourceSnapshot;
	discoveredSource?: string;
	schemaDigest: string;
}

export interface FallowConfigApplyResult {
	status: "applied" | "unchanged";
	source: string;
	backup?: string;
	summary: string;
}

export function createFallowConfigAssistant(
	pi: ExtensionAPI,
	runner: AssistantRunner = createFallowRunner({ allowNpxFallback: false }),
) {
	async function inspect(cwd: string, signal?: AbortSignal): Promise<FallowConfigInspection> {
		let root = resolve(cwd);
		let sourcePath: string | undefined;
		try {
			root = await canonicalRoot(cwd);
			const discovered = await discoverConfig(pi, runner, root, signal);
			sourcePath = discovered.path;
			const resolvedConfig = await executeJson(pi, runner, ["config", "--format", "json", "--quiet", "--no-cache"], root, signal, discovered.displaySource);
			return buildInspection(root, sourcePath, resolvedConfig);
		} catch (error) {
			return {
				status: error instanceof InvalidConfigError ? "invalid" : "unavailable",
				source: sourcePath ? displayPath(root, sourcePath) : undefined,
				ownership: configOwnership(root, sourcePath),
				summary: "Fallow configuration could not be inspected safely.",
				diagnostic: safeError(error),
			};
		}
	}

	async function previewRule(cwd: string, rule: string, severity: string, signal?: AbortSignal): Promise<FallowConfigPlan> {
		throwIfCancelled(signal);
		const root = await canonicalRoot(cwd);
		const discovered = await discoverConfig(pi, runner, root, signal);
		validateRuleInput(rule, severity, discovered.displaySource);
		await executeJson(pi, runner, ["config", "--format", "json", "--quiet", "--no-cache"], root, signal, discovered.displaySource);
		const schema = await loadConfigSchema(pi, runner, root, signal);
		validateRuleAgainstSchema(schema.value, rule, discovered.displaySource);
		const source = await snapshotSource(root, discovered.path);
		return buildRulePlan(root, discovered.path, source, schema.digest, rule, severity);
	}

	async function apply(
		plan: FallowConfigPlan,
		cwd: string,
		confirmation: { confirmed: true; signal?: AbortSignal },
	): Promise<FallowConfigApplyResult> {
		assertConfirmed(confirmation);
		if (plan.preview.status === "unchanged") return unchangedApplyResult(plan);
		const signal = confirmation.signal;
		throwIfCancelled(signal);
		const root = await canonicalRoot(cwd);
		assertProjectTarget(root, plan.targetPath);
		const discovered = await discoverConfig(pi, runner, root, signal);
		assertSameValue(discovered.path, plan.discoveredSource, "config discovery changed after preview");
		await assertSourceUnchanged(root, plan.source);
		const schema = await loadConfigSchema(pi, runner, root, signal);
		assertSameValue(schema.digest, plan.schemaDigest, "installed Fallow config schema changed after preview");
		throwIfCancelled(signal);
		return writePlanAtomically(plan, signal);
	}

	return { inspect, previewRule, apply };
}

function buildRulePlan(
	root: string,
	discoveredSource: string | undefined,
	source: SourceSnapshot,
	schemaDigest: string,
	rule: string,
	severity: string,
): FallowConfigPlan {
	const targetPath = writableProjectTarget(root, discoveredSource);
	const shownSource = displayPath(root, targetPath);
	const edit = safelyEditConfig(source, targetPath, shownSource, rule, severity);
	const preview = buildRulePreview(edit, source.path === targetPath, targetPath, shownSource, rule, severity);
	return { preview, targetPath, candidate: edit.content, source, discoveredSource, schemaDigest };
}

function safelyEditConfig(source: SourceSnapshot, targetPath: string, shownSource: string, rule: string, severity: string): ReturnType<typeof editFallowRuleConfig> {
	try {
		const edit = source.path === targetPath
			? editFallowRuleConfig(source.content!, targetPath, rule, severity)
			: createFallowRuleConfig(rule, severity, inheritedReference(source.path, targetPath));
		editFallowRuleConfig(edit.content, targetPath, rule, severity);
		return edit;
	} catch (error) {
		throw new InvalidConfigError(`Invalid Fallow config ${shownSource}: ${safeError(error)}`);
	}
}

function buildRulePreview(
	edit: ReturnType<typeof editFallowRuleConfig>,
	existingTarget: boolean,
	targetPath: string,
	shownSource: string,
	rule: string,
	severity: string,
): FallowConfigPreview {
	const previous = edit.previous || "default (not explicitly configured)";
	return {
		status: edit.changed ? "change" : "unchanged",
		source: shownSource,
		ownership: "project",
		format: edit.format,
		schemaPath: `$.rules.${rule}`,
		change: `${previous} → ${severity}`,
		backupPolicy: existingTarget ? existingBackupPolicy(targetPath) : "No backup is needed when creating a new project config.",
		writePolicy: "No write occurs during preview. Apply requires interactive confirmation, then repeats discovery, schema, and content drift checks before an atomic same-directory replacement.",
	};
}

function inheritedReference(sourcePath: string | undefined, targetPath: string): string | undefined {
	if (!sourcePath) return undefined;
	const path = relative(dirname(targetPath), sourcePath).replaceAll("\\", "/");
	return path.startsWith(".") ? path : `./${path}`;
}

function existingBackupPolicy(targetPath: string): string {
	return `Before replacement, preserve the exact prior file as ${basename(targetPath)}.pi-fallow.bak (or the first free numeric suffix).`;
}

function assertConfirmed(confirmation: { confirmed: true; signal?: AbortSignal } | undefined): asserts confirmation is { confirmed: true; signal?: AbortSignal } {
	if (confirmation?.confirmed !== true) throw new Error("Explicit confirmation is required before a Fallow configuration write.");
}

function unchangedApplyResult(plan: FallowConfigPlan): FallowConfigApplyResult {
	return { status: "unchanged", source: plan.preview.source, summary: "The requested rule severity is already configured." };
}

function assertSameValue(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected) throw driftError(message);
}

export async function sendFallowConfigInspection(
	pi: ExtensionAPI,
	ctx: { cwd: string; signal?: AbortSignal; hasUI: boolean; ui?: { notify(message: string, level: "info" | "warning" | "error"): void } },
	assistant = createFallowConfigAssistant(pi),
): Promise<void> {
	const report = await assistant.inspect(ctx.cwd, ctx.signal);
	sendConfigMessage(pi, formatFallowConfigInspection(report), report);
	if (ctx.hasUI) ctx.ui?.notify("Read-only Fallow configuration inspection added to the transcript.", report.status === "ready" ? "info" : "warning");
}

function formatFallowConfigInspection(report: FallowConfigInspection): string {
	const lines = ["Fallow configuration assistant", "", `Status: ${report.status}`, `Ownership: ${ownershipLabel(report.ownership)}`, report.summary];
	appendOptionalLine(lines, "Source", report.source);
	appendOptionalLine(lines, "Format", report.format);
	appendInspectionCounts(lines, report.counts);
	appendOptionalLine(lines, "Diagnostic", report.diagnostic);
	lines.push("Resolved values are intentionally omitted so secrets and unrelated configuration do not enter the transcript.");
	return lines.join("\n");
}

function appendOptionalLine(lines: string[], label: string, value: string | undefined): void {
	if (value) lines.push(`${label}: ${value}`);
}

function appendInspectionCounts(lines: string[], counts: FallowConfigInspection["counts"]): void {
	if (!counts) return;
	lines.push(`Resolved summary: ${counts.entries} entries · ${counts.rules} rules · ${counts.workspaces} workspaces · ${counts.plugins} plugins · ${counts.boundaries} boundaries · ${counts.overrides} overrides`);
}

export function formatFallowConfigPreview(preview: FallowConfigPreview): string {
	return [
		"Fallow configuration preview",
		"",
		`Status: ${preview.status}`,
		`Project source: ${preview.source}`,
		`Format: ${preview.format}`,
		`Schema path: ${preview.schemaPath}`,
		`Proposed change: ${preview.change}`,
		`Backup policy: ${preview.backupPolicy}`,
		`Write policy: ${preview.writePolicy}`,
		"No unrelated configuration values are included in this preview.",
	].join("\n");
}

export function formatFallowConfigApply(result: FallowConfigApplyResult): string {
	const lines = ["Fallow configuration apply", "", `Status: ${result.status}`, `Project source: ${result.source}`, result.summary];
	if (result.backup) lines.push(`Backup: ${result.backup}`);
	return lines.join("\n");
}

export function renderFallowConfigAssistantMessage(message: { content: string; details?: unknown }, _options: unknown, theme: any): Text {
	const tone = configMessageTone(asRecord(message.details)?.status);
	return new Text(`${theme.fg("toolTitle", theme.bold("Fallow configuration assistant"))}\n${theme.fg(tone, message.content)}`, 0, 0);
}

function configMessageTone(status: unknown): "warning" | "success" | "toolTitle" {
	if (status === "invalid" || status === "unavailable") return "warning";
	return status === "applied" ? "success" : "toolTitle";
}

export function sendConfigMessage(pi: ExtensionAPI, content: string, details: unknown): void {
	pi.sendMessage({ customType: "fallow-config-assistant", content, display: true, details });
}

async function discoverConfig(pi: ExtensionAPI, runner: AssistantRunner, root: string, signal?: AbortSignal): Promise<{ path?: string; displaySource: string }> {
	throwIfCancelled(signal);
	runner.clear(pi);
	const { result } = await runner.execute(pi, ["config", "--path", "--quiet", "--no-cache"], root, signal, CONFIG_TIMEOUT_SECS);
	const state = configDiscoveryState(result);
	if (state === "none") return { displaySource: "zero-config project" };
	const line = validatedConfigPathOutput(result.stdout);
	const candidate = resolve(root, line);
	const path = join(await realpath(dirname(candidate)), basename(candidate));
	return { path, displaySource: displayPath(root, path) };
}

function configDiscoveryState(result: { code: number; killed?: boolean; terminationReason?: string }): "found" | "none" {
	if (result.killed) throw new Error(discoveryTerminationMessage(result.terminationReason));
	if (result.code === 3) return "none";
	if (result.code !== 0) throw new InvalidConfigError("Fallow config discovery failed at schema path $.");
	return "found";
}

function discoveryTerminationMessage(reason: string | undefined): string {
	return reason === "timed-out" ? "Fallow config discovery timed out." : "Fallow config discovery was cancelled.";
}

function validatedConfigPathOutput(stdout: string): string {
	const line = stdout.trim();
	if (!line || line.includes("\n") || line.includes("\0")) throw new InvalidConfigError("Fallow returned an invalid config path at schema path $.");
	return line;
}

async function executeJson(
	pi: ExtensionAPI,
	runner: AssistantRunner,
	args: string[],
	root: string,
	signal: AbortSignal | undefined,
	source: string,
): Promise<Record<string, any>> {
	throwIfCancelled(signal);
	const { result } = await runner.execute(pi, args, root, signal, CONFIG_TIMEOUT_SECS);
	assertConfigExecution(result, source);
	return parseConfigJson(result.stdout, source);
}

function assertConfigExecution(result: { code: number; killed?: boolean; terminationReason?: string }, source: string): void {
	if (result.killed) throw new Error(configTerminationMessage(result.terminationReason));
	if (result.code !== 0) throw new InvalidConfigError(`Invalid Fallow config ${source} at schema path $ (exit ${result.code}).`);
}

function configTerminationMessage(reason: string | undefined): string {
	return reason === "timed-out" ? "Fallow configuration validation timed out." : "Fallow configuration validation was cancelled.";
}

function parseConfigJson(stdout: string, source: string): Record<string, any> {
	try {
		const parsed = asRecord(JSON.parse(stdout));
		if (!parsed) throw new Error();
		return parsed;
	} catch {
		throw new InvalidConfigError(`Fallow returned unreadable JSON for ${source} at schema path $.`);
	}
}

async function loadConfigSchema(pi: ExtensionAPI, runner: AssistantRunner, root: string, signal?: AbortSignal): Promise<{ value: Record<string, any>; digest: string }> {
	const value = await executeJson(pi, runner, ["config-schema", "--format", "json", "--quiet", "--no-cache"], root, signal, "installed config schema");
	return { value, digest: digest(JSON.stringify(value)) };
}

function validateRuleAgainstSchema(schema: Record<string, any>, rule: string, source: string): void {
	const properties = configRuleProperties(schema);
	if (!Object.hasOwn(properties, rule)) throw new InvalidConfigError(`Invalid Fallow config request for ${source} at schema path $.rules.${rule}: unknown rule id.`);
}

function configRuleProperties(schema: Record<string, any>): Record<string, any> {
	const definitions = asRecord(schema.$defs) || {};
	const rules = asRecord(definitions.RulesConfig) || {};
	return asRecord(rules.properties) || {};
}

function validateRuleInput(rule: string, severity: string, source: string): void {
	if (!/^[a-z][a-z0-9-]{0,79}$/.test(rule)) throw new InvalidConfigError(`Invalid Fallow config request for ${source} at schema path $.rules: rule id must be kebab-case.`);
	if (!SEVERITIES.has(severity)) throw new InvalidConfigError(`Invalid Fallow config request for ${source} at schema path $.rules.${rule}: severity must be error, warn, or off.`);
}

async function snapshotSource(root: string, sourcePath: string | undefined): Promise<SourceSnapshot> {
	if (!sourcePath) return {};
	if (configOwnership(root, sourcePath) === "project") await validateProjectSource(root, sourcePath);
	const content = (await readSizedFile(sourcePath, { minimum: 0, maximum: MAX_CONFIG_BYTES })).toString("utf8");
	const info = await stat(sourcePath);
	return { path: sourcePath, content, digest: digest(content), mode: info.mode & 0o777 };
}

async function validateProjectSource(root: string, sourcePath: string): Promise<void> {
	const info = await lstat(sourcePath);
	if (info.isSymbolicLink()) throw new InvalidConfigError(`Refusing project config symlink ${displayPath(root, sourcePath)} at schema path $.`);
	if (!info.isFile()) throw new InvalidConfigError(`Invalid project config ${displayPath(root, sourcePath)} at schema path $: expected a regular file.`);
}

function writableProjectTarget(root: string, discovered: string | undefined): string {
	if (discovered && configOwnership(root, discovered) === "project") {
		assertProjectTarget(root, discovered);
		return discovered;
	}
	return join(root, ".fallowrc.jsonc");
}

function assertProjectTarget(root: string, target: string): void {
	if (dirname(resolve(target)) !== root || !PROJECT_CONFIG_NAMES.has(basename(target))) {
		throw new InvalidConfigError("Pi Fallow only writes a recognized config file directly inside the project root at schema path $.");
	}
}

async function assertSourceUnchanged(root: string, source: SourceSnapshot): Promise<void> {
	if (!source.path) return;
	const current = await snapshotSource(root, source.path);
	if (current.digest !== source.digest) throw driftError("source config content changed after preview");
}

async function writePlanAtomically(plan: FallowConfigPlan, signal?: AbortSignal): Promise<FallowConfigApplyResult> {
	return plan.source.path === plan.targetPath
		? replaceProjectConfig(plan, signal)
		: createProjectConfig(plan, signal);
}

async function replaceProjectConfig(plan: FallowConfigPlan, signal?: AbortSignal): Promise<FallowConfigApplyResult> {
	const backup = await writeBackup(plan.targetPath, plan.source.content!, plan.source.mode || 0o600);
	const temporary = temporaryConfigPath(plan.targetPath);
	try {
		await writeTemporary(plan, temporary, signal);
		const current = await snapshotSource(dirname(plan.targetPath), plan.targetPath);
		assertSameValue(current.digest, plan.source.digest, "source config content changed during apply");
		await rename(temporary, plan.targetPath);
		return appliedResult(plan, backup);
	} catch (error) {
		await cleanupPaths(temporary, backup);
		throw error;
	}
}

async function createProjectConfig(plan: FallowConfigPlan, signal?: AbortSignal): Promise<FallowConfigApplyResult> {
	if (await pathExists(plan.targetPath)) throw driftError("project config appeared after preview");
	const temporary = temporaryConfigPath(plan.targetPath);
	try {
		await writeTemporary(plan, temporary, signal);
		await link(temporary, plan.targetPath);
		await unlink(temporary).catch(ignoreCleanupError);
		return appliedResult(plan);
	} catch (error) {
		await cleanupPaths(temporary);
		throw error;
	}
}

async function writeTemporary(plan: FallowConfigPlan, temporary: string, signal?: AbortSignal): Promise<void> {
	throwIfCancelled(signal);
	await writeSyncedExclusive(temporary, plan.candidate, plan.source.mode || 0o600);
	throwIfCancelled(signal);
}

function temporaryConfigPath(target: string): string {
	return join(dirname(target), `.${basename(target)}.pi-fallow-${randomUUID()}.tmp`);
}

function appliedResult(plan: FallowConfigPlan, backup?: string): FallowConfigApplyResult {
	return {
		status: "applied",
		source: plan.preview.source,
		backup: backup ? basename(backup) : undefined,
		summary: "Applied the confirmed rule-severity change with a same-directory atomic update.",
	};
}

async function cleanupPaths(...paths: Array<string | undefined>): Promise<void> {
	await Promise.all(paths.filter((path): path is string => Boolean(path)).map((path) => unlink(path).catch(ignoreCleanupError)));
}

function ignoreCleanupError(): void {}

async function writeBackup(target: string, content: string, mode: number): Promise<string> {
	for (let suffix = 0; suffix <= 99; suffix++) {
		const candidate = backupPath(target, suffix);
		try {
			await writeSyncedExclusive(candidate, content, mode);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("No free Pi Fallow backup filename is available.");
}

function backupPath(target: string, suffix: number): string {
	return suffix ? `${target}.pi-fallow.bak.${suffix}` : `${target}.pi-fallow.bak`;
}

async function writeSyncedExclusive(path: string, content: string, mode: number): Promise<void> {
	const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		await file.writeFile(content, "utf8");
		await file.chmod(mode);
		await file.sync();
	} finally {
		await file.close();
	}
}

function buildInspection(root: string, sourcePath: string | undefined, config: Record<string, any>): FallowConfigInspection {
	const ownership = configOwnership(root, sourcePath);
	return {
		status: "ready",
		source: sourcePath ? displayPath(root, sourcePath) : undefined,
		ownership,
		format: configFormat(sourcePath),
		summary: ownershipSummary(ownership),
		counts: inspectionCounts(config),
	};
}

function configFormat(sourcePath: string | undefined): "toml" | "jsonc" | undefined {
	if (!sourcePath) return undefined;
	return sourcePath.endsWith(".toml") ? "toml" : "jsonc";
}

function ownershipSummary(ownership: ConfigOwnership): string {
	if (ownership === "none") return "No config file is present; Fallow's effective defaults are active.";
	if (ownership === "project") return "A project-owned Fallow config is active.";
	return "An inherited config is active and remains externally owned; Pi Fallow will only create or modify a project-root config.";
}

function inspectionCounts(config: Record<string, any>): NonNullable<FallowConfigInspection["counts"]> {
	const boundaries = asRecord(config.boundaries) || {};
	return {
		entries: arrayLength(config.entry),
		rules: objectLength(config.rules),
		workspaces: arrayLength(config.workspaces),
		plugins: arrayLength(config.plugins),
		boundaries: arrayLength(boundaries.zones) + arrayLength(boundaries.rules),
		overrides: arrayLength(config.overrides),
	};
}

function configOwnership(root: string, sourcePath: string | undefined): ConfigOwnership {
	if (!sourcePath) return "none";
	return dirname(resolve(sourcePath)) === root && PROJECT_CONFIG_NAMES.has(basename(sourcePath)) ? "project" : "inherited";
}

function ownershipLabel(ownership: ConfigOwnership): string {
	if (ownership === "project") return "project-owned";
	if (ownership === "inherited") return "inherited/external (read-only)";
	return "zero-config (no owned file)";
}

function displayPath(root: string, path: string): string {
	const value = relative(root, path);
	if (!value) return basename(path);
	return value.startsWith("..") || isAbsolute(value) ? path : value;
}

async function canonicalRoot(cwd: string): Promise<string> { return realpath(resolve(cwd)); }
function arrayLength(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function objectLength(value: unknown): number { return Object.keys(asRecord(value) ?? {}).length; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function driftError(message: string): Error { return new Error(`Refusing stale Fallow configuration preview: ${message}. Preview again before applying.`); }
function throwIfCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("Fallow configuration assistant cancelled; no config write was performed."); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : "Unknown configuration error."; }

class InvalidConfigError extends Error {}
