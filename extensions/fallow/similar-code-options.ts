import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { boundedReadinessText } from "./readiness-report";

export interface SimilarCodeFormValues { scope: string; threshold: string; top: string }
export type SimilarCodeField = keyof SimilarCodeFormValues;
export interface SimilarCodeRunRequest { commandArgs: string[]; values: SimilarCodeFormValues }
export type SimilarCodeValidation =
	| { ok: true; request: SimilarCodeRunRequest }
	| { ok: false; errors: Partial<Record<SimilarCodeField, string>> };

export function emptySimilarCodeValues(): SimilarCodeFormValues {
	return { scope: "", threshold: "", top: "" };
}

/** Produces argv, never a shell command. Blank numeric fields deliberately omit overrides. */
export async function validateSimilarCodeOptions(root: string, values: SimilarCodeFormValues): Promise<SimilarCodeValidation> {
	const errors: Partial<Record<SimilarCodeField, string>> = {};
	const args = ["similar-code", "--root", resolve(root)];
	try { args.push(...await scopeArgs(root, values.scope.trim())); }
	catch (error) { errors.scope = boundedReadinessText(error instanceof Error ? error.message : String(error)); }
	addNumber(args, errors, "threshold", values.threshold.trim());
	addNumber(args, errors, "top", values.top.trim());
	if (Object.keys(errors).length) return { ok: false, errors };
	return { ok: true, request: { commandArgs: args, values: { ...values } } };
}

const NUMBERS = {
	threshold: { flag: "--threshold", minimum: 0, maximum: 1, syntax: /^(?:\d+(?:\.\d*)?|\.\d+)$/u, error: "Use a decimal number from 0 to 1, or leave blank for the Fallow default." },
	top: { flag: "--top", minimum: 1, maximum: 100_000, syntax: /^\d+$/u, error: "Use a decimal integer from 1 to 100000, or leave blank for the Fallow default." },
};

function addNumber(args: string[], errors: Partial<Record<SimilarCodeField, string>>, field: "threshold" | "top", value: string): void {
	if (!value) return;
	const option = NUMBERS[field];
	const number = Number(value);
	if (![option.syntax.test(value), Number.isFinite(number), number >= option.minimum, number <= option.maximum].every(Boolean)) {
		errors[field] = option.error;
		return;
	}
	args.push(option.flag, String(number));
}

function requireRelativeScope(scope: string): void {
	const invalid = [isAbsolute(scope), win32.isAbsolute(scope), /^[a-z][a-z0-9+.-]*:/iu.test(scope), scope.startsWith("-"), /[\u0000-\u001f\u007f-\u009f]/u.test(scope), scope.length > 4096].some(Boolean);
	if (invalid) throw new Error("Use a project-relative local file path (no URLs, absolute paths, or control characters).");
}

function requireWithin(root: string, target: string): string {
	const path = relative(root, target);
	if (!path) throw new Error("Leave scope blank for the whole project; otherwise select a file.");
	if ([path === "..", path.startsWith(`..${sep}`), isAbsolute(path)].some(Boolean)) throw new Error("Scope must stay inside the project, including through symlinks.");
	return path;
}

async function scopeArgs(root: string, scope: string): Promise<string[]> {
	if (!scope) return [];
	requireRelativeScope(scope);
	requireWithin(resolve(root), resolve(root, scope));
	const [project, file] = await Promise.all([realpath(root), realpath(resolve(root, scope))]);
	const path = requireWithin(project, file);
	if (!(await stat(file)).isFile()) throw new Error("Scope must be an existing project file, not a directory.");
	// A legal file named '-name.ts' must not become an option token after normalization.
	return ["--file", path.startsWith("-") ? `.${sep}${path}` : path];
}
