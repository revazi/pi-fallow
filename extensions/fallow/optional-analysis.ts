import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { asRecord } from "./data";

const SIMILAR_CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const SIMILAR_CODE_MODEL_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250";
const SIMILAR_CODE_LICENSE = "Apache-2.0";
const SIMILAR_CODE_DOWNLOAD_BYTES = 324_329_844;
const SIMILAR_CODE_PEAK_RAM_BYTES = 1_288_490_189;
const FALLOW_COV_PACKAGE = "@fallow-cli/fallow-cov";
export const FALLOW_COV_VERSION = "0.4.1";
const FALLOW_COV_LICENSE = "Proprietary (SEE LICENSE IN LICENSE)";
const FALLOW_COV_EXPECTED_INSTALLED_BYTES = 3_145_728;
const FALLOW_COV_REGISTRY_SOURCE = `https://registry.npmjs.org/${FALLOW_COV_PACKAGE}`;
const FALLOW_COV_DIST_INTEGRITY = "sha512-j6vKYolLyuOdgoONTFoFZ7RBp5vx/U8lHx9sa1oMZetdD7XAwo3nMd11gQHKuDs2JiBcDTra7YpqxhUyjmz4YA==";
const FALLOW_COV_PLATFORM_INTEGRITIES: Record<string, string> = {
	"fallow-cov-darwin-arm64": "sha512-pahht40+IUCi8GFaiY10yVGKy5iwsKg62FwM31G+6UvWAYnrtvh/RpqFBVS5QkvhxBfK0kRr3wugaEfFMBsgVQ==",
	"fallow-cov-darwin-x64": "sha512-hiX+xLSkxGI3UiB0MUleNAk8fHc8/iXaCLwJRRw3TMUlpdh/c/t4GFUUF9UIOcGq+lJtLScJHnfrhXL0u2BmqQ==",
	"fallow-cov-linux-arm64-gnu": "sha512-/NegKdrIOd1uc/f4i1jRFgYX7j9OZgKnN4M2numcM2ThoRPIomULb/ZYFJxhqheEj8mtJiq9LyVqpNmZM+XHpw==",
	"fallow-cov-linux-arm64-musl": "sha512-H1/fQ+tAaXSfCrnDFuGwmn6OYw0ZlQQVTwIPffBLTgZrud6uXkhKJKmZ68iodp6fG2AuEdRM4UJV+5/nkEb+ig==",
	"fallow-cov-linux-x64-gnu": "sha512-CBHoqxAjDxPm3G4JER4G6OQR6Zrg9RTdRqIHmd0+Pv34elib7htFSmB9P3HfcSr8TGVCa/fuKcdANIMamcNBcw==",
	"fallow-cov-linux-x64-musl": "sha512-/KR0kktHtf/ryO0bywaj1nzrj3XFLGP19aVG5iOiFYQJ1/a9ML5Tz+HFilSc0v6O+zSSvX7qaO98hOLjMHZOgQ==",
	"fallow-cov-win32-x64-msvc": "sha512-hs0z/jiXtrffOiwPz/Zk1XnAr52Wjybkywk8l5ZlmPuRV7Dz1sw97Y66aQ2AKODeTqLAwFPVrFnV+Qst1UdEBA==",
};

export type CapabilityPhase = "unknown" | "missing" | "ready" | "incompatible" | "corrupt" | "error";

export interface SimilarCodeCapability {
	phase: CapabilityPhase;
	modelReady: boolean;
	integrityVerified: boolean;
	modelId: string;
	modelRevision: string;
	license: string;
	downloadBytes: number;
	cacheDir: string;
	installedVersion?: string;
	protocolVersion?: number;
	problem?: string;
	fingerprint: string;
}

interface CoveragePlanDisclosure {
	commands: string[];
	filesToEdit: string[];
	omittedCommands: number;
	omittedFiles: number;
}

export interface RuntimeCoverageCapability {
	phase: CapabilityPhase;
	destination: string;
	packageName: string;
	certifiedVersion: string;
	installedVersion?: string;
	license: string;
	installedBytes?: number;
	binaryPath?: string;
	signaturePath?: string;
	packageMetadataVerified: boolean;
	signaturePresent: boolean;
	problem?: string;
	plan?: CoveragePlanDisclosure;
	planFingerprint?: string;
	fingerprint: string;
}

export interface OptionalAnalysisState {
	similarCode?: SimilarCodeCapability;
	runtimeCoverage?: RuntimeCoverageCapability;
	completeSetupOutputPath?: string;
	notice?: string;
}

export function createOptionalAnalysisState(): OptionalAnalysisState {
	return {};
}

export function parseSimilarCodeCapability(value: unknown): SimilarCodeCapability {
	const report = asRecord(value);
	if (!report || report.kind !== "similar-code-status") return similarCodeError("Fallow returned an incompatible Similar Code status report.");
	const modelId = boundedValue(stringOr(report.model_id, "unknown"), 200);
	const modelRevision = boundedValue(stringOr(report.model_revision, "unknown"), 200);
	const license = boundedValue(stringOr(report.license, "unknown"), 100);
	const downloadBytes = positiveNumberOr(report.download_bytes, SIMILAR_CODE_DOWNLOAD_BYTES);
	const cacheDir = boundedValue(stringOr(report.cache_dir, "unknown"), 1_000);
	const modelReady = report.model_ready === true;
	const integrityVerified = report.integrity_verified === true;
	const compatible = [
		modelId === SIMILAR_CODE_MODEL_ID,
		modelRevision === SIMILAR_CODE_MODEL_REVISION,
		license === SIMILAR_CODE_LICENSE,
	].every(Boolean);
	const phase = similarCodePhase(modelReady, integrityVerified, compatible);
	const capability = {
		phase,
		modelReady,
		integrityVerified,
		modelId,
		modelRevision,
		license,
		downloadBytes,
		cacheDir,
		installedVersion: boundedOptionalValue(string(report.companion_version ?? report.version), 100),
		protocolVersion: numeric(report.protocol_version),
		problem: similarCodeProblem(report, phase),
	};
	return { ...capability, fingerprint: fingerprint(capability) };
}

function similarCodePhase(modelReady: boolean, integrityVerified: boolean, compatible: boolean): CapabilityPhase {
	if (!compatible) return "incompatible";
	if (!modelReady) return "missing";
	return integrityVerified ? "ready" : "corrupt";
}

function similarCodeProblem(report: Record<string, any>, phase: CapabilityPhase): string | undefined {
	const reported = string(report.problem);
	if (reported) return boundedValue(reported, 1_000);
	if (phase === "incompatible") return "Pinned model metadata differs from Pi Fallow's certified model.";
	if (phase === "corrupt") return "The model is present but its integrity is not verified.";
	return undefined;
}

function similarCodeError(problem: string): SimilarCodeCapability {
	const capability = {
		phase: "error" as const,
		modelReady: false,
		integrityVerified: false,
		modelId: SIMILAR_CODE_MODEL_ID,
		modelRevision: SIMILAR_CODE_MODEL_REVISION,
		license: SIMILAR_CODE_LICENSE,
		downloadBytes: SIMILAR_CODE_DOWNLOAD_BYTES,
		cacheDir: "unknown",
		problem,
	};
	return { ...capability, fingerprint: fingerprint(capability) };
}

function runtimeCoverageDestination(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment.PI_FALLOW_TOOLS_DIR;
	if (configured) return resolve(configured, "fallow-cov", FALLOW_COV_VERSION);
	const base = environment.XDG_DATA_HOME || (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".local", "share"));
	return join(base, "pi-fallow", "tools", "fallow-cov", FALLOW_COV_VERSION);
}

export async function inspectRuntimeCoverageCapability(
	plan?: unknown,
	destination = runtimeCoverageDestination(),
): Promise<RuntimeCoverageCapability> {
	const normalizedPlan = asRecord(plan);
	const canonical = await canonicalDestination(destination);
	const base = runtimeCoverageBase(canonical, normalizedPlan);
	try {
		await access(canonical, constants.R_OK);
	} catch {
		return finalizeRuntimeCoverage({ ...base, phase: "missing", problem: "The certified sidecar is not installed in Pi Fallow's managed cache." });
	}
	try {
		return await inspectInstalledRuntimeCoverage(base);
	} catch (error) {
		return finalizeRuntimeCoverage({ ...base, phase: "corrupt", problem: errorMessage(error) });
	}
}

export async function canonicalDestination(path: string): Promise<string> {
	const destination = resolve(path);
	try {
		return await realpath(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const root = parse(destination).root;
		if (destination === root) return destination;
		return join(await canonicalDestination(dirname(destination)), basename(destination));
	}
}

function runtimeCoverageBase(destination: string, plan: Record<string, any> | undefined): Omit<RuntimeCoverageCapability, "phase" | "fingerprint"> {
	return {
		destination,
		packageName: FALLOW_COV_PACKAGE,
		certifiedVersion: FALLOW_COV_VERSION,
		license: FALLOW_COV_LICENSE,
		packageMetadataVerified: false,
		signaturePresent: false,
		...(plan ? { plan: summarizeCoveragePlan(plan), planFingerprint: coveragePlanFingerprint(plan) } : {}),
	};
}

async function inspectInstalledRuntimeCoverage(
	base: Omit<RuntimeCoverageCapability, "phase" | "fingerprint">,
): Promise<Omit<RuntimeCoverageCapability, "fingerprint">> {
	const scope = join(base.destination, "node_modules", "@fallow-cli");
	const wrapper = await readPackage(join(scope, "fallow-cov", "package.json"));
	const installedVersion = string(wrapper.version);
	if (isIncompatibleWrapper(wrapper.name, installedVersion)) {
		return { ...base, phase: "incompatible", installedVersion, problem: "Installed sidecar package/version differs from the certified package." };
	}
	const platformPackage = await findPlatformPackage(scope);
	await verifyPackageIntegrity(base.destination, platformPackage);
	await verifyPlatformPackage(scope, platformPackage);
	const binaryPath = join(scope, platformPackage, coverageBinaryName());
	const signaturePath = `${binaryPath}.sig`;
	await Promise.all([requireFile(binaryPath), requireFile(signaturePath)]);
	return {
		...base,
		phase: "ready",
		installedVersion,
		license: installedCoverageLicense(wrapper.license),
		installedBytes: await directorySize(base.destination),
		binaryPath,
		signaturePath,
		packageMetadataVerified: true,
		signaturePresent: true,
	};
}

function isIncompatibleWrapper(name: unknown, version: string | undefined): boolean {
	return [name !== FALLOW_COV_PACKAGE, version !== FALLOW_COV_VERSION].some(Boolean);
}

function installedCoverageLicense(value: unknown): string {
	const license = string(value);
	if (license === "SEE LICENSE IN LICENSE") return FALLOW_COV_LICENSE;
	return stringOr(license, "unknown");
}

async function verifyPackageIntegrity(destination: string, platformPackage: string): Promise<void> {
	const lock = await readPackage(join(destination, "node_modules", ".package-lock.json"));
	const packages = Object.entries(asRecord(lock.packages) ?? {});
	if (lockIntegrity(packages, "fallow-cov") !== FALLOW_COV_DIST_INTEGRITY) throw new Error("The managed npm lock does not match the certified wrapper integrity.");
	if (lockIntegrity(packages, platformPackage) !== FALLOW_COV_PLATFORM_INTEGRITIES[platformPackage]) throw new Error("The managed npm lock does not match the certified platform integrity.");
}

function lockIntegrity(entries: Array<[string, unknown]>, packageName: string): unknown {
	const suffix = `node_modules/@fallow-cli/${packageName}`;
	const entry = entries.find(([path]) => path.replaceAll("\\", "/").endsWith(suffix));
	return asRecord(entry?.[1])?.integrity;
}

async function findPlatformPackage(scope: string): Promise<string> {
	const entries = await readdir(scope, { withFileTypes: true });
	const packages = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("fallow-cov-")).map((entry) => entry.name);
	if (packages.length !== 1) throw new Error(`Expected one signed platform package, found ${packages.length}.`);
	return packages[0]!;
}

async function verifyPlatformPackage(scope: string, platformPackage: string): Promise<void> {
	if (!isCurrentPlatformPackage(platformPackage)) throw new Error(`The installed sidecar package ${platformPackage} does not match ${process.platform}-${process.arch}.`);
	const platform = await readPackage(join(scope, platformPackage, "package.json"));
	if ([platform.name !== `@fallow-cli/${platformPackage}`, platform.version !== FALLOW_COV_VERSION].some(Boolean)) throw new Error("The platform sidecar metadata does not match the certified package.");
}

function coverageBinaryName(): string {
	return process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov";
}

function isCurrentPlatformPackage(packageName: string): boolean {
	if (process.platform === "darwin") return packageName === `fallow-cov-darwin-${process.arch}`;
	if (process.platform === "win32") return packageName === `fallow-cov-win32-${process.arch}-msvc`;
	if (process.platform === "linux") return [`fallow-cov-linux-${process.arch}-gnu`, `fallow-cov-linux-${process.arch}-musl`].includes(packageName);
	return false;
}

async function readPackage(path: string): Promise<Record<string, any>> {
	const value = JSON.parse(await readFile(path, "utf8"));
	const record = asRecord(value);
	if (!record) throw new Error(`Invalid package metadata at ${path}.`);
	return record;
}

async function requireFile(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Expected a regular file at ${path}.`);
}

async function directorySize(path: string): Promise<number> {
	const entries = await readdir(path, { withFileTypes: true });
	const sizes = await Promise.all(entries.map(async (entry) => {
		const child = join(path, entry.name);
		return entry.isDirectory() ? directorySize(child) : (await stat(child)).size;
	}));
	return sizes.reduce((total, size) => total + size, 0);
}

function finalizeRuntimeCoverage(
	capability: Omit<RuntimeCoverageCapability, "fingerprint">,
): RuntimeCoverageCapability {
	return { ...capability, fingerprint: fingerprint(capability) };
}

export function parseCoverageSetupPlan(value: unknown): Record<string, any> {
	const plan = asRecord(value);
	if (!plan || plan.kind !== "coverage-setup" || String(plan.schema_version) !== "1") {
		throw new Error("Fallow returned an incompatible runtime coverage setup plan.");
	}
	return plan;
}

function coveragePlanFingerprint(plan: Record<string, any>): string {
	const stable = { ...plan };
	delete stable._meta;
	return fingerprint(stable);
}

export function similarCodeSetupPreview(status: SimilarCodeCapability): string {
	return [
		`Source: Hugging Face model ${display(status.modelId)}`,
		`Pinned revision: ${display(status.modelRevision)}`,
		`License: ${display(status.license)}`,
		`Download: ${formatBytes(status.downloadBytes)}; peak RAM: approximately ${formatBytes(SIMILAR_CODE_PEAK_RAM_BYTES)}`,
		`Destination: ${display(status.cacheDir)}`,
		"Command: fallow similar-code setup --local --yes --format json --quiet",
		"Side effects: downloads and verifies the pinned model in the user-local Fallow cache, and saves complete setup output under the OS temporary directory. No project manifest or lockfile is changed.",
	].join("\n");
}

export function runtimeCoverageSetupPreview(status: RuntimeCoverageCapability): string {
	const plan = status.plan ?? { commands: [], filesToEdit: [], omittedCommands: 0, omittedFiles: 0 };
	return [
		`Source: npm package ${FALLOW_COV_PACKAGE}@${FALLOW_COV_VERSION} (${FALLOW_COV_REGISTRY_SOURCE})`,
		`Registry integrity (wrapper; the selected platform package is also pinned): ${FALLOW_COV_DIST_INTEGRITY}`,
		`License: ${FALLOW_COV_LICENSE}`,
		`Expected installed size: approximately ${formatBytes(FALLOW_COV_EXPECTED_INSTALLED_BYTES)}`,
		`Destination: ${display(status.destination)}`,
		`Command: npm install --prefix ${JSON.stringify(status.destination)} --registry https://registry.npmjs.org --ignore-scripts --no-save --package-lock=false --audit=false --fund=false ${FALLOW_COV_PACKAGE}@${FALLOW_COV_VERSION}`,
		"Side effects: network download plus files in the displayed Pi Fallow managed cache; npm may create node_modules/.package-lock.json there and update its normal user cache/logs. Pi Fallow saves complete setup output under the OS temporary directory. No project manifest or lockfile is changed.",
		"Scope: single local V8/Istanbul captures only. Continuous/cloud mode, credentials, telemetry opt-in, and beacon setup are excluded.",
		coveragePlanDisclosure(plan),
	].join("\n");
}

function summarizeCoveragePlan(plan: Record<string, any>): CoveragePlanDisclosure {
	const commands = stringArray(plan.commands);
	const files = recordArray(plan.files_to_edit).map((entry) => string(entry.path)).filter((path): path is string => Boolean(path));
	return {
		commands: commands.slice(0, 10).map(boundedPlanValue),
		filesToEdit: files.slice(0, 20).map(boundedPlanValue),
		omittedCommands: Math.max(0, commands.length - 10),
		omittedFiles: Math.max(0, files.length - 20),
	};
}

function boundedPlanValue(value: string): string {
	const sanitized = display(value);
	return sanitized.length > 300 ? `${sanitized.slice(0, 299)}…` : sanitized;
}

function coveragePlanDisclosure(plan: CoveragePlanDisclosure): string {
	const commandText = listDisclosure(plan.commands, plan.omittedCommands, "; ");
	const fileText = listDisclosure(plan.filesToEdit, plan.omittedFiles, ", ");
	return `Fallow's read-only setup plan proposed project/cloud work that this local-only action will NOT perform — commands: ${commandText}; files: ${fileText}.`;
}

function listDisclosure(values: string[], omitted: number, separator: string): string {
	const shown = values.length ? values.join(separator) : "none";
	return omitted ? `${shown} (+${omitted} more not shown)` : shown;
}

export function similarCodeStatusLines(status: SimilarCodeCapability | undefined): string[] {
	if (!status) return ["Similar Code: status not checked."];
	return withProblem([
		`Similar Code: ${status.phase}; model ${display(status.modelId)}@${display(shortRevision(status.modelRevision))}; integrity ${verificationLabel(status.integrityVerified)}.`,
		`  Source: Hugging Face; Fallow companion ${display(stringOr(status.installedVersion, "unknown"))}; protocol ${valueOr(status.protocolVersion, "unknown")}; ${display(status.license)}; ${formatBytes(status.downloadBytes)}; ${display(status.cacheDir)}`,
	], status.problem);
}

export function runtimeCoverageInstallArgs(destination: string): string[] {
	return [
		"install", "--prefix", destination, "--registry", "https://registry.npmjs.org", "--ignore-scripts", "--no-save",
		"--package-lock=false", "--audit=false", "--fund=false", `${FALLOW_COV_PACKAGE}@${FALLOW_COV_VERSION}`,
	];
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
	return `${Math.round(bytes / 1024)} KiB`;
}

function withProblem(lines: string[], problem: string | undefined): string[] {
	if (problem) lines.push(`  ${display(problem)}`);
	return lines;
}

function verificationLabel(verified: boolean): string {
	return verified ? "verified" : "not verified";
}

function valueOr(value: string | number | undefined, fallback: string): string | number {
	return value === undefined ? fallback : value;
}

function stringOr(value: unknown, fallback: string): string {
	return string(value) ?? fallback;
}

function positiveNumberOr(value: unknown, fallback: number): number {
	const parsed = numeric(value);
	return parsed === undefined || parsed < 0 ? fallback : parsed;
}

function boundedOptionalValue(value: string | undefined, maxLength: number): string | undefined {
	return value === undefined ? undefined : boundedValue(value, maxLength);
}

function boundedValue(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function display(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function shortRevision(value: string): string {
	return value === "unknown" ? value : value.slice(0, 12);
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, any>> {
	return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is Record<string, any> => Boolean(entry)) : [];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function saveOptionalSetupOutput(stdout: string, stderr: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-fallow-optional-"));
	const path = join(directory, "setup-output.txt");
	await writeFile(path, [`stdout:\n${stdout}`, `stderr:\n${stderr}`].join("\n\n"), "utf8");
	return path;
}
