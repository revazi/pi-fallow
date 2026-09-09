import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { inspectRuntimeCoverageCapability, parseCoverageSetupPlan, parseSimilarCodeCapability, runtimeCoverageInstallArgs,
	runtimeCoverageSetupPreview, similarCodeSetupPreview, FALLOW_COV_VERSION } = await jiti.import("../extensions/fallow/optional-analysis.ts");
const { runOptionalSetup } = await jiti.import("../extensions/fallow/command/optional-analysis.ts");
const missing = { kind: "similar-code-status", model_id: "jinaai/jina-embeddings-v2-base-code",
	model_revision: "516f4baf13dec4ddddda8631e019b5737c8bc250", license: "Apache-2.0", cache_dir: "/cache/model",
	model_ready: false, integrity_verified: false, download_bytes: 324329844 };
const plan = { kind: "coverage-setup", schema_version: "1", commands: ["npm install @fallow-cli/beacon"], files_to_edit: [{ path: "src/server.ts" }] };
const wrapperIntegrity = "sha512-j6vKYolLyuOdgoONTFoFZ7RBp5vx/U8lHx9sa1oMZetdD7XAwo3nMd11gQHKuDs2JiBcDTra7YpqxhUyjmz4YA==";
const platformIntegrities = {
	"fallow-cov-darwin-arm64": "sha512-pahht40+IUCi8GFaiY10yVGKy5iwsKg62FwM31G+6UvWAYnrtvh/RpqFBVS5QkvhxBfK0kRr3wugaEfFMBsgVQ==",
	"fallow-cov-darwin-x64": "sha512-hiX+xLSkxGI3UiB0MUleNAk8fHc8/iXaCLwJRRw3TMUlpdh/c/t4GFUUF9UIOcGq+lJtLScJHnfrhXL0u2BmqQ==",
	"fallow-cov-linux-arm64-gnu": "sha512-/NegKdrIOd1uc/f4i1jRFgYX7j9OZgKnN4M2numcM2ThoRPIomULb/ZYFJxhqheEj8mtJiq9LyVqpNmZM+XHpw==",
	"fallow-cov-linux-x64-gnu": "sha512-CBHoqxAjDxPm3G4JER4G6OQR6Zrg9RTdRqIHmd0+Pv34elib7htFSmB9P3HfcSr8TGVCa/fuKcdANIMamcNBcw==",
	"fallow-cov-win32-x64-msvc": "sha512-hs0z/jiXtrffOiwPz/Zk1XnAr52Wjybkywk8l5ZlmPuRV7Dz1sw97Y66aQ2AKODeTqLAwFPVrFnV+Qst1UdEBA==",
};
async function fixture(work) {
	const root = await mkdtemp(join(tmpdir(), "pi-fallow-setup-metadata-"));
	try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function platformPackage() {
	const prefix = `fallow-cov-${process.platform}-${process.arch}`;
	if (process.platform === "darwin") return prefix;
	return prefix + (process.platform === "win32" ? "-msvc" : "-gnu");
}
async function installedFixture(root) {
	const name = platformPackage();
	const scope = join(root, "node_modules", "@fallow-cli");
	await mkdir(join(scope, name), { recursive: true });
	await mkdir(join(scope, "fallow-cov"));
	const wrapper = join(scope, "fallow-cov", "package.json");
	await writeFile(wrapper, JSON.stringify({ name: "@fallow-cli/fallow-cov", version: FALLOW_COV_VERSION, license: "SEE LICENSE IN LICENSE" }));
	await writeFile(join(scope, name, "package.json"), JSON.stringify({ name: `@fallow-cli/${name}`, version: FALLOW_COV_VERSION }));
	const lock = join(root, "node_modules", ".package-lock.json");
	await writeFile(lock, JSON.stringify({ packages: {
		"node_modules/@fallow-cli/fallow-cov": { integrity: wrapperIntegrity },
		[`node_modules/@fallow-cli/${name}`]: { integrity: platformIntegrities[name] },
	} }));
	const binary = join(scope, name, process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov");
	await writeFile(binary, "fixture only: not executed"); await chmod(binary, 0o755);
	await writeFile(`${binary}.sig`, "presence only; cryptographic checks live in runtime-readiness tests");
	return { wrapper, lock, binary };
}

describe("optional setup metadata and safety (no legacy dialogs)", () => {
	it("classifies missing, ready, incompatible and corrupt model identities and bounds problems", () => {
		assert.equal(parseSimilarCodeCapability(missing).phase, "missing");
		assert.equal(parseSimilarCodeCapability({ ...missing, model_ready: true, integrity_verified: true }).phase, "ready");
		assert.equal(parseSimilarCodeCapability({ ...missing, model_revision: "drift" }).phase, "incompatible");
		assert.equal(parseSimilarCodeCapability({ ...missing, model_ready: true }).phase, "corrupt");
		assert.equal(parseSimilarCodeCapability({ ...missing, problem: "x".repeat(5000) }).problem.length, 1000);
	});
	it("rejects incompatible plans, ignores telemetry for drift, and bounds proposed cloud work", async () => {
		assert.throws(() => parseCoverageSetupPlan({ ...plan, schema_version: 2 }), /incompatible/);
		const left = await inspectRuntimeCoverageCapability({ ...plan, _meta: { id: 1 } }, "/missing/sidecar");
		const right = await inspectRuntimeCoverageCapability({ ...plan, _meta: { id: 2 } }, "/missing/sidecar");
		assert.equal(left.planFingerprint, right.planFingerprint);
		const large = await inspectRuntimeCoverageCapability({ ...plan, commands: Array(15).fill("x".repeat(500)), files_to_edit: Array(25).fill({ path: "path" }) }, "/missing/sidecar");
		assert.equal(large.plan.commands.length, 10); assert.equal(large.plan.omittedCommands, 5);
		assert.equal(large.plan.filesToEdit.length, 20); assert.match(runtimeCoverageSetupPreview(large), /\+5 more not shown/);
	});
	it("retains exact package, lock integrity, platform and signature-presence checks", async () => {
		await fixture(async (root) => {
			const { binary, wrapper, lock } = await installedFixture(root);
			const state = await inspectRuntimeCoverageCapability(plan, root);
			assert.equal(state.phase, "ready"); assert.equal(state.signaturePresent, true); assert.ok(state.installedBytes > 0);
			await rm(`${binary}.sig`); assert.equal((await inspectRuntimeCoverageCapability(plan, root)).phase, "corrupt");
			await writeFile(`${binary}.sig`, "present");
			await writeFile(lock, "{}"); assert.equal((await inspectRuntimeCoverageCapability(plan, root)).phase, "corrupt");
			await writeFile(wrapper, JSON.stringify({ name: "@fallow-cli/fallow-cov", version: "9.9.9" }));
			assert.equal((await inspectRuntimeCoverageCapability(plan, root)).phase, "incompatible");
		});
	});
	it("canonicalizes destination symlinks and refuses managed installation inside the project", async () => {
		await fixture(async (root) => {
			const project = join(root, "project"); await mkdir(project);
			const alias = join(root, "alias"); await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
			const destination = join(alias, "sidecar");
			assert.equal((await inspectRuntimeCoverageCapability(plan, destination)).destination, join(await realpath(project), "sidecar"));
			const state = {};
			await runOptionalSetup("runtime-coverage", "tui", { cwd: project, confirm: () => assert.fail("no consent for unsafe destination") }, state, {
				runFallow: async () => ({ result: { code: 0, stdout: JSON.stringify(plan), stderr: "" } }),
				inspectRuntime: () => inspectRuntimeCoverageCapability(plan, destination), runProcess: () => assert.fail("no install"),
			});
			assert.match(state.notice, /inside the project/);
		});
	});
	it("discloses pinned source, license, size, commands, destinations and excluded project/cloud work", async () => {
		const model = similarCodeSetupPreview(parseSimilarCodeCapability(missing));
		assert.match(model, /Hugging Face/); assert.match(model, new RegExp(missing.model_revision));
		assert.match(model, /Apache-2\.0.*309 MiB.*1\.2 GiB/s); assert.match(model, /Destination: \/cache\/model/);
		assert.match(model, /--local --yes/);
		const coverage = runtimeCoverageSetupPreview(await inspectRuntimeCoverageCapability(plan, "/managed/sidecar"));
		assert.match(coverage, /@fallow-cli\/fallow-cov@0\.4\.1/); assert.match(coverage, /Proprietary.*approximately 3 MiB/s);
		assert.match(coverage, /will NOT perform.*beacon.*src\/server\.ts/s);
		assert.ok(runtimeCoverageInstallArgs("/managed/sidecar").includes("--ignore-scripts"));
	});
});
