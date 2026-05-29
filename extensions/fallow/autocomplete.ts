import type { AutocompleteItem } from "@earendil-works/pi-tui";

type CompletionSpec = {
	value: string;
	label?: string;
	description?: string;
};

type FlagSpec = {
	flag: string;
	description: string;
	values?: string[];
};

const COMMANDS: CompletionSpec[] = [
	{ value: "dead-code", description: "Find unused exports, files, dependencies, and types" },
	{ value: "dupes", description: "Find duplicated code and clone groups" },
	{ value: "health", description: "Show maintainability, complexity, churn, and health metrics" },
	{ value: "audit", description: "Run a PR/change gate; use --base main for changed code" },
	{ value: "fix", description: "Preview/apply safe cleanup fixes; usually add --dry-run first" },
	{ value: "flags", description: "Analyze feature flags" },
	{ value: "list", description: "List project info, files, plugins, entry points, or boundaries" },
	{ value: "explain", description: "Explain a Fallow issue type/rule id" },
	{ value: "coverage analyze", description: "Analyze runtime coverage and cold paths" },
	{ value: "--help", description: "Show Fallow CLI help" },
];

const REF_VALUES = ["main", "master", "HEAD~1", "origin/main"];

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
	{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: REF_VALUES },
	{ flag: "--score", description: "Compute project health score/grade" },
];

const FLAGS_BY_COMMAND: Record<string, FlagSpec[]> = {
	"dead-code": [
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: REF_VALUES },
		{ flag: "--include-entry-exports", description: "Also report unused exports in entry files" },
		{ flag: "--group-by", description: "Group findings", values: ["owner", "directory", "package", "section"] },
		{ flag: "--trace", description: "Trace why an export is considered used/unused: file:export" },
		{ flag: "--trace-file", description: "Trace why a file is considered used/unused" },
		{ flag: "--trace-dependency", description: "Trace why a dependency is considered used/unused" },
	],
	dupes: [
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: REF_VALUES },
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
		{ flag: "--changed-since", description: "Compare only changed files since a git ref", values: REF_VALUES },
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
		{ flag: "--base", description: "Audit base git ref", values: REF_VALUES },
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
	list: [
		{ flag: "--entry-points", description: "Include entry points" },
		{ flag: "--files", description: "Include discovered files" },
		{ flag: "--plugins", description: "Include active framework plugins" },
		{ flag: "--boundaries", description: "Include architecture boundary zones/rules" },
	],
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
	const match = argumentText.match(/^(.*?)(\S*)$/);
	const beforeCurrent = match?.[1] ?? argumentText;
	const current = match?.[2] ?? "";
	return {
		beforeCurrent,
		current,
		previousTokens: parseTokens(beforeCurrent.trim()),
	};
}

function commandKey(tokens: string[]): string | undefined {
	const first = tokens[0];
	if (!first || first.startsWith("-")) return undefined;
	if (first === "coverage" && tokens[1] === "analyze") return "coverage analyze";
	return first;
}

function allFlags(command: string | undefined): FlagSpec[] {
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

function completeToken(beforeCurrent: string, current: string, specs: CompletionSpec[]): AutocompleteItem[] {
	return specs
		.filter((spec) => matches(spec.value, current) || matches(spec.label ?? spec.value, current))
		.map((spec) => ({
			value: `${beforeCurrent}${spec.value} `,
			label: spec.label ?? spec.value,
			description: spec.description,
		}));
}

function completeFlags(beforeCurrent: string, current: string, flags: FlagSpec[], usedFlags: Set<string>): AutocompleteItem[] {
	return flags
		.filter((spec) => !usedFlags.has(spec.flag))
		.filter((spec) => matches(spec.flag, current))
		.map((spec) => ({
			value: `${beforeCurrent}${spec.flag} `,
			label: spec.flag,
			description: spec.description,
		}));
}

function valueCompletions(beforeCurrent: string, current: string, flag: FlagSpec | undefined): AutocompleteItem[] | null {
	if (!flag?.values) return null;
	const items = flag.values
		.filter((value) => matches(value, current))
		.map((value) => ({
			value: `${beforeCurrent}${value} `,
			label: value,
			description: `${flag.flag} value`,
		}));
	return items.length ? items : null;
}

function equalsValueCompletions(beforeCurrent: string, current: string, flags: FlagSpec[]): AutocompleteItem[] | null {
	const equalsIndex = current.indexOf("=");
	if (equalsIndex === -1) return null;
	const flagName = current.slice(0, equalsIndex);
	const valuePrefix = current.slice(equalsIndex + 1);
	const flag = flags.find((candidate) => candidate.flag === flagName);
	if (!flag?.values) return null;
	const items = flag.values
		.filter((value) => matches(value, valuePrefix))
		.map((value) => ({
			value: `${beforeCurrent}${flagName}=${value} `,
			label: `${flagName}=${value}`,
			description: flag.description,
		}));
	return items.length ? items : null;
}

export function getFallowArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
	const { beforeCurrent, current, previousTokens } = currentToken(argumentText);
	const command = commandKey(previousTokens);
	const flags = allFlags(command);
	const previousFlag = previousTokens.at(-1);
	const previousFlagSpec = flags.find((flag) => flag.flag === previousFlag);
	const usedFlags = new Set(previousTokens.filter((token) => token.startsWith("--")));

	const valueItems = valueCompletions(beforeCurrent, current, previousFlagSpec)
		?? equalsValueCompletions(beforeCurrent, current, flags);
	if (valueItems) return valueItems;

	if (!command) {
		if (current.startsWith("-")) {
			const items = completeFlags(beforeCurrent, current, flags, usedFlags);
			return items.length ? items : null;
		}
		const items = completeToken(beforeCurrent, current, COMMANDS);
		return items.length ? items : null;
	}

	if (previousTokens[0] === "coverage" && previousTokens[1] !== "analyze") {
		const items = completeToken(beforeCurrent, current, [
			{ value: "analyze", description: "Analyze runtime coverage and cold paths" },
		]);
		return items.length ? items : null;
	}

	const items = completeFlags(beforeCurrent, current, flags, usedFlags);
	return items.length ? items : null;
}
