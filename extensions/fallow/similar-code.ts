import { stripAtPrefix } from "./path";

const MUTATING_SUBCOMMANDS = new Set(["setup", "cache"]);
const PATH_VALUE_FLAGS = new Set([
	"--root", "-r", "--config", "-c", "--diff-file", "--file", "--output-file", "-o", "--candidates", "--verdicts",
]);
const OPTION_VALUE_FLAGS = new Set([
	...PATH_VALUE_FLAGS,
	"--format", "-f", "--threads", "--changed-since", "--workspace", "-w", "--changed-workspaces", "--max-file-size",
	"--threshold", "--min-lines", "--top",
]);

export const SIMILAR_CODE_DEFAULT_TIMEOUT_SECS = 15 * 60;

export function prepareSimilarCodeArgs(args: string[]): string[] {
	assertReadOnlySimilarCodeArgs(args);
	return normalizeSimilarCodePaths(args);
}

function assertReadOnlySimilarCodeArgs(args: string[]): void {
	const subcommand = findSimilarCodeSubcommand(args);
	if (!subcommand || !MUTATING_SUBCOMMANDS.has(subcommand)) return;
	if (subcommand === "setup") {
		throw new Error(
			"Pi Fallow never downloads the similar-code model. Review `/fallow similar-code status`, then run `fallow similar-code setup --local` directly if you choose to install it.",
		);
	}
	throw new Error("Pi Fallow does not expose similar-code cache mutation; run the Fallow CLI directly after reviewing the cache command.");
}

function findSimilarCodeSubcommand(args: string[]): string | undefined {
	return scanSimilarCodeSubcommand(args, 0);
}

function scanSimilarCodeSubcommand(args: string[], index: number): string | undefined {
	if (index >= args.length) return undefined;
	const arg = args[index]!;
	if (arg === "--") return args[index + 1];
	if (!arg.startsWith("-")) return arg;
	return scanSimilarCodeSubcommand(args, index + similarCodeOptionWidth(arg));
}

function similarCodeOptionWidth(arg: string): number {
	if (arg.includes("=")) return 1;
	return OPTION_VALUE_FLAGS.has(arg) ? 2 : 1;
}

function normalizeSimilarCodePaths(args: string[]): string[] {
	return args.map((arg, index) => {
		if (index > 0 && PATH_VALUE_FLAGS.has(args[index - 1]!)) return stripAtPrefix(arg);
		return normalizeInlinePath(arg);
	});
}

function normalizeInlinePath(arg: string): string {
	for (const flag of PATH_VALUE_FLAGS) {
		const prefix = `${flag}=@`;
		if (arg.startsWith(prefix)) return `${flag}=${stripAtPrefix(arg.slice(flag.length + 1))}`;
	}
	return arg;
}

export function isSimilarCodeCommand(args: readonly string[]): boolean {
	return args[0] === "similar-code";
}

export function isMissingSimilarCodeModelMessage(message: unknown): boolean {
	return typeof message === "string" && /local model is not installed/i.test(message);
}
