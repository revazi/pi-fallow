import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export function sha256Text(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function digestJson(value: unknown): string {
	return sha256Text(stableJson(value));
}

export function randomToken(): string {
	return randomBytes(16).toString("hex");
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomToken()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function readJsonFile(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function removeIfExists(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function execArgv(argv: readonly string[], options: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxBytes?: number;
	signal?: AbortSignal;
	onSpawn?: (pid: number) => void | Promise<void>;
} = {}): Promise<ExecResult> {
	if (argv.length === 0) throw new Error("argv must not be empty");
	const maxBytes = options.maxBytes ?? 256 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid output limit");
	if (options.signal?.aborted) throw new Error("process aborted before launch");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let overflow = false;
		let settled = false;
		let spawnReceipt: Promise<void> = Promise.resolve();
		child.once("spawn", () => {
			if (!child.pid) return;
			const pid = child.pid;
			// The child can exit before an asynchronous receipt commit finishes.
			// Do not publish its result until that commit has settled.
			spawnReceipt = Promise.resolve().then(() => options.onSpawn?.(pid)).then(() => {});
			void spawnReceipt.catch(() => terminate());
		});
		const append = (current: Buffer, chunk: Buffer): Buffer => {
			const next = Buffer.concat([current, chunk]);
			if (next.byteLength <= maxBytes) return next;
			overflow = true;
			terminate();
			return next.subarray(0, maxBytes);
		};
		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
		const terminate = () => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {}
		};
		const abort = () => terminate();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", abort);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", abort);
			void spawnReceipt.then(() => {
				if (overflow) return reject(new Error(`process output exceeded ${maxBytes} bytes`));
				resolvePromise({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
			}, reject);
		});
	});
}

export function absolute(path: string): string {
	return resolve(path);
}
