import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeFallowArgs, resolveFallowRunArgs } = await jiti.import("../extensions/fallow/command/args.ts");

function normalize(rawArgs, options = {}) {
	const notifications = [];
	const result = normalizeFallowArgs(
		rawArgs,
		options.baseRef ?? "origin/main",
		options.lastArgs ?? null,
		(message, level) => notifications.push({ message, level }),
	);
	return { result, notifications };
}

describe("resolveFallowRunArgs", () => {
	it("defaults empty and run commands to health", () => {
		assert.deepEqual(resolveFallowRunArgs([], []), ["health"]);
		assert.deepEqual(resolveFallowRunArgs(["run"], []), ["health"]);
		assert.deepEqual(resolveFallowRunArgs(["run", "--score"], []), ["health", "--score"]);
	});

	it("uses configured shell-free command tokens without changing explicit commands", () => {
		assert.deepEqual(resolveFallowRunArgs(["run"], ["health", "--complexity", "--targets"]), ["health", "--complexity", "--targets"]);
		assert.deepEqual(resolveFallowRunArgs(["run", "--score"], ["dead-code", "--production"]), ["dead-code", "--production", "--score"]);
		assert.deepEqual(resolveFallowRunArgs(["dupes"], ["health"]), ["dupes"]);
	});

	it("rejects recursive or extension-only defaults", () => {
		for (const command of ["run", "rerun", "about", "version", "update"]) {
			assert.throws(() => resolveFallowRunArgs([], [command]), /PI_FALLOW_DEFAULT_COMMAND must start/);
		}
	});
});

describe("normalizeFallowArgs", () => {
	it("adds PR audit defaults", () => {
		assert.deepEqual(normalize(["pr"]).result, ["audit", "--base", "origin/main", "--gate", "new-only"]);
	});

	it("does not duplicate explicit PR base or gate", () => {
		assert.deepEqual(normalize(["pr", "--base", "main", "--gate=all"]).result, ["audit", "--base", "main", "--gate=all"]);
	});

	it("reruns the last command and warns when missing", () => {
		assert.deepEqual(normalize(["rerun"], { lastArgs: ["health", "--score"] }).result, ["health", "--score"]);
		const missing = normalize(["rerun"]);
		assert.equal(missing.result, null);
		assert.deepEqual(missing.notifications, [{ message: "No previous /fallow command to rerun.", level: "warning" }]);
	});

	it("maps convenience aliases to current Fallow commands", () => {
		assert.deepEqual(normalize(["all"]).result, []);
		assert.deepEqual(normalize(["project-info", "--files"]).result, ["list", "--files"]);
		assert.deepEqual(normalize(["list-boundaries"]).result, ["list", "--boundaries"]);
		assert.deepEqual(normalize(["fix-preview"]).result, ["fix", "--dry-run"]);
		assert.deepEqual(normalize(["fix-apply"]).result, ["fix", "--yes"]);
		assert.deepEqual(normalize(["coverage-analyze"]).result, ["coverage", "analyze"]);
	});

	it("maps check-changed to root changed-file analysis", () => {
		assert.deepEqual(normalize(["check-changed", "--changed-since", "main"]).result, ["--changed-since", "main"]);
		assert.deepEqual(normalize(["check-changed", "--base=origin/main"]).result, ["--base=origin/main"]);
		assert.throws(() => normalize(["check-changed"]), /requires --changed-since or --base/);
	});

	it("validates explain before launching Fallow", () => {
		assert.throws(() => normalize(["explain"]), /explain requires at least one issue type/);
		assert.deepEqual(normalize(["explain", "unused-export"]).result, ["explain", "unused-export"]);
		assert.deepEqual(normalize(["explain", "--help"]).result, ["explain", "--help"]);
	});

	it("maps trace aliases", () => {
		assert.deepEqual(normalize(["trace-file", "extensions/fallow/cli.ts"]).result, [
			"dead-code", "--trace-file", "extensions/fallow/cli.ts",
		]);
		assert.deepEqual(normalize(["trace-export", "extensions/fallow/cli.ts", "fallowCli"]).result, [
			"dead-code", "--trace", "extensions/fallow/cli.ts:fallowCli",
		]);
		assert.deepEqual(normalize(["trace-dependency", "jiti"]).result, ["dead-code", "--trace-dependency", "jiti"]);
		assert.deepEqual(normalize(["trace-clone", "extensions/fallow/cli.ts", "10"]).result, [
			"dupes", "--trace", "extensions/fallow/cli.ts:10",
		]);
		assert.deepEqual(normalize(["trace-clone", "extensions/fallow/cli.ts:10"]).result, [
			"dupes", "--trace", "extensions/fallow/cli.ts:10",
		]);
	});
});
