import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { FALLOW_COV_VERSION, inspectRuntimeCoverageCapability } from "./optional-analysis";
import { readinessNext, type ReadinessReport } from "./readiness-report";

// Fallow v3.22.0 crates/cli/src/health/coverage.rs BINARY_SIGNING_VERIFY_KEY.
// Binary-signing key, NOT the license key. Readiness never executes sidecar candidates.
const SIGNING_KEY = createPublicKey({
	key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from([
		19, 101, 100, 202, 175, 194, 21, 42, 215, 158, 125, 99, 218, 176, 85, 44,
		62, 175, 122, 137, 33, 144, 210, 11, 56, 216, 191, 101, 249, 27, 112, 27,
	])]),
	format: "der", type: "spki",
});
const BINARY = process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov";
interface Candidate { path: string; source: string }
interface InspectionOptions {
	environment?: NodeJS.ProcessEnv;
	home?: string;
	inspectManaged?: typeof inspectRuntimeCoverageCapability;
	verifyBinary?: typeof verifySignedBinary;
}

export async function inspectRuntimeReadiness(cwd: string, signal: AbortSignal, {
	environment = process.env, home = homedir(), inspectManaged = inspectRuntimeCoverageCapability,
	verifyBinary = verifySignedBinary,
}: InspectionOptions = {}): Promise<ReadinessReport> {
	const candidate = await discoverSidecar(resolve(cwd), environment, home, signal) ?? await managedCandidate(inspectManaged);
	if (!("path" in candidate)) return candidate;
	return inspectCandidate(candidate, signal, verifyBinary);
}

async function managedCandidate(inspectManaged: typeof inspectRuntimeCoverageCapability): Promise<Candidate | ReadinessReport> {
	const managed = await inspectManaged();
	if (managed.binaryPath) return { path: managed.binaryPath, source: "Pi managed cache" };
	return {
		phase: managed.phase, summary: managed.problem ?? "No supported sidecar installation found.",
		details: [`Managed location: ${managed.destination}`, `Certified version: ${FALLOW_COV_VERSION}`],
		next: readinessNext(managed.phase),
	};
}

async function inspectCandidate(candidate: Candidate, signal: AbortSignal, verifyBinary: typeof verifySignedBinary): Promise<ReadinessReport> {
	const details = [`Resolution: ${candidate.source}`, `Location: ${candidate.path}`, `Certified version: ${FALLOW_COV_VERSION}`];
	signal.throwIfAborted();
	try {
		await verifyBinary(candidate.path);
	} catch (error) {
		return { phase: "corrupt", summary: `Corrupt/unverified: ${error instanceof Error ? error.message : String(error)}`, details, next: readinessNext("corrupt") };
	}
	signal.throwIfAborted();
	// The certified sidecar speaks a stdin protocol and has no --version command.
	// Inspect adjacent package metadata instead; never invoke it or fabricate a version for a standalone binary.
	const version = await packageVersion(candidate.path);
	if (!version) return {
		phase: "corrupt", summary: "Signature verified, but standalone binary version is unverified (no recognized adjacent package metadata).",
		details: [...details, "Integrity: valid Ed25519 signature; package version unknown."],
		next: "Point FALLOW_COV_BIN at the signed binary inside an existing certified platform package, then refresh. No reinstall is required by this check.",
	};
	return versionReport(version, details);
}

function versionReport(version: string, details: string[]): ReadinessReport {
	const phase = version === FALLOW_COV_VERSION ? "ready" : "incompatible";
	return {
		phase, summary: phase === "ready" ? "Certified signed sidecar is installed. This does not certify a coverage artifact or license." : "Installed sidecar version differs from the certified version (or is unrecognized).",
		details: [...details, `Package-declared version: ${version}`, "Integrity: Ed25519 signature verified against Fallow 3.22.0's binary-signing key. Version comes from adjacent package metadata, not a sidecar handshake."],
		next: phase === "ready" ? "Readiness only; existing o Run currently uses the Pi-managed sidecar. External installation use in the inline run flow is follow-up work." : readinessNext(phase),
	};
}

async function packageVersion(binary: string): Promise<string | undefined> {
	const path = join(dirname(binary), "package.json");
	if (!await existingFile(path)) return undefined;
	await requireSizedFile(path, 1, 64 * 1024);
	const metadata = JSON.parse(await readFile(path, "utf8"));
	if (!platformPackageNames().includes(metadata.name)) return undefined;
	return typeof metadata.version === "string" ? metadata.version : undefined;
}

function platformPackageNames(): string[] {
	const prefix = `@fallow-cli/fallow-cov-${process.platform}-${process.arch}`;
	if (process.platform === "linux") return [`${prefix}-gnu`, `${prefix}-musl`];
	return [process.platform === "win32" ? `${prefix}-msvc` : prefix];
}

async function requireSizedFile(path: string, minimum: number, maximum: number): Promise<void> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Expected a regular file: ${path}`);
	if (info.size < minimum || info.size > maximum) throw new Error(`Expected file size ${minimum}–${maximum} bytes: ${path}`);
}

async function verifySignedBinary(path: string): Promise<void> {
	await requireSizedFile(path, 1, 64 * 1024 * 1024);
	await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
	await requireSizedFile(`${path}.sig`, 64, 64);
	const [binary, signature] = await Promise.all([readFile(path), readFile(`${path}.sig`)]);
	if (!verify(null, binary, SIGNING_KEY, signature)) throw new Error("Detached signature does not verify. This binary was not executed.");
}

/** Bounded supported lookup paths only; never scan arbitrary home/cache directories or invoke package managers. */
async function discoverSidecar(cwd: string, environment: NodeJS.ProcessEnv, home: string, signal: AbortSignal): Promise<Candidate | undefined> {
	const checks = [
		() => configuredCandidate(cwd, environment),
		() => firstCandidate(ancestors(cwd).map((root) => join(root, "node_modules")), projectPlatformBinary, "project platform package"),
		() => firstCandidate(ancestors(cwd).map((root) => join(root, "node_modules", ".bin")), firstBinary, "project node_modules/.bin"),
		() => firstCandidate([join(home, ".fallow", "bin")], firstBinary, "Fallow user installation"),
		() => firstCandidate((environment.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => resolve(cwd, entry)), firstBinary, "PATH"),
	];
	for (const check of checks) {
		signal.throwIfAborted();
		const candidate = await check();
		if (candidate) return candidate;
	}
	return undefined;
}

async function configuredCandidate(cwd: string, environment: NodeJS.ProcessEnv): Promise<Candidate | undefined> {
	for (const name of ["FALLOW_COV_BIN", "FALLOW_COV_BINARY_PATH"]) {
		const configured = environment[name]?.trim();
		if (configured) return { path: await installedBinary(await realpath(resolve(cwd, configured))), source: name };
	}
	return undefined;
}

async function firstCandidate(directories: string[], find: (directory: string) => Promise<string | undefined>, source: string): Promise<Candidate | undefined> {
	for (const directory of directories) {
		const path = await find(directory);
		if (path) return { path, source };
	}
	return undefined;
}

function ancestors(cwd: string): string[] {
	const roots = [cwd];
	while (dirname(cwd) !== cwd) { cwd = dirname(cwd); roots.push(cwd); }
	return roots;
}

async function directoryEntries(path: string): Promise<string[]> {
	try { return (await readdir(path)).sort(); }
	catch (error) {
		if (isMissingFile(error)) return [];
		throw error;
	}
}

async function existingFile(path: string): Promise<string | undefined> {
	try { return (await stat(path)).isFile() ? await realpath(path) : undefined; }
	catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function firstBinary(directory: string): Promise<string | undefined> {
	for (const name of process.platform === "win32" ? [BINARY, "fallow-cov", "fallow-cov.cmd"] : [BINARY]) {
		const path = await existingFile(join(directory, name));
		if (path) return installedBinary(path);
	}
	return undefined;
}

async function installedBinary(path: string): Promise<string> {
	return await wrapperPlatformBinary(path) ?? path;
}

async function wrapperPlatformBinary(path: string): Promise<string | undefined> {
	// Resolve known npm launcher layouts to the signed platform binary, never execute the launcher.
	if (path.endsWith(".cmd")) return scopedBinary(join(dirname(path), "node_modules", "@fallow-cli"));
	const wrapper = dirname(dirname(path));
	const isWrapper = [basename(dirname(path)) === "bin", basename(wrapper) === "fallow-cov", basename(dirname(wrapper)) === "@fallow-cli"].every(Boolean);
	return isWrapper ? scopedBinary(dirname(wrapper)) : undefined;
}

async function scopedBinary(scope: string): Promise<string | undefined> {
	for (const name of await directoryEntries(scope)) {
		if (!name.startsWith("fallow-cov-")) continue;
		const path = await existingFile(join(scope, name, BINARY));
		if (path) return path;
	}
	return undefined;
}

async function projectPlatformBinary(modules: string): Promise<string | undefined> {
	const direct = await scopedBinary(join(modules, "@fallow-cli"));
	if (direct) return direct;
	for (const store of [".bun", ".pnpm"]) {
		const path = await storeBinary(join(modules, store));
		if (path) return path;
	}
	return undefined;
}

async function storeBinary(store: string): Promise<string | undefined> {
	const candidates: string[] = [];
	for (const name of await directoryEntries(store)) {
		if (!name.startsWith("@fallow-cli+fallow-cov-")) continue;
		const path = await scopedBinary(join(store, name, "node_modules", "@fallow-cli"));
		if (path) candidates.push(path);
	}
	return unambiguousCandidate(candidates);
}

function unambiguousCandidate(candidates: string[]): string | undefined {
	if (candidates.length > 1) throw new Error("Multiple sidecar store versions found. Set FALLOW_COV_BIN to the intended signed binary, then refresh.");
	return candidates[0];
}
