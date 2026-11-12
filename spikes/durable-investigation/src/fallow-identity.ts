// Installed executable admission for the isolated Durable experiment.
// The host must explicitly trust the executable; hashing is not sandboxing.
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ContractError } from "./contracts.ts";
import { FALLOW_ADAPTER_POLICY, FALLOW_OUTPUT_SCHEMA } from "./fallow-policy.ts";
import { FALLOW_VERSION } from "./fallow-schema.ts";
import { execArgv, sha256File } from "./util.ts";

export interface FallowExecutableIdentity {
	requestedPath: string;
	executablePath: string;
	sha256: string;
	version: string;
	adapterPolicy: string;
	outputSchema: string;
}

async function resolveExecutable(requestedPath: string): Promise<string> {
	if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) throw new ContractError("fallow-executable", "an explicit absolute executable path is required");
	try {
		const executablePath = await realpath(requestedPath);
		if (!(await stat(executablePath)).isFile()) throw new Error("not a file");
		await access(executablePath, constants.X_OK);
		return executablePath;
	} catch {
		throw new ContractError("fallow-executable", "the admitted executable is unavailable or not executable");
	}
}

/** Admit only a host-supplied, already-present executable with the pinned version. */
export async function inspectFallowExecutable(requestedPath: string): Promise<FallowExecutableIdentity> {
	const executablePath = await resolveExecutable(requestedPath);
	const before = await sha256File(executablePath);
	let result;
	try {
		result = await execArgv([executablePath, "--version"], { env: {}, maxBytes: 4096, signal: AbortSignal.timeout(5000) });
	} catch {
		throw new ContractError("fallow-version", "executable version check failed");
	}
	if (result.code !== 0 || result.stdout.trim() !== `fallow ${FALLOW_VERSION}`) throw new ContractError("fallow-version", "executable version is incompatible");
	if (await resolveExecutable(requestedPath) !== executablePath || await sha256File(executablePath) !== before) throw new ContractError("fallow-executable-drift", "executable changed during admission");
	return { requestedPath, executablePath, sha256: before, version: FALLOW_VERSION, adapterPolicy: FALLOW_ADAPTER_POLICY, outputSchema: FALLOW_OUTPUT_SCHEMA };
}

/** Revalidate both the admitted path binding and all pinned identities. */
export async function verifyFallowExecutable(identity: FallowExecutableIdentity): Promise<void> {
	if (!identity || identity.adapterPolicy !== FALLOW_ADAPTER_POLICY || identity.outputSchema !== FALLOW_OUTPUT_SCHEMA || identity.version !== FALLOW_VERSION || !/^[a-f0-9]{64}$/u.test(identity.sha256)) {
		throw new ContractError("fallow-identity", "admitted adapter identity is incompatible");
	}
	const executablePath = await resolveExecutable(identity.requestedPath);
	if (executablePath !== identity.executablePath || await sha256File(executablePath) !== identity.sha256) throw new ContractError("fallow-executable-drift", "admitted executable changed");
	const current = await inspectFallowExecutable(identity.requestedPath);
	if (current.executablePath !== identity.executablePath || current.sha256 !== identity.sha256 || current.version !== identity.version) throw new ContractError("fallow-executable-drift", "admitted executable changed during verification");
}
