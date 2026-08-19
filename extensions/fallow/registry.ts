export type FallowPathTargets = "first" | "positionals";

export interface FallowToolCommandMetadata {
	cliPrefix: readonly string[];
	positionalTarget?: true;
	pathTargets?: FallowPathTargets;
	positionalFlags?: readonly string[];
}

interface FallowSlashRootMetadata {
	value: string;
	label?: string;
	description: string;
	autocomplete?: boolean;
	hintOrder?: number;
}

interface FallowSlashCommandMetadata {
	alias?: string;
	normalizePathTargets?: true;
	root?: FallowSlashRootMetadata;
}

interface FallowCommandRegistryEntry {
	name: string;
	tool?: FallowToolCommandMetadata;
	slash?: FallowSlashCommandMetadata;
}

const GUARD_POSITIONAL_FLAGS = [
	"--allow-remote-extends", "--pretty", "-q", "--quiet", "--no-cache", "--diff-stdin",
	"--production", "--no-production", "--performance", "--explain", "--explain-skipped", "--summary",
	"--ci", "--fail-on-issues", "--fail-on-regression", "--dupes-skip-local", "--dupes-cross-language",
	"--dupes-ignore-imports", "--dupes-no-ignore-imports", "--include-entry-exports", "--type-aware",
	"--no-type-aware", "-h", "--help",
] as const;

const fallowCommandRegistry = [
	{
		name: "pr",
		slash: { root: { value: "pr", description: "Run audit with detected PR base (new-only)", hintOrder: 2 } },
	},
	{
		name: "run",
		slash: { root: { value: "run", description: "Run the configured default command (health unless overridden)" } },
	},
	{
		name: "rerun",
		slash: { root: { value: "rerun", description: "Rerun the last /fallow command", hintOrder: 3 } },
	},
	{
		name: "about",
		slash: { root: { value: "about", description: "Show Pi Fallow version, update, and project links", hintOrder: 0 } },
	},
	{
		name: "issues",
		slash: {
			root: { value: "issues", description: "Aggregate project code-quality and security findings in one report", hintOrder: 1 },
		},
	},
	{
		name: "all",
		tool: { cliPrefix: [] },
		slash: {
			alias: "all",
			root: { value: "all", description: "Run full repository checks and checks summary", hintOrder: 1 },
		},
	},
	{
		name: "dead-code",
		tool: { cliPrefix: ["dead-code"] },
		slash: { root: { value: "dead-code", description: "Find unused exports, files, dependencies, and types", hintOrder: 4 } },
	},
	{
		name: "check-changed",
		tool: { cliPrefix: [] },
		slash: {
			alias: "check-changed",
			root: { value: "check-changed", description: "Run combined changed-file checks; add --changed-since main/origin/main" },
		},
	},
	{
		name: "dupes",
		tool: { cliPrefix: ["dupes"] },
		slash: { root: { value: "dupes", description: "Find duplicated code and clone groups", hintOrder: 5 } },
	},
	{
		name: "health",
		tool: { cliPrefix: ["health"] },
		slash: { root: { value: "health", description: "Show maintainability, complexity, churn, and health metrics", hintOrder: 6 } },
	},
	{
		name: "audit",
		tool: { cliPrefix: ["audit"] },
		slash: { root: { value: "audit", description: "Run a PR/change gate; use --base main --gate new-only for PRs", hintOrder: 7 } },
	},
	{
		name: "fix-preview",
		tool: { cliPrefix: ["fix", "--dry-run"] },
		slash: { alias: "fix-preview" },
	},
	{
		name: "fix-apply",
		tool: { cliPrefix: ["fix", "--yes"] },
		slash: { alias: "fix-apply" },
	},
	{
		name: "flags",
		tool: { cliPrefix: ["flags"] },
		slash: { root: { value: "flags", description: "Analyze feature flags", hintOrder: 20 } },
	},
	{
		name: "inspect",
		tool: { cliPrefix: ["inspect"] },
		slash: {
			root: { value: "inspect", description: "Inspect one file or exported symbol", autocomplete: false, hintOrder: 8 },
		},
	},
	{
		name: "trace-symbol",
		tool: { cliPrefix: ["trace"], positionalTarget: true, pathTargets: "first" },
		slash: { root: { value: "trace", description: "Trace a symbol call chain: trace path/to/file.ts:exportName", hintOrder: 9 } },
	},
	{
		name: "security",
		tool: { cliPrefix: ["security"] },
		slash: { root: { value: "security", description: "Surface local security candidates for agent verification", hintOrder: 10 } },
	},
	{
		name: "architecture",
		tool: {
			cliPrefix: ["guard"],
			positionalTarget: true,
			pathTargets: "positionals",
			positionalFlags: GUARD_POSITIONAL_FLAGS,
		},
		slash: {
			alias: "architecture",
			normalizePathTargets: true,
			root: { value: "architecture", description: "Show which architecture rules apply to files before changing them", hintOrder: 11 },
		},
	},
	{
		name: "workspaces",
		tool: { cliPrefix: ["workspaces"] },
		slash: { root: { value: "workspaces", description: "Show monorepo workspace discovery diagnostics", hintOrder: 13 } },
	},
	{
		name: "config",
		tool: { cliPrefix: ["config"] },
		slash: { root: { value: "config", description: "Show resolved Fallow config", hintOrder: 14 } },
	},
	{
		name: "schema",
		tool: { cliPrefix: ["schema"] },
		slash: { root: { value: "schema", description: "Dump Fallow's machine-readable CLI capability schema", hintOrder: 15 } },
	},
	{
		name: "decision-surface",
		tool: { cliPrefix: ["decision-surface"] },
		slash: {
			root: { value: "decision-surface", description: "Surface structural decisions embedded in the current change", autocomplete: false, hintOrder: 12 },
		},
	},
	{
		name: "impact",
		tool: { cliPrefix: ["impact"] },
		slash: { root: { value: "impact", description: "Show local Fallow impact metrics", hintOrder: 16 } },
	},
	{
		name: "project-info",
		tool: { cliPrefix: ["list"] },
		slash: {
			alias: "project-info",
			root: { value: "project-info", description: "Show project info (entry points/files/plugins/boundaries)", hintOrder: 18 },
		},
	},
	{
		name: "list-boundaries",
		tool: { cliPrefix: ["list", "--boundaries"] },
		slash: { alias: "list-boundaries" },
	},
	{
		name: "explain",
		tool: { cliPrefix: ["explain"], positionalTarget: true },
		slash: { root: { value: "explain", description: "Explain a Fallow issue type/rule id", hintOrder: 22 } },
	},
	{
		name: "trace-export",
		tool: { cliPrefix: ["dead-code", "--trace"], positionalTarget: true, pathTargets: "first" },
		slash: {
			alias: "trace-export",
			root: { value: "trace-export", description: "Trace a specific export: trace-export path/to/file.ts exportName" },
		},
	},
	{
		name: "trace-file",
		tool: { cliPrefix: ["dead-code", "--trace-file"], positionalTarget: true, pathTargets: "first" },
		slash: {
			alias: "trace-file",
			root: { value: "trace-file", description: "Investigate one file: trace-file path/to/file.ts" },
		},
	},
	{
		name: "trace-dependency",
		tool: { cliPrefix: ["dead-code", "--trace-dependency"], positionalTarget: true },
		slash: {
			alias: "trace-dependency",
			root: { value: "trace-dependency", description: "Trace a package dependency" },
		},
	},
	{
		name: "trace-clone",
		tool: { cliPrefix: ["dupes", "--trace"], positionalTarget: true, pathTargets: "first" },
		slash: {
			alias: "trace-clone",
			root: { value: "trace-clone", description: "Trace a duplication clone at path/to/file.ts:line" },
		},
	},
	{
		name: "coverage-analyze",
		tool: { cliPrefix: ["coverage", "analyze"] },
		slash: {
			alias: "coverage-analyze",
			root: { value: "coverage analyze", description: "Analyze runtime coverage and cold paths", hintOrder: 21 },
		},
	},
	{
		name: "fix",
		slash: { root: { value: "fix", description: "Preview/apply safe cleanup fixes; usually add --dry-run first", hintOrder: 17 } },
	},
	{
		name: "list",
		slash: { root: { value: "list", description: "List project info, files, plugins, entry points, boundaries, or workspaces", hintOrder: 19 } },
	},
	{
		name: "help",
		slash: { root: { value: "--help", description: "Show Fallow CLI help" } },
	},
] as const satisfies readonly FallowCommandRegistryEntry[];

type RegistryEntry = typeof fallowCommandRegistry[number];
type ToolCommandName<Entry> = Entry extends { name: infer Name extends string; tool: FallowToolCommandMetadata }
	? Name
	: never;

export type FallowToolCommand = ToolCommandName<RegistryEntry>;

export interface FallowToolCommandSpec extends FallowToolCommandMetadata {
	name: FallowToolCommand;
}

export interface FallowSlashAliasSpec extends FallowToolCommandSpec {
	alias: string;
	slashPathTargets?: FallowPathTargets;
}

interface FallowSlashRootSpec extends FallowSlashRootMetadata {
	registryName: string;
}

const toolCommandSpecs = fallowCommandRegistry
	.filter((entry): entry is RegistryEntry & { tool: FallowToolCommandMetadata } => "tool" in entry)
	.map((entry) => ({ name: entry.name, ...entry.tool })) as FallowToolCommandSpec[];

const toolCommandSpecsByName = new Map(toolCommandSpecs.map((entry) => [entry.name, entry]));

type SlashAliasRegistryEntry = RegistryEntry & {
	tool: FallowToolCommandMetadata;
	slash: FallowSlashCommandMetadata & { alias: string };
};

const slashAliasSpecs = fallowCommandRegistry
	.filter(hasSlashAlias)
	.map(toSlashAliasSpec);

const slashAliasSpecsByName = new Map(slashAliasSpecs.map((entry) => [entry.alias, entry]));

function hasSlashAlias(entry: RegistryEntry): entry is SlashAliasRegistryEntry {
	return "tool" in entry && "slash" in entry && "alias" in entry.slash;
}

function toSlashAliasSpec(entry: SlashAliasRegistryEntry): FallowSlashAliasSpec {
	const slashPathTargets = "normalizePathTargets" in entry.slash ? entry.tool.pathTargets : undefined;
	return { name: entry.name, alias: entry.slash.alias, slashPathTargets, ...entry.tool } as FallowSlashAliasSpec;
}

export const fallowToolCommands = toolCommandSpecs.map((entry) => entry.name);

export const fallowSlashRootCommands = fallowCommandRegistry.flatMap((entry): FallowSlashRootSpec[] => {
	if (!("slash" in entry) || !("root" in entry.slash)) return [];
	return [{ registryName: entry.name, ...entry.slash.root }];
});

export const fallowArgumentHint = `[${fallowSlashRootCommands
	.filter((command) => command.hintOrder !== undefined)
	.sort((left, right) => left.hintOrder! - right.hintOrder!)
	.map((command) => command.value)
	.join("|")}] [options]`;

export function getFallowToolCommandSpec(command: string): FallowToolCommandSpec | undefined {
	return toolCommandSpecsByName.get(command as FallowToolCommand);
}

export function getFallowSlashAliasSpec(command: string): FallowSlashAliasSpec | undefined {
	return slashAliasSpecsByName.get(command);
}
