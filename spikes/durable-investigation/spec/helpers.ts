import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execArgv } from "../src/util.ts";

export async function fixture(prefix = "durable-spike-"): Promise<{ root: string; repo: string; state: string; analyzer: string }> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const repo = join(root, "repo");
	const state = join(root, "state");
	await mkdir(repo);
	await execArgv(["git", "-C", repo, "init", "-q"]);
	await execArgv(["git", "-C", repo, "config", "user.email", "spike@example.invalid"]);
	await execArgv(["git", "-C", repo, "config", "user.name", "Spike"]);
	await writeFile(join(repo, "a.ts"), "// TODO inspect this\nexport const unsafeValue = 1; // unsafe marker\n", "utf8");
	await writeFile(join(repo, "b.ts"), "export const ok = true;\n// FIXME later\n", "utf8");
	await writeFile(join(repo, ".fallowrc.json"), "{\"mode\":\"spike\"}\n", "utf8");
	await execArgv(["git", "-C", repo, "add", "."]);
	await execArgv(["git", "-C", repo, "commit", "-qm", "fixture"]);
	const analyzerSource = resolve(new URL("../src/analyzer.mjs", import.meta.url).pathname);
	const analyzer = join(root, "controlled-analyzer.mjs");
	await writeFile(analyzer, await readFile(analyzerSource));
	return { root, repo, state, analyzer };
}

export async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
	try { await stat(path); return; } catch {}
	await mkdir(dirname(path), { recursive: true });
	const { watch } = await import("node:fs");
	await new Promise<void>((resolvePromise, reject) => {
		const watcher = watch(dirname(path), async () => {
			try {
				await stat(path);
				clearTimeout(timeout);
				watcher.close();
				resolvePromise();
			} catch {}
		});
		const timeout = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${path}`));
		}, timeoutMs);
	});
}

export async function spawnWorker(control: any): Promise<{ child: ReturnType<typeof spawn>; controlPath: string }> {
	await mkdir(control.root, { recursive: true });
	const controlPath = join(control.root, `control-${Math.random().toString(16).slice(2)}.json`);
	await writeFile(controlPath, `${JSON.stringify(control, null, 2)}\n`);
	const child = spawn(process.execPath, ["--experimental-strip-types", resolve(new URL("../src/worker.ts", import.meta.url).pathname), controlPath], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {},
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
	child.once("exit", (code, signal) => {
		if (code && signal === null) process.stderr.write(`worker failed (${code}): ${stderr}\n`);
	});
	return { child, controlPath };
}

export async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
	child.kill("SIGKILL");
	await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

export async function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
}
