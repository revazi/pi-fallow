import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-fallow-package-"));
const packDir = join(workspace, "pack");
const installDir = join(workspace, "install");

try {
	const packResult = packPackage(packDir);
	validateContents(packResult.files.map((file) => file.path));
	installTarball(join(packDir, packResult.filename), installDir);
	const packageRoot = validateInstalledPackage(installDir);
	const piVersion = await validateInstalledPackageWithPi(packageRoot, join(workspace, "agent-home"));
	console.log(`Package smoke check passed (${packResult.filename}, ${packResult.files.length} files, Pi ${piVersion} RPC).`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

function packPackage(destination) {
	mkdirSync(destination, { recursive: true });
	const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: root,
		encoding: "utf8",
	});
	const [result] = JSON.parse(raw);
	assert.ok(result?.filename, "npm pack did not return a tarball filename.");
	return result;
}

function validateContents(paths) {
	for (const required of ["package.json", "README.md", "LICENSE", "extensions/index.ts", "extensions/fallow.ts"]) {
		assert.ok(paths.includes(required), `Published package is missing ${required}.`);
	}
	for (const forbidden of ["benchmarks/", "coverage/", "node_modules/", "scripts/", "tests/"]) {
		assert.ok(paths.every((path) => !path.startsWith(forbidden)), `Published package unexpectedly contains ${forbidden}.`);
	}
}

function installTarball(tarball, cwd) {
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "package.json"), "{\"private\":true}\n", { flag: "wx" });
	execFileSync("npm", ["install", "--package-lock=false", "--ignore-scripts", "--legacy-peer-deps", tarball], {
		cwd,
		stdio: "pipe",
	});
}

function validateInstalledPackage(cwd) {
	const packageRoot = join(cwd, "node_modules", "pi-fallow");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.name, "pi-fallow");
	assert.equal(manifest.dependencies, undefined, "Published package must not own runtime dependencies.");
	assert.equal(manifest.optionalDependencies, undefined, "Published package must not own optional runtime dependencies.");
	assert.equal(manifest.bundleDependencies, undefined, "Published package must not bundle dependencies.");
	assert.equal(manifest.bundledDependencies, undefined, "Published package must not bundle dependencies.");
	assert.deepEqual(manifest.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/index.ts"]);
	assert.ok(readFileSync(join(packageRoot, "extensions", "index.ts"), "utf8").length > 0);
	return packageRoot;
}

async function validateInstalledPackageWithPi(packageRoot, agentDir) {
	mkdirSync(agentDir, { recursive: true });
	const cliPath = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	const piVersion = execFileSync(process.execPath, [cliPath, "--version"], { cwd: root, encoding: "utf8" }).trim();
	const expectedVersion = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
		.packages["node_modules/@earendil-works/pi-coding-agent"].version;
	assert.equal(piVersion, expectedVersion, "Package smoke must use the locked Pi CLI.");

	const events = [];
	const rpc = new RpcClient({
		cliPath,
		cwd: root,
		env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		args: [
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e", packageRoot,
		],
	});
	const unsubscribe = rpc.onEvent((event) => events.push(event));
	try {
		await rpc.start();
		const commands = await rpc.getCommands();
		const fallowCommands = commands.filter(
			(command) => command.name === "fallow" && command.source === "extension",
		);
		assert.equal(fallowCommands.length, 1, "Packaged /fallow command was not discovered exactly once.");

		await rpc.prompt("/fallow health");
		const messages = await rpc.getMessages();
		const results = messages.filter((message) => message.customType === "fallow-result");
		assert.equal(results.length, 1, "Packaged /fallow health did not emit one Fallow result.");
		assert.match(JSON.stringify(results[0].content), /health_score/, "Fallow health result is missing its health score.");

		const forbiddenEvents = events.filter((event) =>
			["extension_error", "agent_start", "turn_start"].includes(event.type),
		);
		assert.deepEqual(forbiddenEvents, [], "Provider-free extension command emitted an error or agent turn.");
	} finally {
		unsubscribe();
		await rpc.stop();
	}
	assert.equal(rpc.getStderr(), "", `Pi RPC wrote to stderr:\n${rpc.getStderr()}`);
	return piVersion;
}
