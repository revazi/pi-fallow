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
	return run("npx", ["-y", "fallow", ...args]);
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
		{ command: "inspect", file: "extensions/fallow/cli.ts" },
		["inspect", "--format", "json", "--quiet", "--file", "extensions/fallow/cli.ts"],
	);
	assertArgs(
		{ command: "inspect", symbol: "extensions/fallow/cli.ts:fallowCli", symbolChain: true },
		["inspect", "--format", "json", "--quiet", "--symbol", "extensions/fallow/cli.ts:fallowCli", "--symbol-chain"],
	);
	assertArgs(
		{ command: "trace-symbol", file: "extensions/fallow/cli.ts", exportName: "fallowCli", callers: true, depth: 2 },
		["trace", "extensions/fallow/cli.ts:fallowCli", "--format", "json", "--quiet", "--callers", "--depth", "2"],
	);
	assertArgs(
		{ command: "security", changedSince: "HEAD~1", securityGate: "new", surface: true },
		["security", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--gate", "new", "--surface"],
	);
	assertArgs(
		{ command: "decision-surface", changedSince: "HEAD~1", maxDecisions: 4 },
		["decision-surface", "--format", "json", "--quiet", "--changed-since", "HEAD~1", "--max-decisions", "4"],
	);
	assertArgs(
		{ command: "project-info", listWorkspaces: true },
		["list", "--format", "json", "--quiet", "--workspaces"],
	);
	for (const command of ["workspaces", "config", "schema", "impact"]) {
		assertArgs({ command }, [command, "--format", "json", "--quiet"]);
	}
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
	assertFallowJson(["workspaces"], (data) => {
		assert.equal(data.kind, "list-workspaces");
		assert.ok(Array.isArray(data.workspaces));
	});
	assertFallowJson(["schema"], (data) => {
		assert.equal(data.name, "fallow");
		assert.ok(Array.isArray(data.commands));
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
