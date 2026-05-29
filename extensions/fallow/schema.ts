import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const FallowCommand = StringEnum([
	"all",
	"dead-code",
	"check-changed",
	"dupes",
	"health",
	"audit",
	"fix-preview",
	"fix-apply",
	"flags",
	"project-info",
	"list-boundaries",
	"explain",
	"trace-export",
	"trace-file",
	"trace-dependency",
	"trace-clone",
	"coverage-analyze",
] as const);

const GroupBy = StringEnum(["owner", "directory", "package", "section"] as const);
const AuditGate = StringEnum(["new-only", "all"] as const);

export const fallowRunParams = Type.Object({
	command: FallowCommand,

	// Common execution/configuration
	root: Type.Optional(Type.String({ description: "Project root to run fallow in. Defaults to Pi's current working directory." })),
	config: Type.Optional(Type.String({ description: "Path to .fallowrc.json/.jsonc or fallow.toml." })),
	workspace: Type.Optional(Type.Union([
		Type.String({ description: "Workspace name/glob." }),
		Type.Array(Type.String(), { description: "Workspace names/globs; passed comma-separated." }),
	])),
	production: Type.Optional(Type.Boolean({ description: "Exclude test/story/dev-only code paths where supported." })),
	changedSince: Type.Optional(Type.String({ description: "Git ref for changed-file analysis (for check-changed, dead-code, dupes, or health), e.g. main or origin/main." })),
	base: Type.Optional(Type.String({ description: "Audit base ref for PR/new-issue gates, e.g. main or origin/main. Alias of changedSince for check-changed." })),
	noCache: Type.Optional(Type.Boolean({ description: "Pass --no-cache." })),
	threads: Type.Optional(Type.Number({ description: "Worker thread count." })),
	timeoutSecs: Type.Optional(Type.Number({ description: "Process timeout in seconds. Defaults to FALLOW_TIMEOUT_SECS or 120." })),

	// Dead-code / traces
	includeEntryExports: Type.Optional(Type.Boolean({ description: "Also report unused exports in entry files." })),
	file: Type.Optional(Type.String({ description: "File for trace-file, trace-export, or trace-clone." })),
	exportName: Type.Optional(Type.String({ description: "Export name for trace-export." })),
	packageName: Type.Optional(Type.String({ description: "Package name for trace-dependency." })),
	line: Type.Optional(Type.Number({ description: "Line number for trace-clone." })),

	// Duplication / health / audit
	top: Type.Optional(Type.Number({ description: "Limit top findings where supported." })),
	groupBy: Type.Optional(GroupBy),
	minTokens: Type.Optional(Type.Number({ description: "Duplication min token threshold." })),
	minLines: Type.Optional(Type.Number({ description: "Duplication min line threshold." })),
	threshold: Type.Optional(Type.Number({ description: "Duplication or audit threshold where supported." })),
	minOccurrences: Type.Optional(Type.Number({ description: "Minimum duplicate occurrences before reporting." })),
	skipLocal: Type.Optional(Type.Boolean({ description: "Dupes: skip local clones within the same file." })),
	crossLanguage: Type.Optional(Type.Boolean({ description: "Dupes: enable cross-language clone detection." })),
	ignoreImports: Type.Optional(Type.Boolean({ description: "Dupes: ignore import declarations." })),
	fileScores: Type.Optional(Type.Boolean({ description: "Health: include file maintainability scores." })),
	hotspots: Type.Optional(Type.Boolean({ description: "Health: include churn-backed hotspots." })),
	targets: Type.Optional(Type.Boolean({ description: "Health: include ranked refactoring targets." })),
	score: Type.Optional(Type.Boolean({ description: "Health: compute project health score/grade." })),
	trend: Type.Optional(Type.Boolean({ description: "Health: compare against the latest saved snapshot." })),
	coverage: Type.Optional(Type.String({ description: "Istanbul coverage-final.json or V8/Istanbul runtime coverage input, depending on command." })),
	coverageRoot: Type.Optional(Type.String({ description: "Absolute source root prefix to strip from coverage paths." })),
	runtimeCoverage: Type.Optional(Type.String({ description: "Health/audit runtime coverage input: V8 dir, V8 JSON, or Istanbul JSON." })),
	maxCrap: Type.Optional(Type.Number({ description: "Maximum CRAP score threshold where supported." })),
	diffFile: Type.Optional(Type.String({ description: "Audit diff file path for line-scoped review/runtime verdicts." })),

	// Audit/fix/list/explain
	gate: Type.Optional(AuditGate),
	explain: Type.Optional(Type.Boolean({ description: "Audit: include _meta explanations in JSON output." })),
	issueType: Type.Optional(Type.String({ description: "Issue type/rule id for fallow explain." })),
	entryPoints: Type.Optional(Type.Boolean({ description: "project-info: include entry points." })),
	files: Type.Optional(Type.Boolean({ description: "project-info: include discovered files." })),
	plugins: Type.Optional(Type.Boolean({ description: "project-info: include active framework plugins." })),
	boundaries: Type.Optional(Type.Boolean({ description: "project-info: include architecture boundary zones/rules." })),
	noCreateConfig: Type.Optional(Type.Boolean({ description: "fix: do not create .fallowrc.json for add-to-config actions." })),

	extraArgs: Type.Optional(Type.Array(Type.String(), {
		description: "Advanced escape hatch for modeled CLI flags not exposed above. Do not include --format/-f; JSON output is required.",
	})),
});

export type FallowRunParams = Static<typeof fallowRunParams>;
