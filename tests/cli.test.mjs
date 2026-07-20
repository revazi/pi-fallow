import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");

function build(params) {
	return fallowCli.buildFallowArgs(params);
}

function prepare(params) {
	return fallowCli.prepareFallowRunParams(params);
}

describe("fallowCli.buildFallowArgs", () => {
	it("maps compact check-changed args to root --changed-since analysis", () => {
		assert.deepEqual(build({ command: "check-changed", args: ["--changed-since", "main"] }), [
			"--format", "json", "--quiet", "--changed-since", "main",
		]);
		assert.deepEqual(build({ command: "check-changed", args: ["--base=origin/main", "--include-entry-exports"] }), [
			"--format", "json", "--quiet", "--changed-since=origin/main", "--include-entry-exports",
		]);
	});

	it("requires a comparison ref for check-changed", () => {
		assert.throws(() => build({ command: "check-changed" }), /requires args containing --changed-since or --base/);
		assert.throws(() => build({ command: "check-changed", args: ["--changed-since"] }), /requires args containing/);
	});

	it("builds inspect file and symbol queries", () => {
		assert.deepEqual(build({ command: "inspect", args: ["--file", "@extensions/fallow/cli.ts"] }), [
			"inspect", "--format", "json", "--quiet", "--file", "extensions/fallow/cli.ts",
		]);
		assert.deepEqual(build({ command: "inspect", args: ["--symbol=@extensions/fallow/cli.ts:fallowCli", "--symbol-chain"] }), [
			"inspect", "--format", "json", "--quiet", "--symbol=extensions/fallow/cli.ts:fallowCli", "--symbol-chain",
		]);
	});

	it("builds positional trace and explain queries", () => {
		assert.deepEqual(build({ command: "trace-symbol", args: ["@extensions/fallow/cli.ts:fallowCli", "--callers", "--depth", "2"] }), [
			"trace", "extensions/fallow/cli.ts:fallowCli", "--format", "json", "--quiet", "--callers", "--depth", "2",
		]);
		assert.deepEqual(build({ command: "trace-file", args: ["@extensions/fallow/cli.ts"] }), [
			"dead-code", "--trace-file", "extensions/fallow/cli.ts", "--format", "json", "--quiet",
		]);
		assert.deepEqual(build({ command: "explain", args: ["unused-export"] }), [
			"explain", "unused-export", "--format", "json", "--quiet",
		]);
		assert.throws(() => build({ command: "trace-symbol", args: ["--callers"] }), /requires its target/);
	});

	it("builds command aliases and raw options", () => {
		assert.deepEqual(build({ command: "security", args: ["--changed-since", "HEAD~1", "--gate", "new", "--surface"] }), [
			"security", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--gate", "new", "--surface",
		]);
		assert.deepEqual(build({ command: "decision-surface", args: ["--changed-since", "origin/main", "--max-decisions", "4"] }), [
			"decision-surface", "--format", "json", "--quiet", "--changed-since", "origin/main", "--max-decisions", "4",
		]);
		assert.deepEqual(build({ command: "project-info", args: ["--workspaces"] }), [
			"list", "--format", "json", "--quiet", "--workspaces",
		]);
		assert.deepEqual(build({ command: "fix-preview" }), ["fix", "--dry-run", "--format", "json", "--quiet"]);
		assert.deepEqual(build({ command: "coverage-analyze", detail: "summary" }), [
			"coverage", "analyze", "--format", "json", "--quiet",
		]);
	});

	it("builds project inspection commands", () => {
		for (const command of ["workspaces", "config", "schema", "impact"]) {
			assert.deepEqual(build({ command }), [command, "--format", "json", "--quiet"]);
		}
		assert.deepEqual(build({ command: "list-boundaries" }), ["list", "--boundaries", "--format", "json", "--quiet"]);
	});

	it("rejects unsupported commands and format overrides in args", () => {
		assert.throws(() => build({ command: "unknown-command" }), /Unsupported fallow command/);
		assert.throws(() => build({ command: "health", args: ["--format", "human"] }), /must not include --format/);
		assert.throws(() => build({ command: "health", args: ["--format=human"] }), /must not include --format/);
		assert.throws(() => build({ command: "health", args: ["-f", "human"] }), /must not include --format/);
		assert.throws(() => build({ command: "fix-preview", args: ["--yes"] }), /must not include --yes/);
		assert.throws(() => build({ command: "fix-apply", args: ["--dry-run"] }), /must not include --dry-run/);
	});
});

describe("fallowCli.prepareFallowRunParams", () => {
	it("leaves compact arguments unchanged", () => {
		const params = { command: "audit", args: ["--base", "main"], root: "packages/app", detail: "findings" };
		assert.equal(prepare(params), params);
	});

	it("translates stored wide-schema arguments into compact CLI tokens", () => {
		assert.deepEqual(prepare({
			command: "health",
			changedSince: "main",
			fileScores: true,
			targets: true,
			score: true,
			root: "packages/app",
			timeoutSecs: 30,
		}), {
			command: "health",
			args: ["--changed-since", "main", "--file-scores", "--targets", "--score"],
			root: "packages/app",
			timeoutSecs: 30,
		});
		assert.deepEqual(prepare({
			command: "trace-symbol",
			file: "@extensions/fallow/cli.ts",
			exportName: "fallowCli",
			callers: true,
			depth: 2,
		}), {
			command: "trace-symbol",
			args: ["extensions/fallow/cli.ts:fallowCli", "--callers", "--depth", "2"],
		});
	});

	it("preserves every stored wide-schema command translation", () => {
		const cases = [
			[{ command: "all", changedSince: "main", score: true }, ["--changed-since", "main", "--score"]],
			[{ command: "dead-code", changedSince: "main", includeEntryExports: true, groupBy: "owner" }, ["--changed-since", "main", "--include-entry-exports", "--group-by", "owner"]],
			[{ command: "check-changed", base: "origin/main", includeEntryExports: true }, ["--changed-since", "origin/main", "--include-entry-exports"]],
			[{ command: "dupes", changedSince: "main", top: 5, minTokens: 10, skipLocal: true }, ["--changed-since", "main", "--top", "5", "--min-tokens", "10", "--skip-local"]],
			[{ command: "audit", base: "main", gate: "new-only", explain: true }, ["--base", "main", "--gate", "new-only", "--explain"]],
			[{ command: "fix-preview", includeEntryExports: true, noCreateConfig: true }, ["--include-entry-exports", "--no-create-config"]],
			[{ command: "fix-apply", includeEntryExports: true }, ["--include-entry-exports"]],
			[{ command: "flags", top: 3 }, ["--top", "3"]],
			[{ command: "inspect", file: "@extensions/fallow/cli.ts" }, ["--file", "extensions/fallow/cli.ts"]],
			[{ command: "security", base: "main", file: "@src/auth.ts", securityGate: "new", surface: true }, ["--changed-since", "main", "--file", "src/auth.ts", "--gate", "new", "--surface"]],
			[{ command: "workspaces", noCache: true }, ["--no-cache"]],
			[{ command: "config", noCache: true }, ["--no-cache"]],
			[{ command: "schema", noCache: true }, ["--no-cache"]],
			[{ command: "decision-surface", base: "main", maxDecisions: 4 }, ["--changed-since", "main", "--max-decisions", "4"]],
			[{ command: "impact", noCache: true }, ["--no-cache"]],
			[{ command: "project-info", entryPoints: true, files: true, plugins: true, boundaries: true, listWorkspaces: true }, ["--entry-points", "--files", "--plugins", "--boundaries", "--workspaces"]],
			[{ command: "list-boundaries", noCache: true }, ["--no-cache"]],
			[{ command: "explain", issueType: "unused-export" }, ["unused-export"]],
			[{ command: "trace-export", file: "@src/a.ts", exportName: "unused" }, ["src/a.ts:unused"]],
			[{ command: "trace-file", file: "@src/a.ts" }, ["src/a.ts"]],
			[{ command: "trace-dependency", packageName: "jiti" }, ["jiti"]],
			[{ command: "trace-clone", file: "@src/a.ts", line: 10, minLines: 3 }, ["src/a.ts:10", "--min-lines", "3"]],
			[{ command: "coverage-analyze", runtimeCoverage: "coverage.json", top: 5, groupBy: "owner" }, ["--runtime-coverage", "coverage.json", "--top", "5", "--group-by", "owner"]],
		];
		for (const [legacy, args] of cases) {
			assert.deepEqual(prepare(legacy), { command: legacy.command, args });
		}
	});

	it("does not silently consume mixed or unknown argument shapes", () => {
		const mixed = { command: "health", args: ["--score"], score: true };
		const unknown = { command: "health", futureOption: true };
		assert.equal(prepare(mixed), mixed);
		assert.equal(prepare(unknown), unknown);
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
