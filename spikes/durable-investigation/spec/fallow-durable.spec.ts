import assert from "node:assert/strict";
import { access, chmod, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { context, DurableInvestigationSpike, LedgerDoc } from "../src/durable.ts";
import { execArgv } from "../src/util.ts";
import { fixture, killAndWait, spawnWorker, waitForPath } from "./helpers.ts";

async function fake(path: string, mode = "ok") {
	const source = `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fallow 3.36.0'); process.exit(0); }
if (${JSON.stringify(mode)} === 'malformed') { console.log('{}'); process.exit(0); }
if (${JSON.stringify(mode)} === 'oversized') { process.stdout.write('x'.repeat(100000)); process.exit(0); }
if (a.includes('inspect')) console.log(JSON.stringify({kind:'inspect_target',target:{type:'file',file:'a.ts'},identity:{file:'a.ts',is_reachable:false}}));
else if (a.includes('--trace-file')) console.log(JSON.stringify({kind:'trace',file:'a.ts',is_reachable:false}));
else { console.log(JSON.stringify({kind:'dead-code',version:'3.36.0',schema_version:10,summary:{unused_files:1,unused_exports:0},unused_files:[{finding_id:'file-1',path:'a.ts'}],unused_exports:[]})); process.exitCode=1; }
`;
	await writeFile(path, source, { mode: 0o755 });
	await chmod(path, 0o755);
}

test("default requires an explicit absolute installed executable, never the controlled fixture", async () => {
	const fx = await fixture();
	try {
		for (const analyzerPath of [undefined, "fallow"]) {
			await assert.rejects(DurableInvestigationSpike.open({ root: fx.state, analyzerPath }), /explicit absolute executable path required/);
		}
		const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerPath: fx.analyzer });
		try {
			assert.equal(spike.analyzerMode, "installed-fallow");
			await assert.rejects(spike.admit({ hostRequestId: "not-fallow", sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 }));
		} finally { await spike.close(); }
	} finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("default installed executable runs scan and retained details through Durable", async () => {
	const fx = await fixture(); const executable = join(fx.root, "fallow"); await fake(executable);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerPath: executable });
	try {
		const admitted = await spike.admit({ hostRequestId: "fake", sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 });
		const result = await spike.wait(admitted.id); assert.equal(result.status, "completed");
		const ledger = await spike.ledger();
		assert.deepEqual(result.operationIds.map((id) => ledger.operations[id]!.kind), ["scan", "inspect", "trace"]);
		for (const id of result.operationIds) {
			const op = ledger.operations[id]!; const attempt = ledger.attempts[op.attemptIds[0]!]!;
			assert.equal(attempt.approvedArgv[0], await realpath(executable));
			for (const flag of ["--format", "json", "--quiet", "--no-cache"]) assert.ok(attempt.approvedArgv.includes(flag));
			assert.ok(ledger.evidence[id]);
		}
		await assert.rejects(spike.requestOperation(admitted.id, "trace", "unbound"));
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});

for (const mode of ["malformed", "oversized", "replacement"]) test(`installed executable blocks ${mode}`, async () => {
	const fx = await fixture(); const executable = join(fx.root, "fallow"); await fake(executable, mode);
	let changed = false;
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "installed-fallow", analyzerPath: executable, taskHost: { barrier: async (name) => {
		if (mode === "replacement" && name === "after-launch-intent" && !changed) { changed = true; await fake(executable, "malformed"); }
	} } });
	try {
		const admitted = await spike.admit({ hostRequestId: mode, sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 });
		const result = await spike.wait(admitted.id); assert.equal(result.status, "blocked");
		assert.equal(Object.keys((await spike.ledger()).evidence).length, 0);
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});

for (const drift of ["policy", "target", "artifact"]) test(`installed executable blocks ${drift} drift before detail launch`, async () => {
	const fx = await fixture(); const executable = join(fx.root, "fallow"); await fake(executable);
	let spike!: DurableInvestigationSpike; let changed = false;
	spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "installed-fallow", analyzerPath: executable, taskHost: { barrier: async (name, ids) => {
		if (name !== "after-launch-intent" || changed) return;
		const ledger = await spike.ledger(); const op = ledger.operations[ids.operationId!]!;
		if (op.kind === "scan") return;
		const scanId = ledger.investigations[ids.investigationId]!.evidenceOperationIds[0]!;
		if (drift === "artifact") await writeFile(join(fx.state, ledger.evidence[scanId]!.artifact.relativePath), "{}\n");
		else await spike.rootConversation.commit(async (tx) => {
			const state = await tx.doc(LedgerDoc);
			if (drift === "policy") state.investigations[ids.investigationId]!.payload.analyzer.adapterPolicy = "other";
			else state.evidence[scanId]!.findings[0]!.path = "forged.ts";
		}, context);
		changed = true;
	} } });
	try {
		const admitted = await spike.admit({ hostRequestId: drift, sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 });
		const result = await spike.wait(admitted.id); assert.ok(changed); assert.equal(result.status, "blocked");
		const ledger = await spike.ledger(); const detail = result.operationIds.map((id) => ledger.operations[id]!).find((op) => op.kind !== "scan")!;
		assert.equal(ledger.attempts[detail.attemptIds[0]!]!.pid, undefined);
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});

test("default installed mode blocks recovery of a controlled-fixture attempt", async () => {
	const fx = await fixture(); const executable = join(fx.root, "fallow"); await fake(executable);
	const reached = join(fx.root, "reached"); const ready = join(fx.root, "ready");
	const { child } = await spawnWorker({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, ready,
		request: { hostRequestId: "mode-drift", sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 },
		barrier: { name: "after-artifact-publication", reached, release: join(fx.root, "release") } });
	await waitForPath(reached); await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerPath: executable, recoverOwnership: true });
	try {
		const id = (await readFile(ready, "utf8")).trim(); const result = await spike.wait(id);
		assert.equal(result.status, "blocked");
		assert.match(result.message ?? "", /analyzer-mode-drift/);
		assert.equal(Object.keys((await spike.ledger()).evidence).length, 0);
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});

for (const phase of ["after-launch-intent", "after-artifact-publication"]) test(`installed executable recovery is conservative at ${phase}`, async () => {
	const fx = await fixture(); const executable = join(fx.root, "fallow"); await fake(executable);
	const reached = join(fx.root, "reached"); const release = join(fx.root, "release"); const ready = join(fx.root, "ready");
	const { child } = await spawnWorker({ root: fx.state, analyzerMode: "installed-fallow", analyzerPath: executable, ready,
		request: { hostRequestId: phase, sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 }, barrier: { name: phase, reached, release } });
	await waitForPath(reached); await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "installed-fallow", analyzerPath: executable, recoverOwnership: true });
	try {
		const id = (await readFile(ready, "utf8")).trim(); const result = await spike.wait(id);
		assert.equal(result.status, phase === "after-launch-intent" ? "blocked" : "completed");
		const ledger = await spike.ledger(); const scan = ledger.operations[result.operationIds[0]!]!;
		assert.equal(scan.attemptIds.length, 1);
		if (phase === "after-launch-intent") assert.match(result.message ?? "", /launch-uncertain/);
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});

test("pinned already-installed native Fallow runs through Durable", async (t) => {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
	if (!platform || !arch) return t.skip("unsupported native platform");
	const executable = fileURLToPath(new URL(`../../../node_modules/@fallow-cli/${platform}-${arch}/fallow`, import.meta.url));
	try { await access(executable); } catch (e: any) { if (e.code === "ENOENT") return t.skip("pinned native executable not installed"); throw e; }
	const fx = await fixture();
	await rm(join(fx.repo, "a.ts")); await rm(join(fx.repo, "b.ts"));
	await writeFile(join(fx.repo, "package.json"), '{"name":"synthetic","version":"1.0.0","type":"module"}\n');
	await writeFile(join(fx.repo, ".fallowrc.json"), '{"entry":["index.js"]}\n');
	await writeFile(join(fx.repo, "index.js"), 'import { used } from "./lib.js"; console.log(used);\n');
	await writeFile(join(fx.repo, "lib.js"), 'export const used = 1;\nexport const unused = 2;\n');
	await writeFile(join(fx.repo, "orphan.js"), 'export const orphan = 1;\n');
	assert.equal((await execArgv(["git", "-C", fx.repo, "add", "-A"])).code, 0);
	assert.equal((await execArgv(["git", "-C", fx.repo, "commit", "-qm", "native fixture"])).code, 0);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerPath: executable });
	try {
		const admitted = await spike.admit({ hostRequestId: "native", sourceRepository: fx.repo, deadlineAt: Date.now() + 120000 });
		const result = await spike.wait(admitted.id); assert.equal(result.status, "completed");
		const ledger = await spike.ledger();
		const scan = ledger.evidence[result.operationIds[0]!]!;
		assert.ok(scan.findings.some((f) => f.kind === "unused-file"));
		assert.ok(scan.findings.some((f) => f.kind === "unused-export"));
		assert.ok(result.operationIds.some((id) => ledger.operations[id]!.kind === "trace"));
	} finally { await spike.close(); await rm(fx.root, { recursive: true, force: true }); }
});
