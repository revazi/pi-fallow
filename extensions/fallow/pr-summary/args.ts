export function flagValue(args: string[], flag: string): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === flag) return args[index + 1];
		if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
}

export function normalizeArgs(args: string[]): string[] {
	const fallowIndex = args.indexOf("fallow");
	return fallowIndex >= 0 ? args.slice(fallowIndex + 1) : args;
}

export function isPrAuditCommand(args: string[]): boolean {
	return args.includes("audit");
}
