export function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}
