type Notify = (message: string, level: "info" | "warning") => void;

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
	const command = normalized[0] ?? "";
	const translator = traceCommandMap[command];
	return translator ? translator(normalized) : normalized;
}

const traceCommandMap: Record<string, (args: string[]) => string[]> = {
	"trace-file": (args) => {
		if (!args[1]) throw new Error("trace-file requires file.");
		return ["dead-code", "--trace-file", ...args.slice(1)];
	},
	"trace-export": (args) => {
		if (!args[1] || !args[2]) throw new Error("trace-export requires file and exportName.");
		return ["dead-code", "--trace", `${args[1]}:${args[2]}`, ...args.slice(3)];
	},
	"trace-dependency": (args) => {
		if (!args[1]) throw new Error("trace-dependency requires packageName.");
		return ["dead-code", "--trace-dependency", ...args.slice(1)];
	},
	"trace-clone": (args) => parseTraceCloneArgs(args),
};

function parseTraceCloneArgs(args: string[]): string[] {
	const { fileOrPath, line } = getTraceCloneInput(args);
	if (line) return buildTraceCloneFromLine(fileOrPath, line, args);
	const parsed = parseTraceCloneFromPath(fileOrPath);
	return buildTraceCloneFromParsed(parsed, args);
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

function buildTraceCloneFromLine(fileOrPath: string, line: string, args: string[]): string[] {
	if (!/^\d+$/.test(line)) throw new Error("trace-clone requires file and numeric line.");
	return ["dupes", "--trace", `${fileOrPath}:${line}`, ...args.slice(3)];
}

function buildTraceCloneFromParsed(match: RegExpMatchArray, args: string[]): string[] {
	return ["dupes", "--trace", `${match[1]}:${match[2]}`, ...args.slice(2)];
}
