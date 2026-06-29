import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");

function build(params) {
	return fallowCli.buildFallowArgs(params);
}

describe("fallowCli.buildFallowArgs", () => {
	it("maps check-changed to root --changed-since analysis", () => {
		assert.deepEqual(build({ command: "check-changed", changedSince: "main" }), [
			"--format", "json", "--quiet", "--changed-since", "main",
		]);
	});

	it("accepts base as check-changed changed-since alias", () => {
		assert.deepEqual(build({ command: "check-changed", base: "origin/main", includeEntryExports: true }), [
			"--format", "json", "--quiet", "--changed-since", "origin/main", "--include-entry-exports",
		]);
	});

	it("requires a comparison ref for check-changed", () => {
		assert.throws(() => build({ command: "check-changed" }), /requires changedSince or base/);
	});

	it("builds inspect file and symbol queries", () => {
		assert.deepEqual(build({ command: "inspect", file: "@extensions/fallow/cli.ts" }), [
			"inspect", "--format", "json", "--quiet", "--file", "extensions/fallow/cli.ts",
		]);
		assert.deepEqual(build({ command: "inspect", symbol: "@extensions/fallow/cli.ts:fallowCli", symbolChain: true }), [
			"inspect", "--format", "json", "--quiet", "--symbol", "extensions/fallow/cli.ts:fallowCli", "--symbol-chain",
		]);
	});

	it("builds trace-symbol queries", () => {
		assert.deepEqual(build({ command: "trace-symbol", file: "extensions/fallow/cli.ts", exportName: "fallowCli", callers: true, depth: 2 }), [
			"trace", "extensions/fallow/cli.ts:fallowCli", "--format", "json", "--quiet", "--callers", "--depth", "2",
		]);
	});

	it("builds security and decision-surface commands", () => {
		assert.deepEqual(build({ command: "security", changedSince: "HEAD~1", securityGate: "new", surface: true }), [
			"security", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--gate", "new", "--surface",
		]);
		assert.deepEqual(build({ command: "decision-surface", base: "origin/main", maxDecisions: 4 }), [
			"decision-surface", "--format", "json", "--quiet", "--changed-since", "origin/main", "--max-decisions", "4",
		]);
	});

	it("builds project inspection commands", () => {
		assert.deepEqual(build({ command: "workspaces" }), ["workspaces", "--format", "json", "--quiet"]);
		assert.deepEqual(build({ command: "config" }), ["config", "--format", "json", "--quiet"]);
		assert.deepEqual(build({ command: "schema" }), ["schema", "--format", "json", "--quiet"]);
		assert.deepEqual(build({ command: "impact" }), ["impact", "--format", "json", "--quiet"]);
		assert.deepEqual(build({ command: "project-info", listWorkspaces: true }), ["list", "--format", "json", "--quiet", "--workspaces"]);
	});

	it("rejects format overrides in extraArgs", () => {
		assert.throws(() => build({ command: "health", extraArgs: ["--format", "human"] }), /must not include --format/);
		assert.throws(() => build({ command: "health", extraArgs: ["--format=human"] }), /must not include --format/);
		assert.throws(() => build({ command: "health", extraArgs: ["-f", "human"] }), /must not include --format/);
	});
});

describe("fallowCli.splitArgs", () => {
	it("splits quoted and escaped arguments", () => {
		assert.deepEqual(fallowCli.splitArgs("audit --base origin/main --name 'hello world' path\\ with\\ spaces"), [
			"audit", "--base", "origin/main", "--name", "hello world", "path with spaces",
		]);
	});

	it("throws for unclosed quotes", () => {
		assert.throws(() => fallowCli.splitArgs("audit --base 'origin/main"), /Unclosed quote/);
	});
});
