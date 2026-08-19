import { isPositionalCliArg, stripAtPrefix } from "../path";
import { getFallowSlashAliasSpec, type FallowSlashAliasSpec } from "../registry";
import { fallowProjectIssues } from "./issues";

type Notify = (message: string, level: "info" | "warning") => void;

const FALLBACK_DEFAULT_COMMAND = ["issues"];
const INVALID_DEFAULT_COMMANDS = new Set(["run", "rerun", "about", "version", "update"]);

export function resolveFallowRunArgs(rawArgs: string[], configuredDefaultArgs: string[]): string[] {
	if (isExplicitFallowCommand(rawArgs)) return rawArgs;
	const defaultArgs = resolveDefaultArgs(configuredDefaultArgs);
	validateDefaultCommand(defaultArgs);
	return [...defaultArgs, ...runOverrides(rawArgs)];
}

function isExplicitFallowCommand(args: string[]): boolean {
	return args.length > 0 && args[0] !== "run";
}

function resolveDefaultArgs(configured: string[]): string[] {
	return configured.length ? configured : FALLBACK_DEFAULT_COMMAND;
}

function runOverrides(args: string[]): string[] {
	return args[0] === "run" ? args.slice(1) : [];
}

function validateDefaultCommand(args: string[]): void {
	if (!args[0] || INVALID_DEFAULT_COMMANDS.has(args[0])) {
		throw new Error("PI_FALLOW_DEFAULT_COMMAND must start with an executable command such as issues, health, or dead-code.");
	}
}

export function needsFallowBaseDetection(rawArgs: string[]): boolean {
	if (rawArgs[0] !== "pr") return false;
	const prArgs = rawArgs.slice(1);
	if (prArgs.some((arg) => arg === "--help" || arg === "-h")) return false;
	return !hasFlag(prArgs, "--base");
}

export function normalizeFallowArgs(
	rawArgs: string[],
	baseRef: string,
	lastFallowArgs: string[] | null,
	notify: Notify,
): string[] | null {
	const firstArg = rawArgs[0];
	if (firstArg === "rerun") return buildRerunFallowArgs(rawArgs, lastFallowArgs, notify);
	if (firstArg === "pr") return buildPrFallowArgs(rawArgs.slice(1), baseRef);
	return resolveFallbackArgs(rawArgs);
}

function buildRerunFallowArgs(
	rawArgs: string[],
	lastFallowArgs: string[] | null,
	notify: Notify,
): string[] | null {
	if (!lastFallowArgs) {
		notify("No previous /fallow command to rerun.", "warning");
		return null;
	}
	if (rawArgs.length > 1) notify("/fallow rerun uses the last command and ignores extra arguments.", "info");
	return [...lastFallowArgs];
}

function buildPrFallowArgs(prArgs: string[], baseRef: string): string[] {
	const skipDefaults = prArgs.some((arg) => arg === "--help" || arg === "-h");
	const fallbackArgs = skipDefaults ? prArgs : withBaseAndGateFallback(prArgs, baseRef);
	return ["audit", ...fallbackArgs];
}

function withBaseAndGateFallback(args: string[], baseRef: string): string[] {
	const normalized = [...args];
	if (!hasFlag(normalized, "--base")) normalized.push("--base", baseRef);
	if (!hasFlag(normalized, "--gate")) normalized.push("--gate", "new-only");
	return normalized;
}

function hasFlag(args: string[], flag: string): boolean {
	for (const arg of args) {
		if (arg === flag || arg.startsWith(`${flag}=`)) return true;
	}
	return false;
}

function resolveFallbackArgs(rawArgs: string[]): string[] {
	const normalized = [...rawArgs];
	validateRequiredCommandArgs(normalized);
	validateProjectIssueArgs(normalized);
	const alias = getFallowSlashAliasSpec(normalized[0] ?? "");
	return alias ? buildFallowSlashAliasArgs(normalized, alias) : normalized;
}

function validateProjectIssueArgs(args: string[]): void {
	if (args[0] === "issues") fallowProjectIssues.partitionArgs(args.slice(1));
}

function validateRequiredCommandArgs(args: string[]): void {
	if (args[0] !== "explain") return;
	if (args.some((arg) => arg === "--help" || arg === "-h")) return;
	if (args.slice(1).some((arg) => !arg.startsWith("-"))) return;
	throw new Error("explain requires at least one issue type, for example: /fallow explain unused-export");
}

function buildFallowSlashAliasArgs(args: string[], alias: FallowSlashAliasSpec): string[] {
	if (alias.name === "check-changed") return [...alias.cliPrefix, ...buildCheckChangedFallowArgs(args)];
	if (alias.name === "trace-export") return buildTraceExportArgs(args, alias.cliPrefix);
	if (alias.name === "trace-clone") return parseTraceCloneArgs(args, alias.cliPrefix);
	const aliasArgs = normalizeSlashAliasPathTargets(alias, args.slice(1));
	validateSlashAliasTarget(alias, aliasArgs);
	return [...alias.cliPrefix, ...aliasArgs];
}

function buildCheckChangedFallowArgs(args: string[]): string[] {
	const changedArgs = args.slice(1);
	const wantsHelp = changedArgs.some((arg) => arg === "--help" || arg === "-h");
	if (!wantsHelp && !hasFlag(changedArgs, "--changed-since") && !hasFlag(changedArgs, "--base")) {
		throw new Error("check-changed requires --changed-since or --base.");
	}
	return changedArgs;
}

function buildTraceExportArgs(args: string[], prefix: readonly string[]): string[] {
	if (!args[1] || !args[2]) throw new Error("trace-export requires file and exportName.");
	return [...prefix, `${args[1]}:${args[2]}`, ...args.slice(3)];
}

const SLASH_TARGET_ERRORS = new Map<string, string>([
	["trace-file", "trace-file requires file."],
	["trace-dependency", "trace-dependency requires packageName."],
]);

function validateSlashAliasTarget(alias: FallowSlashAliasSpec, args: string[]): void {
	const message = slashAliasTargetError(alias, args[0]);
	if (message) throw new Error(message);
}

function slashAliasTargetError(alias: FallowSlashAliasSpec, target: string | undefined): string | undefined {
	if (!alias.positionalTarget) return undefined;
	if (isSlashTarget(target)) return undefined;
	return SLASH_TARGET_ERRORS.get(alias.name) ?? `${alias.alias} requires its target as the first argument.`;
}

function isSlashTarget(target: string | undefined): boolean {
	return !!target && !target.startsWith("-");
}

function normalizeSlashAliasPathTargets(alias: FallowSlashAliasSpec, args: string[]): string[] {
	if (!alias.slashPathTargets) return args;
	return args.map((arg, index) => isSlashPathTarget(alias, args, index) ? stripAtPrefix(arg) : arg);
}

function isSlashPathTarget(alias: FallowSlashAliasSpec, args: string[], index: number): boolean {
	if (alias.slashPathTargets === "first") return index === 0;
	return isPositionalCliArg(args, index, alias.positionalFlags ?? []);
}

function parseTraceCloneArgs(args: string[], prefix: readonly string[]): string[] {
	const { fileOrPath, line } = getTraceCloneInput(args);
	if (line) return buildTraceCloneFromLine(fileOrPath, line, args, prefix);
	const parsed = parseTraceCloneFromPath(fileOrPath);
	return buildTraceCloneFromParsed(parsed, args, prefix);
}

function getTraceCloneInput(args: string[]): { fileOrPath: string; line?: string } {
	if (!args[1]) throw new Error("trace-clone requires file and line.");
	return { fileOrPath: args[1], line: args[2] };
}

function parseTraceCloneFromPath(fileOrPath: string): RegExpMatchArray {
	const match = /^(.*):(\d+)$/.exec(fileOrPath);
	if (!match) throw new Error("trace-clone requires file and line.");
	return match;
}

function buildTraceCloneFromLine(
	fileOrPath: string,
	line: string,
	args: string[],
	prefix: readonly string[],
): string[] {
	if (!/^\d+$/.test(line)) throw new Error("trace-clone requires file and numeric line.");
	return [...prefix, `${fileOrPath}:${line}`, ...args.slice(3)];
}

function buildTraceCloneFromParsed(
	match: RegExpMatchArray,
	args: string[],
	prefix: readonly string[],
): string[] {
	return [...prefix, `${match[1]}:${match[2]}`, ...args.slice(2)];
}
