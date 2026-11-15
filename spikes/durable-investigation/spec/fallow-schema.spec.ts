import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ContractError, MAX_OUTPUT_BYTES } from "../src/contracts.ts";
import { FALLOW_VERSION, normalizeFallowDetail, normalizeFallowScan } from "../src/fallow-schema.ts";
import { execArgv } from "../src/util.ts";

const scan = (changes: Record<string, unknown> = {}) => JSON.stringify({
	kind: "dead-code", schema_version: 10, version: FALLOW_VERSION,
	summary: { unused_files: 1, unused_exports: 1 },
	unused_files: [{ finding_id: "file-id", path: "orphan.js" }],
	unused_exports: [{ finding_id: "export-id", path: "lib.js", line: 2, export_name: "unused" }],
	...changes,
});
const rejectsSchema = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof ContractError && e.code === "fallow-schema");

test("pinned scan schema produces a narrow bounded representation and rejects incompatible records", () => {
	const result = normalizeFallowScan(scan());
	assert.deepEqual(result.findings.map((f) => f.kind), ["unused-file", "unused-export"]);
	assert.equal(result.found, 2);
	assert.equal(result.truncated, false);
	for (const bad of [
		"not-json", scan({ schema_version: 11 }), scan({ version: "0.0.0" }), scan({ kind: "other" }),
		scan({ summary: { unused_files: 0, unused_exports: 1 } }),
		scan({ unused_files: [{ finding_id: "file-id", path: "../escape" }] }),
		scan({ unused_files: [{ finding_id: "export-id", path: "orphan.js" }] }),
		scan({ unused_exports: [{ finding_id: "export-id", path: "lib.js", line: 0, export_name: "unused" }] }),
	]) rejectsSchema(() => normalizeFallowScan(bad));
	assert.throws(() => normalizeFallowScan(" ".repeat(MAX_OUTPUT_BYTES + 1)), (e: unknown) => e instanceof ContractError && e.code === "fallow-output-oversized");
});

test("detail normalization rejects target, operation, and schema mismatches", () => {
	const [file, symbol] = normalizeFallowScan(scan()).findings;
	assert.deepEqual(normalizeFallowDetail(JSON.stringify({ kind: "trace", file: "orphan.js", is_reachable: false }), "trace", file!), { kind: "trace", targetId: "file-id", reachable: false });
	assert.deepEqual(normalizeFallowDetail(JSON.stringify({ kind: "inspect_target", target: { type: "symbol", file: "lib.js", export_name: "unused" }, identity: { file: "lib.js", export_name: "unused", file_reachable: true } }), "inspect", symbol!), { kind: "inspect", targetId: "export-id", reachable: true });
	rejectsSchema(() => normalizeFallowDetail(JSON.stringify({ kind: "trace", file: "other.js", is_reachable: false }), "trace", file!));
	rejectsSchema(() => normalizeFallowDetail(JSON.stringify({ kind: "trace", file: "lib.js", export_name: "other", file_reachable: true }), "trace", symbol!));
	rejectsSchema(() => normalizeFallowDetail(JSON.stringify({ kind: "trace", file: "orphan.js", is_reachable: false }), "inspect", file!));
});

test("pinned installed native Fallow emits compatible scan, inspect and trace schemas", async (t) => {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
	if (!platform || !arch) return t.skip("no native binary path defined for this platform");
	const executable = fileURLToPath(new URL(`../../../node_modules/@fallow-cli/${platform}-${arch}/fallow`, import.meta.url));
	try { await access(executable); } catch (e: any) { if (e.code === "ENOENT") return t.skip("pinned native Fallow is not already installed"); throw e; }
	const root = await mkdtemp(join(tmpdir(), "fallow-schema-cert-"));
	try {
		await mkdir(join(root, "home"));
		await writeFile(join(root, "package.json"), '{"name":"synthetic","version":"1.0.0","type":"module"}\n');
		await writeFile(join(root, ".fallowrc.json"), '{"entry":["index.js"]}\n');
		await writeFile(join(root, "index.js"), 'import { used } from "./lib.js"; console.log(used);\n');
		await writeFile(join(root, "lib.js"), 'export const used = 1;\nexport const unused = 2;\n');
		await writeFile(join(root, "orphan.js"), 'export const orphan = 1;\n');
		const env = { HOME: join(root, "home"), PATH: "/usr/bin:/bin" };
		const version = await execArgv([executable, "--version"], { env, maxBytes: 4096 });
		assert.equal(version.code, 0);
		assert.equal(version.stdout.trim(), `fallow ${FALLOW_VERSION}`);
		const run = (args: string[]) => execArgv([executable, "--root", root, "--format", "json", "--quiet", "--no-cache", ...args], { cwd: root, env, maxBytes: MAX_OUTPUT_BYTES });
		const scanResult = await run(["dead-code"]);
		assert.ok([0, 1].includes(scanResult.code));
		const found = normalizeFallowScan(scanResult.stdout).findings;
		const file = found.find((f) => f.kind === "unused-file" && f.path === "orphan.js");
		const symbol = found.find((f) => f.kind === "unused-export" && f.path === "lib.js" && f.exportName === "unused");
		assert.ok(file && symbol, "synthetic unused file and export are reported");
		for (const finding of [file, symbol]) {
			const target = finding.kind === "unused-file" ? finding.path : `${finding.path}:${finding.exportName}`;
			const inspect = await run(["inspect", finding.kind === "unused-file" ? "--file" : "--symbol", target]);
			assert.equal(inspect.code, 0);
			assert.equal(normalizeFallowDetail(inspect.stdout, "inspect", finding).targetId, finding.id);
			const trace = await run(["dead-code", finding.kind === "unused-file" ? "--trace-file" : "--trace", target]);
			assert.equal(trace.code, 0);
			assert.equal(normalizeFallowDetail(trace.stdout, "trace", finding).targetId, finding.id);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
