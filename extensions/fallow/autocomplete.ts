import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type CompletionSpec = {
	value: string;
	label?: string;
	description?: string;
};

type FlagValueProvider = () => string[];

type FlagSpec = {
	flag: string;
	description: string;
	values?: string[] | FlagValueProvider;
};

const COMMANDS: CompletionSpec[] = [
	{ value: "pr", label: "pr", description: "Run audit with detected PR base (new-only)" },
	{ value: "rerun", label: "rerun", description: "Rerun the last /fallow command" },
	{ value: "all", description: "Run full repository checks and checks summary" },
	{ value: "audit --base main --gate new-only", label: "audit PR (main)", description: "Report only issues introduced by the PR diff vs main" },
	{ value: "audit --base origin/main --gate new-only", label: "audit PR (origin/main)", description: "Report only issues introduced by the PR diff vs origin/main" },
	{ value: "check-changed --changed-since main", label: "check-changed (main)", description: "Run combined changed-file checks since main" },
	{ value: "dead-code", description: "Find unused exports, files, dependencies, and types" },
	{ value: "check-changed", description: "Run combined changed-file checks; add --changed-since main/origin/main" },
	{ value: "project-info", description: "Show project info (entry points/files/plugins/boundaries)" },
	{ value: "dupes", description: "Find duplicated code and clone groups" },
	{ value: "health", description: "Show maintainability, complexity, churn, and health metrics" },
	{ value: "audit", description: "Run a PR/change gate; use --base main --gate new-only for PRs" },
	{ value: "trace-file", description: "Investigate one file: trace-file path/to/file.ts" },
	{ value: "trace-export", description: "Trace a specific export: trace-export path/to/file.ts exportName" },
	{ value: "trace-dependency", description: "Trace a package dependency" },
	{ value: "trace-clone", description: "Trace a duplication clone at path/to/file.ts:line" },
	{ value: "fix", description: "Preview/apply safe cleanup fixes; usually add --dry-run first" },
	{ value: "flags", description: "Analyze feature flags" },
	{ value: "list", description: "List project info, files, plugins, entry points, or boundaries" },
	{ value: "explain", description: "Explain a Fallow issue type/rule id" },
	{ value: "coverage analyze", description: "Analyze runtime coverage and cold paths" },
	{ value: "--help", description: "Show Fallow CLI help" },
];

const STATIC_REF_VALUES = ["main", "master", "HEAD~1", "origin/main", "origin/master"];
const REF_CACHE_TTL_MS = 3_000;
const MAX_DYNAMIC_REF_VALUES = 40;

interface GitRefCacheEntry {
	references: string[];
	expiresAt: number;
}

const gitRefCache = new Map<string, GitRefCacheEntry>();

function uniqueValues(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function prioritizeRefs(values: string[]): string[] {
	const preferred = ["origin/main", "origin/master", "main", "master", "HEAD~1", "HEAD"];
	const unique = new Set(values);
	const ordered = preferred.filter((value) => {
		if (!unique.has(value)) return false;
		unique.delete(value);
		return true;
	});
	return [...ordered, ...[...unique].sort((a, b) => a.localeCompare(b))].slice(0, MAX_DYNAMIC_REF_VALUES);
}

function readGitReferences(cwd: string): string[] {
	const output = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], {
		cwd,
		timeout: 1200,
	});
	const refs = String(output)
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => Boolean(value) && value !== "HEAD" && !value.endsWith("/HEAD"));
	return uniqueValues(refs);
}

function getRefValuesFromGit(): string[] {
	const cwd = resolve(process.cwd());
	const now = Date.now();
	const cached = gitRefCache.get(cwd);
	if (cached && cached.expiresAt > now) return cached.references;
	let refs = STATIC_REF_VALUES;
	try {
		refs = prioritizeRefs(readGitReferences(cwd));
	} catch {
		refs = [...STATIC_REF_VALUES];
	}
	const merged = uniqueValues([...refs, ...STATIC_REF_VALUES]);
	const result = prioritizeRefs(merged);
	gitRefCache.set(cwd, { references: result, expiresAt: now + REF_CACHE_TTL_MS });
	return result;
}

function getRefValues(): string[] {
	return getRefValuesFromGit();
}

const COMMON_FLAGS: FlagSpec[] = [
	{ flag: "--config", description: "Path to .fallowrc.json/.jsonc or fallow.toml" },
	{ flag: "--workspace", description: "Workspace name/glob" },
	{ flag: "--production", description: "Exclude test/story/dev-only code paths where supported" },
	{ flag: "--no-cache", description: "Disable Fallow cache" },
	{ flag: "--threads", description: "Worker thread count", values: ["1", "2", "4", "8"] },
	{ flag: "--format", description: "Output format (the Pi command adds json automatically)", values: ["json"] },
	{ flag: "--quiet", description: "Reduce non-JSON log output" },
	{ flag: "--help", description: "Show help for this command" },
];

const ROOT_FLAGS: FlagSpec[] = [
	{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: getRefValues },
	{ flag: "--score", description: "Compute project health score/grade" },
];

const CHANGED_FILE_FLAGS: FlagSpec[] = [
	{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: getRefValues },
	{ flag: "--include-entry-exports", description: "Also report unused exports in entry files" },
];

const PROJECT_INFO_FLAGS: FlagSpec[] = [
	{ flag: "--entry-points", description: "Include entry points" },
	{ flag: "--files", description: "Include discovered files" },
	{ flag: "--plugins", description: "Include active framework plugins" },
	{ flag: "--boundaries", description: "Include architecture boundary zones/rules" },
];

const FLAGS_BY_COMMAND: Record<string, FlagSpec[]> = {
	all: ROOT_FLAGS,
	"dead-code": [
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: getRefValues },
		{ flag: "--include-entry-exports", description: "Also report unused exports in entry files" },
		{ flag: "--group-by", description: "Group findings", values: ["owner", "directory", "package", "section"] },
		{ flag: "--trace", description: "Trace why an export is considered used/unused: file:export" },
		{ flag: "--trace-file", description: "Trace why a file is considered used/unused" },
		{ flag: "--trace-dependency", description: "Trace why a dependency is considered used/unused" },
	],
	"check-changed": CHANGED_FILE_FLAGS,
	"trace-file": [],
	dupes: [
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: getRefValues },
		{ flag: "--top", description: "Limit top clone groups", values: ["5", "10", "20", "50"] },
		{ flag: "--min-tokens", description: "Minimum duplicate token threshold", values: ["50", "100", "150"] },
		{ flag: "--min-lines", description: "Minimum duplicate line threshold", values: ["5", "10", "20"] },
		{ flag: "--threshold", description: "Duplication threshold", values: ["0.8", "0.9"] },
		{ flag: "--min-occurrences", description: "Minimum duplicate occurrences", values: ["2", "3"] },
		{ flag: "--skip-local", description: "Skip local clones within the same file" },
		{ flag: "--cross-language", description: "Enable cross-language clone detection" },
		{ flag: "--ignore-imports", description: "Ignore import declarations" },
		{ flag: "--trace", description: "Trace a clone at file:line" },
	],
	health: [
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: getRefValues },
		{ flag: "--top", description: "Limit top health findings", values: ["5", "10", "20", "50"] },
		{ flag: "--group-by", description: "Group findings", values: ["owner", "directory", "package", "section"] },
		{ flag: "--file-scores", description: "Include file maintainability scores" },
		{ flag: "--hotspots", description: "Include churn-backed hotspots" },
		{ flag: "--targets", description: "Include ranked refactoring targets" },
		{ flag: "--score", description: "Compute project health score/grade" },
		{ flag: "--trend", description: "Compare against the latest saved snapshot" },
		{ flag: "--coverage", description: "Coverage input path" },
		{ flag: "--coverage-root", description: "Absolute source root prefix to strip from coverage paths" },
		{ flag: "--runtime-coverage", description: "V8/Istanbul runtime coverage input" },
		{ flag: "--max-crap", description: "Maximum CRAP score threshold", values: ["15", "30", "60"] },
	],
	audit: [
		{ flag: "--base", description: "Audit base git ref", values: getRefValues },
		{ flag: "--gate", description: "Audit gate scope", values: ["new-only", "all"] },
		{ flag: "--explain", description: "Include rule explanations in JSON output" },
		{ flag: "--include-entry-exports", description: "Also report unused exports in entry files" },
		{ flag: "--coverage", description: "Coverage input path" },
		{ flag: "--coverage-root", description: "Absolute source root prefix to strip from coverage paths" },
		{ flag: "--runtime-coverage", description: "V8/Istanbul runtime coverage input" },
		{ flag: "--max-crap", description: "Maximum CRAP score threshold", values: ["15", "30", "60"] },
		{ flag: "--diff-file", description: "Diff file path for line-scoped review/runtime verdicts" },
	],
	fix: [
		{ flag: "--dry-run", description: "Preview safe cleanup fixes without writing changes" },
		{ flag: "--yes", description: "Apply safe cleanup fixes" },
		{ flag: "--include-entry-exports", description: "Also process unused exports in entry files" },
		{ flag: "--no-create-config", description: "Do not create .fallowrc.json for add-to-config actions" },
	],
	flags: [
		{ flag: "--top", description: "Limit top feature-flag findings", values: ["5", "10", "20", "50"] },
	],
	list: PROJECT_INFO_FLAGS,
	"project-info": PROJECT_INFO_FLAGS,
	"list-boundaries": [],
	"fix-preview": [],
	"fix-apply": [],
	"coverage analyze": [
		{ flag: "--runtime-coverage", description: "V8/Istanbul runtime coverage input" },
		{ flag: "--top", description: "Limit top coverage findings", values: ["5", "10", "20", "50"] },
		{ flag: "--group-by", description: "Group findings", values: ["owner", "directory", "package", "section"] },
	],
};

function parseTokens(input: string): string[] {
	const tokens: string[] = [];
	const tokenPattern = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g;
	for (const match of input.matchAll(tokenPattern)) {
		const raw = match[0];
		tokens.push(raw.replace(/^(["'])(.*)\1$/, "$2"));
	}
	return tokens;
}

function currentToken(argumentText: string): { beforeCurrent: string; current: string; previousTokens: string[] } {
	const match = splitCurrentToken(argumentText);
	return {
		beforeCurrent: match.beforeCurrent,
		current: match.current,
		previousTokens: parseTokens(match.beforeCurrent.trim()),
	};
}

function splitCurrentToken(argumentText: string): { beforeCurrent: string; current: string } {
	const match = argumentText.match(/^(.*?)(\S*)$/) ?? ["", argumentText, ""];
	const [, beforeCurrent, current] = match;
	return { beforeCurrent, current };
}

function commandKey(tokens: string[]): string | undefined {
	const first = tokens[0];
	if (!first || first.startsWith("-")) return undefined;
	if (isCoverageAnalyze(first, tokens[1])) return "coverage analyze";
	return normalizeRootCommand(first);
}

function normalizeRootCommand(command: string): string {
	return command === "pr" ? "audit" : command;
}

function isCoverageAnalyze(first: string, second: string | undefined): boolean {
	return first === "coverage" && second === "analyze";
}

function allFlags(command: string | undefined): FlagSpec[] {
	if (command === "rerun") return [];
	const commandFlags = command ? FLAGS_BY_COMMAND[command] ?? [] : ROOT_FLAGS;
	const seen = new Set<string>();
	return [...commandFlags, ...COMMON_FLAGS].filter((flag) => {
		if (seen.has(flag.flag)) return false;
		seen.add(flag.flag);
		return true;
	});
}

function matches(value: string, prefix: string): boolean {
	return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function getFallowRootCommandCompletions(): AutocompleteItem[] {
	return COMMANDS.map((spec) => ({
		value: `fallow ${spec.value}`,
		label: spec.label ?? spec.value,
		description: spec.description,
	}));
}

const fallbackCompletion = {
	getFallowRootCommandCompletions,
	getFallowArgumentCompletions,
};

export const fallowCompletions = fallbackCompletion;

function completeToken(beforeCurrent: string, current: string, specs: CompletionSpec[]): AutocompleteItem[] {
	return specs
		.filter((spec) => matches(spec.value, current) || matches(spec.label ?? spec.value, current))
		.map((spec) => ({
			value: `${beforeCurrent}${spec.value} `,
			label: spec.label ?? spec.value,
			description: spec.description,
		}));
}



function valuesForFlag(flag: FlagSpec): string[] | undefined {
	if (!flag.values) return undefined;
	return typeof flag.values === "function" ? flag.values() : flag.values;
}

function valueCompletions(beforeCurrent: string, current: string, flag: FlagSpec | undefined): AutocompleteItem[] | null {
	const items = collectFlagValueCompletions(beforeCurrent, current, flag);
	return items.length ? items : null;
}

function collectFlagValueCompletions(beforeCurrent: string, current: string, flag: FlagSpec | undefined): AutocompleteItem[] {
	if (!flag) return [];
	const values = valuesForFlag(flag);
	if (!values?.length) return [];
	return values
		.filter((value) => matches(value, current))
		.map((value) => ({
			value: `${beforeCurrent}${value} `,
			label: value,
			description: `${flag.flag} value`,
		}));
}

function equalsValueCompletions(beforeCurrent: string, current: string, flags: FlagSpec[]): AutocompleteItem[] | null {
	const matchesValues = collectEqualsValueCompletions(beforeCurrent, current, flags);
	return matchesValues.length ? matchesValues : null;
}

function collectEqualsValueCompletions(beforeCurrent: string, current: string, flags: FlagSpec[]): AutocompleteItem[] {
	const [flagName, valuePrefix] = splitEqualsToken(current);
	if (!flagName) return [];
	const flag = findFlagByName(flags, flagName);
	const values = valuesForFlag(flag);
	return buildEqualsValueCompletions(beforeCurrent, flagName, valuePrefix, values, flag?.description);
}

function findFlagByName(flags: FlagSpec[], flagName: string): FlagSpec | undefined {
	return flags.find((candidate) => candidate.flag === flagName);
}

function buildEqualsValueCompletions(
	beforeCurrent: string,
	flagName: string,
	valuePrefix: string,
	values: string[] | undefined,
	description: string | undefined,
): AutocompleteItem[] {
	if (!values?.length) return [];
	return buildEqualsValueMatches(beforeCurrent, flagName, valuePrefix, values, description ?? "");
}

function splitEqualsToken(current: string): [string | undefined, string] {
	const equalsIndex = current.indexOf("=");
	if (equalsIndex === -1) return [undefined, ""];
	return [current.slice(0, equalsIndex), current.slice(equalsIndex + 1)];
}

function buildEqualsValueMatches(
	beforeCurrent: string,
	flagName: string,
	valuePrefix: string,
	values: string[],
	description: string,
): AutocompleteItem[] {
	return values
		.filter((value) => matches(value, valuePrefix))
		.map((value) => ({
			value: `${beforeCurrent}${flagName}=${value} `,
			label: `${flagName}=${value}`,
			description,
		}));
}

function getFallowArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
	const context = analyzeFallowArgumentContext(argumentText);
	const valueItems = pickValueCompletions(context);
	if (valueItems) return valueItems;
	return resolvePositionalCompletions(context);
}

function analyzeFallowArgumentContext(argumentText: string) {
	const { beforeCurrent, current, previousTokens } = currentToken(argumentText);
	const command = commandKey(previousTokens);
	const flags = allFlags(command);
	const previousFlag = previousTokens.at(-1);
	const previousFlagSpec = flags.find((flag) => flag.flag === previousFlag);
	const usedFlags = usedFlagsFromTokens(previousTokens);

	return { beforeCurrent, current, previousTokens, command, flags, previousFlagSpec, usedFlags };
}

function usedFlagsFromTokens(previousTokens: string[]): Set<string> {
	const values = new Set<string>();
	for (const token of previousTokens) {
		if (token.startsWith("--")) values.add(token);
	}
	return values;
}

function pickValueCompletions(
	context: ReturnType<typeof analyzeFallowArgumentContext>,
): AutocompleteItem[] | null {
	const equalItems = valueCompletions(context.beforeCurrent, context.current, context.previousFlagSpec)
		?? equalsValueCompletions(context.beforeCurrent, context.current, context.flags);
	if (equalItems) return equalItems;
	return null;
}

function resolvePositionalCompletions(context: ReturnType<typeof analyzeFallowArgumentContext>): AutocompleteItem[] | null {
	if (!context.command) return completeRootPosition(context);
	if (context.previousTokens[0] === "coverage" && context.previousTokens[1] !== "analyze") {
		return completeCoverageAnalyze(context);
	}
	return completeFlags(context.beforeCurrent, context.current, context.flags, context.usedFlags);
}

function completeRootPosition(context: ReturnType<typeof analyzeFallowArgumentContext>): AutocompleteItem[] | null {
	if (context.current.startsWith("-")) return completeFlags(context.beforeCurrent, context.current, context.flags, context.usedFlags);
	const items = completeToken(context.beforeCurrent, context.current, COMMANDS);
	return items.length ? items : null;
}

function completeCoverageAnalyze(context: ReturnType<typeof analyzeFallowArgumentContext>): AutocompleteItem[] | null {
	const items = completeToken(context.beforeCurrent, context.current, [
		{ value: "analyze", description: "Analyze runtime coverage and cold paths" },
	]);
	return items.length ? items : null;
}

function completeFlags(
	beforeCurrent: string,
	current: string,
	flags: FlagSpec[],
	usedFlags: Set<string>,
): AutocompleteItem[] | null {
	const items = flags
		.filter((spec) => !usedFlags.has(spec.flag))
		.filter((spec) => matches(spec.flag, current))
		.map((spec) => ({
			value: `${beforeCurrent}${spec.flag} `,
			label: spec.flag,
			description: spec.description,
		}));
	return items.length ? items : null;
}

