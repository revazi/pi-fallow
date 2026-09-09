import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ReadinessReport, RuntimeSidecarBinding } from "./readiness-report";
import { inspectRuntimeReadiness } from "./runtime-readiness";

export interface CoverageArtifactPreview {
	input: string;
	path: string;
	kind: "file" | "directory";
	projectRoot: string;
	fingerprint: string;
}
export interface RuntimeCoverageRunRequest {
	artifact: CoverageArtifactPreview;
	sidecar: RuntimeSidecarBinding;
	commandArgs: string[];
}
export interface RuntimeCoverageFormState {
	input: string;
	feedback: string;
	preview?: CoverageArtifactPreview;
	sidecar?: RuntimeSidecarBinding;
}

/** Metadata inspection of the explicitly selected path only: no capture, content crawl, or writes. */
export async function inspectCoverageArtifact(root: string, input: string): Promise<CoverageArtifactPreview> {
	const local = localArtifactPath(input);
	const projectRoot = await realpath(root);
	const path = await realpath(resolve(projectRoot, local));
	localArtifactPath(path); // A symlink must not resolve to an unsupported path either.
	await access(path, constants.R_OK);
	const info = await stat(path, { bigint: true });
	const kind = artifactKind(info);
	const fingerprint = createHash("sha256").update(JSON.stringify([
		projectRoot, path, kind, info.dev.toString(), info.ino.toString(), info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString(),
	])).digest("hex");
	return { input, path, kind, projectRoot, fingerprint };
}

function localArtifactPath(input: string): string {
	if (!input.trim()) throw new Error("Enter a local V8/Istanbul file or directory; there is no default artifact.");
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(input)) throw new Error("Artifact paths must not contain control characters.");
	return checkedLocalPath(input.trim());
}

function checkedLocalPath(path: string): string {
	const windowsDrive = process.platform === "win32" && /^[a-z]:[\\/]/iu.test(path);
	const scheme = /^[a-z][a-z0-9+.-]*:/iu.test(path) && !windowsDrive;
	if ([scheme, /^(?:\\\\|\/\/)/u.test(path), path.length > 4096].some(Boolean)) throw new Error("Use a local filesystem path, not a URL, UNC/cloud source, or oversized path.");
	return expandHome(path);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function artifactKind(info: { isFile(): boolean; isDirectory(): boolean }): "file" | "directory" {
	if (info.isFile()) return "file";
	if (info.isDirectory()) return "directory";
	throw new Error("Select a regular coverage file or directory, not a device, socket, or pipe.");
}

export function readyRuntimeBinding(report: ReadinessReport | undefined): RuntimeSidecarBinding | undefined {
	if (report?.phase !== "ready") return undefined;
	return report.runtime ? { ...report.runtime } : undefined;
}

export function buildRuntimeCoverageRequest(artifact: CoverageArtifactPreview, sidecar: RuntimeSidecarBinding): RuntimeCoverageRunRequest {
	return {
		artifact: { ...artifact }, sidecar: { ...sidecar },
		commandArgs: ["coverage", "analyze", "--root", artifact.projectRoot, "--no-cache", "--runtime-coverage", artifact.path],
	};
}

/** Invoked in the form AND again by the command executor; a restored/cached preview is never authority to run. */
export async function revalidateRuntimeCoverageRequest(
	request: RuntimeCoverageRunRequest, signal: AbortSignal,
	inspectReadiness = (root: string, signal: AbortSignal) => inspectRuntimeReadiness(root, signal, {
		// The child is pinned to the previewed binary, not a newly discovered PATH installation.
		environment: { FALLOW_COV_BIN: request.sidecar.binaryPath, PATH: "" },
	}),
): Promise<void> {
	signal.throwIfAborted();
	await requireSameArtifact(request.artifact);
	const current = readyRuntimeBinding(await inspectReadiness(request.artifact.projectRoot, signal));
	requireSameSidecar(request.sidecar, current);
	await requireSameArtifact(request.artifact); // Also catch drift while sidecar verification was in flight.
	signal.throwIfAborted();
}

async function requireSameArtifact(previous: CoverageArtifactPreview): Promise<void> {
	const current = await inspectCoverageArtifact(previous.projectRoot, previous.input);
	if (current.fingerprint !== previous.fingerprint) throw new Error("Artifact path, identity, type, or metadata changed. Press v for a new preview before Run.");
}

function requireSameSidecar(previous: RuntimeSidecarBinding, current: RuntimeSidecarBinding | undefined): void {
	if (!current) throw new Error("Runtime Coverage readiness is no longer verified. Refresh readiness and preview again.");
	if (current.binaryPath !== previous.binaryPath || current.fingerprint !== previous.fingerprint) throw new Error("The signed sidecar changed after preview. Refresh readiness and preview again.");
}

export function localCoverageEnvironment(binaryPath: string): NodeJS.ProcessEnv {
	return {
		FALLOW_COV_BIN: binaryPath, FALLOW_COV_BINARY_PATH: undefined,
		FALLOW_RUNTIME_COVERAGE_SOURCE: undefined, FALLOW_API_KEY: undefined, FALLOW_API_URL: undefined,
		FALLOW_REPO: undefined, FALLOW_CA_BUNDLE: undefined,
	};
}
