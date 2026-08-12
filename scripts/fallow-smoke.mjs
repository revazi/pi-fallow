import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");

function assertArgs(params, expected) {
	assert.deepEqual(fallowCli.buildFallowArgs(params), expected, params.command);
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", options.allowStderr ? "pipe" : "inherit"],
		...options,
	});
}

function runFallow(args) {
	return run("fallow", args);
}

function parseJsonOutput(raw) {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error(`No JSON object found in output:\n${raw}`);
		return JSON.parse(trimmed.slice(start, end + 1));
	}
}

function assertFallowJson(args, validate) {
	const raw = runFallow([...args, "--format", "json", "--quiet"]);
	validate(parseJsonOutput(raw));
}

function hasGitRef(ref) {
	try {
		run("git", ["rev-parse", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

function assertModeledArgs() {
	assertArgs(
		{ command: "inspect", args: ["--file", "extensions/fallow/cli.ts"] },
		["inspect", "--format", "json", "--quiet", "--file", "extensions/fallow/cli.ts"],
	);
	assertArgs(
		{ command: "inspect", args: ["--symbol", "extensions/fallow/cli.ts:fallowCli", "--symbol-chain"] },
		["inspect", "--format", "json", "--quiet", "--symbol", "extensions/fallow/cli.ts:fallowCli", "--symbol-chain"],
	);
	assertArgs(
		{ command: "trace-symbol", args: ["extensions/fallow/cli.ts:fallowCli", "--callers", "--depth", "2"] },
		["trace", "extensions/fallow/cli.ts:fallowCli", "--format", "json", "--quiet", "--callers", "--depth", "2"],
	);
	assertArgs(
		{ command: "security", args: ["--changed-since", "HEAD~1", "--gate", "new", "--surface"] },
		["security", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--gate", "new", "--surface"],
	);
	assertArgs(
		{ command: "architecture", args: ["@extensions/fallow/cli.ts", "@extensions/fallow/registry.ts", "--no-cache"] },
		["guard", "extensions/fallow/cli.ts", "--format", "json", "--quiet", "extensions/fallow/registry.ts", "--no-cache"],
	);
	assertArgs(
		{ command: "decision-surface", args: ["--changed-since", "HEAD~1", "--max-decisions", "4"] },
		["decision-surface", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--max-decisions", "4"],
	);
	assertArgs(
		{ command: "project-info", args: ["--workspaces"] },
		["list", "--format", "json", "--quiet", "--workspaces"],
	);
	assertArgs(
		{ command: "dead-code", args: ["--type-aware", "--symbol-impact", "extensions/fallow/cli.ts:fallowCli"] },
		["dead-code", "--format", "json", "--quiet", "--type-aware", "--symbol-impact", "extensions/fallow/cli.ts:fallowCli"],
	);
	assertArgs(
		{ command: "health", args: ["--type-aware", "--type-coupling", "--baseline-mode", "identity"] },
		["health", "--format", "json", "--quiet", "--type-aware", "--type-coupling", "--baseline-mode", "identity"],
	);
	for (const command of ["workspaces", "config", "schema", "impact"]) {
		assertArgs({ command }, [command, "--format", "json", "--quiet"]);
	}
}

function assertCurrentFallowSchema(data) {
	assert.equal(data.name, "fallow");
	assert.equal(data.version, "3.14.0");
	assert.ok(Array.isArray(data.commands));
	const commands = new Map(data.commands.map((command) => [command.name, command]));
	for (const command of [
		"dead-code", "type-aware", "inspect", "trace", "guard", "fix", "config", "list", "workspaces", "dupes", "health",
		"flags", "explain", "audit", "decision-surface", "impact", "security", "report", "schema", "coverage", "viz",
	]) {
		assert.ok(commands.has(command), `Fallow schema is missing ${command}`);
	}
	const globalFlags = new Set(data.global_flags.map((flag) => flag.name));
	for (const flag of ["--type-aware", "--type-aware-project", "--type-aware-require", "--no-type-aware", "--baseline-mode"]) {
		assert.ok(globalFlags.has(flag), `Fallow schema is missing ${flag}`);
	}
	assert.ok(commands.get("dead-code").flags.some((flag) => flag.name === "--symbol-impact"));
	assert.ok(commands.get("health").flags.some((flag) => flag.name === "--type-coupling"));
	assert.match(commands.get("guard").description, /architecture rules apply to files/);
	assert.deepEqual(commands.get("guard").flags, [{
		name: "files",
		type: "string",
		required: true,
		description: "Files to report on (root-relative or absolute; may not exist yet)",
	}]);
	assert.deepEqual(commands.get("type-aware").flags, []);
	assert.match(commands.get("report").description, /codeclimate.*sarif/);
	assert.deepEqual(commands.get("viz").flags.map((flag) => flag.name), ["--out", "--no-open", "--viz-format"]);
}

function assertCliSurfaces() {
	assertFallowJson(["inspect", "--file", "extensions/fallow/cli.ts"], (data) => {
		assert.equal(data.kind, "inspect_target");
		assert.equal(data.target?.type, "file");
	});
	assertFallowJson(["trace", "extensions/fallow/cli.ts:fallowCli"], (data) => {
		assert.equal(data.kind, "trace");
		assert.equal(data.symbol, "fallowCli");
	});
	assertFallowJson(["security"], (data) => {
		assert.equal(data.kind, "security");
		assert.ok(Array.isArray(data.security_findings));
	});
	assertFallowJson(["guard", "extensions/fallow/cli.ts"], (data) => {
		assert.equal(data.kind, "guard");
		assert.equal(data.files?.[0]?.path, "extensions/fallow/cli.ts");
	});
	assertFallowJson(["workspaces"], (data) => {
		assert.equal(data.kind, "list-workspaces");
		assert.ok(Array.isArray(data.workspaces));
	});
	assertFallowJson(["schema"], assertCurrentFallowSchema);
	assertFallowJson(["type-aware", "status"], (data) => {
		assert.equal(data.kind, "type-aware-status");
		assert.equal(data.schema_version, 7);
		assert.equal(typeof data.available, "boolean");
	});
	assertFallowJson(["dead-code", "--type-aware", "--symbol-impact", "extensions/fallow/cli.ts:fallowCli"], (data) => {
		assert.equal(data.kind, "impact");
		assert.ok(Array.isArray(data.direct_consumers));
		assert.ok(Array.isArray(data.affected_files));
		assert.ok(Array.isArray(data.targeted_tests));
	});
	assertFallowJson(["health", "--type-aware", "--type-coupling"], (data) => {
		assert.equal(data.kind, "health");
		assert.equal(data._meta?.type_aware?.executed, true);
		assert.ok(data._meta.type_aware.type_coupling);
	});
	assertFallowJson(["impact"], (data) => {
		assert.equal(data.kind, "impact");
	});
	assertFallowJson(["config"], (data) => {
		assert.ok(Array.isArray(data.entry));
		assert.ok(data.rules && typeof data.rules === "object");
	});
	if (hasGitRef("HEAD~1")) {
		assertFallowJson(["decision-surface", "--changed-since", "HEAD~1"], (data) => {
			assert.equal(data.kind, "decision-surface");
			assert.ok(Array.isArray(data.decisions));
		});
	} else {
		console.warn("Skipping decision-surface smoke check: HEAD~1 is unavailable.");
	}
}

assertModeledArgs();
assertCliSurfaces();
console.log("Fallow CLI smoke checks passed.");
