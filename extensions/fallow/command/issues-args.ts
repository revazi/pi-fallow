type IssueFlagTarget = "both" | "combined" | "security";

interface IssueFlagSpec {
	target: IssueFlagTarget;
	takesValue?: true;
}

interface ParsedIssueFlag {
	spec: IssueFlagSpec;
	tokens: string[];
	nextIndex: number;
}

export interface FallowProjectIssueArgs {
	combined: string[];
	security: string[];
}

const PROJECT_ISSUE_FLAGS = new Map<string, IssueFlagSpec>([
	["--config", { target: "both", takesValue: true }],
	["-c", { target: "both", takesValue: true }],
	["--workspace", { target: "both", takesValue: true }],
	["-w", { target: "both", takesValue: true }],
	["--changed-since", { target: "both", takesValue: true }],
	["--base", { target: "both", takesValue: true }],
	["--changed-workspaces", { target: "both", takesValue: true }],
	["--no-cache", { target: "both" }],
	["--threads", { target: "both", takesValue: true }],
	["--production", { target: "both" }],
	["--no-production", { target: "both" }],
	["--max-file-size", { target: "both", takesValue: true }],
	["--runtime-coverage", { target: "both", takesValue: true }],
	["--min-invocations-hot", { target: "both", takesValue: true }],
	["--score", { target: "combined" }],
	["--type-aware", { target: "combined" }],
	["--no-type-aware", { target: "combined" }],
	["--type-aware-project", { target: "combined", takesValue: true }],
	["--type-aware-require", { target: "combined", takesValue: true }],
	["--surface", { target: "security" }],
]);

export function partitionFallowProjectIssueArgs(args: string[]): FallowProjectIssueArgs {
	const partitioned: FallowProjectIssueArgs = { combined: [], security: [] };
	let index = 0;
	while (index < args.length) {
		const parsed = parseIssueFlag(args, index);
		appendPartitionedTokens(partitioned, parsed.spec.target, parsed.tokens);
		index = parsed.nextIndex;
	}
	return partitioned;
}

function parseIssueFlag(args: string[], index: number): ParsedIssueFlag {
	const token = args[index]!;
	const { name, inlineValue } = splitFlagToken(token);
	const spec = PROJECT_ISSUE_FLAGS.get(name);
	if (!spec) throw new Error(`issues does not support ${token}. Run an explicit /fallow subcommand for command-specific options.`);
	const valueTokens = readFlagValueTokens(args, index, name, token, inlineValue, spec);
	return { spec, tokens: [token, ...valueTokens], nextIndex: index + valueTokens.length + 1 };
}

function readFlagValueTokens(
	args: string[],
	index: number,
	name: string,
	token: string,
	inlineValue: string | undefined,
	spec: IssueFlagSpec,
): string[] {
	if (!spec.takesValue || inlineValue !== undefined) return [];
	return [requiredFlagValue(args[index + 1], name, token)];
}

function requiredFlagValue(value: string | undefined, name: string, token: string): string {
	if (value === undefined || value.startsWith("-")) throw new Error(`${name || token} requires a value.`);
	return value;
}

function splitFlagToken(token: string): { name: string; inlineValue?: string } {
	if (!token.startsWith("-")) return { name: token };
	const equalsIndex = token.indexOf("=");
	if (equalsIndex < 0) return { name: token };
	return { name: token.slice(0, equalsIndex), inlineValue: token.slice(equalsIndex + 1) };
}

function appendPartitionedTokens(output: FallowProjectIssueArgs, target: IssueFlagTarget, tokens: string[]): void {
	if (target !== "security") output.combined.push(...tokens);
	if (target !== "combined") output.security.push(...tokens);
}
