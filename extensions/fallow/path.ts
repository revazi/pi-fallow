export function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function isPositionalCliArg(args: string[], index: number, positionalFlags: readonly string[]): boolean {
	if (index === 0) return true;
	if (isCliFlag(args[index])) return false;
	return !isValueTakingCliFlag(args[index - 1]!, positionalFlags);
}

function isCliFlag(arg: string | undefined): boolean {
	return arg?.startsWith("-") ?? false;
}

function isValueTakingCliFlag(arg: string, positionalFlags: readonly string[]): boolean {
	return isCliFlag(arg) && !arg.includes("=") && !positionalFlags.includes(arg);
}
