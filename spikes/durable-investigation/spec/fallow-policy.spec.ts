import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { waitForPath } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContractError } from "../src/contracts.ts";
import { buildFallowArgv } from "../src/fallow-policy.ts";
import { normalizeFallowDetail, normalizeFallowScan, type FallowFinding } from "../src/fallow-schema.ts";
import { execArgv } from "../src/util.ts";

const hash = "a".repeat(64);
const file: FallowFinding = { id: "file-id", kind: "unused-file", path: "orphan.js", line: 1 };
const symbol: FallowFinding = { id: "symbol-id", kind: "unused-export", path: "lib.js", line: 2, exportName: "unused" };
const base = { executablePath: "/installed/fallow", snapshotPath: "/owned/snapshot", snapshotSha256: hash, retainedScan: { snapshotSha256: hash, findings: [file, symbol] } };
const prefix = ["/installed/fallow", "--root", "/owned/snapshot", "--format", "json", "--quiet", "--no-cache"];
const rejected = (input: Parameters<typeof buildFallowArgv>[0]) => assert.throws(() => buildFallowArgv(input), (error: unknown) => error instanceof ContractError && error.code === "fallow-policy");

test("experimental policy constructs only typed scan and retained file/export operations", () => {
	assert.deepEqual(buildFallowArgv({ ...base, operation: { kind: "scan" } }), [...prefix, "dead-code"]);
	for (const [kind, finding, expected] of [
		["inspect", file, ["inspect", "--file", "orphan.js"]],
		["inspect", symbol, ["inspect", "--symbol", "lib.js:unused"]],
		["trace", file, ["dead-code", "--trace-file", "orphan.js"]],
		["trace", symbol, ["dead-code", "--trace", "lib.js:unused"]],
	] as const) {
		assert.deepEqual(buildFallowArgv({ ...base, operation: { kind, targetFindingId: finding.id } }), [...prefix, ...expected]);
	}
});

test("experimental policy rejects unbound targets, drift, ambiguous paths and unsupported operations", () => {
	const inspect = { kind: "inspect" as const, targetFindingId: file.id };
	rejected({ ...base, operation: { kind: "setup" } as any });
	rejected({ ...base, operation: { kind: "scan", targetFindingId: file.id } as any });
	rejected({ ...base, operation: { kind: "trace", targetFindingId: "missing" } });
	rejected({ ...base, operation: inspect, retainedScan: { ...base.retainedScan, snapshotSha256: "b".repeat(64) } });
	rejected({ ...base, operation: inspect, retainedScan: { ...base.retainedScan, findings: [file, file] } });
	rejected({ ...base, operation: inspect, retainedScan: { ...base.retainedScan, findings: [{ ...file, path: "--help" }] } });
	rejected({ ...base, operation: inspect, retainedScan: { ...base.retainedScan, findings: [{ ...file, path: "../outside" }] } });
	rejected({ ...base, operation: { kind: "trace", targetFindingId: symbol.id }, retainedScan: { ...base.retainedScan, findings: [{ ...symbol, exportName: "a:b" }] } });
	rejected({ ...base, executablePath: "fallow", operation: { kind: "scan" } });
});

test("standalone policy argv and schema cooperate with an explicitly supplied fake executable", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-policy-fake-"));
	try {
		const executablePath = join(root, "fake-fallow");
		await writeFile(executablePath, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst scan = {kind:'dead-code',version:'3.36.0',schema_version:10,summary:{unused_files:1,unused_exports:0},unused_files:[{finding_id:'file-id',path:'orphan.js'}],unused_exports:[]};\nconst detail = {kind:'trace',file:'orphan.js',is_reachable:false};\nconsole.log(JSON.stringify(args.includes('--trace-file') ? detail : scan));\n`, { mode: 0o700 });
		const options = { ...base, executablePath };
		const scan = await execArgv(buildFallowArgv({ ...options, operation: { kind: "scan" } }), { env: {} });
		assert.equal(scan.code, 0);
		const finding = normalizeFallowScan(scan.stdout).findings[0]!;
		const trace = await execArgv(buildFallowArgv({ ...options, retainedScan: { snapshotSha256: hash, findings: [finding] }, operation: { kind: "trace", targetFindingId: finding.id } }), { env: {} });
		assert.equal(trace.code, 0);
		assert.equal(normalizeFallowDetail(trace.stdout, "trace", finding).targetId, finding.id);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("process capture waits for the asynchronous launch receipt and propagates receipt failures", { timeout: 5000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-receipt-"));
	try {
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { entered = resolve; });
		let settled = false;
		const marker = join(root, "child-finished");
		const result = execArgv([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done')`], {
			onSpawn: async () => { entered(); await blocked; },
		}).finally(() => { settled = true; });
		await started;
		await waitForPath(marker);
		assert.equal(settled, false);
		release();
		assert.equal((await result).code, 0);
		await assert.rejects(execArgv([process.execPath, "-e", "process.exit(0)"], {
			onSpawn: () => { throw new Error("receipt failed"); },
		}), /receipt failed/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("process capture terminates an overflowing child and does not launch an already-aborted child", { timeout: 5000 }, async () => {
	await assert.rejects(execArgv([process.execPath, "-e", "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"], { maxBytes: 1024 }), /process output exceeded/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(execArgv([process.execPath, "-e", "process.exit(0)"], { signal: controller.signal }), /aborted before launch/);
});
