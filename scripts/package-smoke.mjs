import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await runPackageSmoke();
}

async function runPackageSmoke() {
	const workspace = mkdtempSync(join(tmpdir(), "pi-fallow-package-"));
	const packDir = join(workspace, "pack");
	const installDir = join(workspace, "install");

	try {
		const packResult = packPackage(packDir);
		validateContents(packResult.files.map((file) => file.path));
		installTarball(join(packDir, packResult.filename), installDir);
		const packageRoot = validateInstalledPackage(installDir);
		const piVersion = await validateInstalledPackageWithPi(packageRoot, join(workspace, "agent-home"));
		console.log(`Package smoke check passed (${packResult.filename}, ${packResult.files.length} files, Pi ${piVersion} RPC/print/JSON).`);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
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
		args: isolatedPiArgs(packageRoot),
	});
	const unsubscribe = rpc.onEvent((event) => events.push(event));
	try {
		await rpc.start();
		const commands = await rpc.getCommands();
		const fallowCommands = commands.filter(
			(command) => command.name === "fallow" && command.source === "extension",
		);
		assert.equal(fallowCommands.length, 1, "Packaged /fallow command was not discovered exactly once.");

		await rpc.prompt("/fallow");
		let messages = await rpc.getMessages();
		let results = messages.filter((message) => message.customType === "fallow-result");
		assert.equal(results.length, 1, "Packaged default /fallow did not emit one Fallow result.");
		assert.equal(results[0].details?.overview?.title, "Fallow project issues", "Default /fallow did not run project issue aggregation.");

		await rpc.prompt("/fallow health");
		messages = await rpc.getMessages();
		results = messages.filter((message) => message.customType === "fallow-result");
		assert.equal(results.length, 2, "Packaged /fallow health did not emit a second Fallow result.");
		assert.match(JSON.stringify(results[1].content), /health_score/, "Fallow health result is missing its health score.");

		const forbiddenEvents = events.filter((event) =>
			["extension_error", "agent_start", "turn_start"].includes(event.type),
		);
		assert.deepEqual(forbiddenEvents, [], "Provider-free extension command emitted an error or agent turn.");
	} finally {
		unsubscribe();
		await rpc.stop();
	}
	assert.equal(rpc.getStderr(), "", `Pi RPC wrote to stderr:\n${rpc.getStderr()}`);
	validateNonInteractiveModes(cliPath, packageRoot, agentDir);
	return piVersion;
}

function validateNonInteractiveModes(cliPath, packageRoot, agentRoot) {
	const commonArgs = isolatedPiArgs(packageRoot);
	const printResult = runIsolatedPi(cliPath, ["--print", ...commonArgs, "/fallow"], join(agentRoot, "print"));
	assert.equal(printResult.status, 0, `Pi print-mode default /fallow failed:\n${printResult.stderr}`);
	assert.equal(printResult.stderr, "", `Pi print mode wrote to stderr:\n${printResult.stderr}`);

	const jsonResult = runIsolatedPi(cliPath, ["--mode", "json", ...commonArgs, "/fallow"], join(agentRoot, "json"));
	assert.equal(jsonResult.status, 0, `Pi JSON-mode default /fallow failed:\n${jsonResult.stderr}`);
	assert.equal(jsonResult.stderr, "", `Pi JSON mode wrote to stderr:\n${jsonResult.stderr}`);
	const events = jsonResult.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const results = events.filter(
		(event) => event.type === "message_end" && event.message?.customType === "fallow-result",
	);
	assert.equal(results.length, 1, "Pi JSON mode did not emit one Fallow result.");
	assert.equal(results[0].message.details?.overview?.title, "Fallow project issues", "Pi JSON default /fallow did not aggregate project issues.");
	const providerEvents = events.filter((event) => ["agent_start", "turn_start"].includes(event.type));
	assert.deepEqual(providerEvents, [], "Pi JSON-mode extension command started an agent/provider turn.");

	const controlResult = runIsolatedPi(
		cliPath,
		["--print", ...commonArgs, "/pi-fallow-unknown-command"],
		join(agentRoot, "control"),
	);
	assertCredentialFreeControl(controlResult, cliPath);
}

export function assertCredentialFreeControl(result, cliPath) {
	const errorLine = "No API key found for the selected model.";
	const piPackageRoot = dirname(dirname(resolve(cliPath)));
	const stderrLines = result.stderr.split("\n");

	assert.equal(result.status, 1, "Unknown print-mode slash command did not exit with status 1.");
	assert.equal(result.stdout, "", "Unknown print-mode slash command unexpectedly wrote to stdout.");
	assert.equal(stderrLines[0], errorLine, "Unknown print-mode slash command emitted the wrong auth error.");
	assert.equal(
		stderrLines.filter((line) => line === errorLine).length,
		1,
		"Unknown print-mode slash command did not emit the auth error exactly once.",
	);
	assert.deepEqual(stderrLines, [
		errorLine,
		"",
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(piPackageRoot, "docs", "providers.md")}`,
		`  ${join(piPackageRoot, "docs", "models.md")}`,
		"",
	], "Unknown print-mode slash command emitted unexpected auth guidance.");
}

function isolatedPiArgs(packageRoot) {
	return [
		"--no-session",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"-e", packageRoot,
	];
}

function runIsolatedPi(cliPath, args, agentDir) {
	const homeDir = join(agentDir, "home");
	const tempDir = join(agentDir, "tmp");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(tempDir, { recursive: true });
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd: root,
		env: isolatedProcessEnvironment(agentDir, homeDir, tempDir),
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 10 * 1024 * 1024,
	});
	assert.equal(result.error, undefined, `Pi non-interactive process failed: ${result.error}`);
	assert.equal(result.signal, null, `Pi non-interactive process exited from ${result.signal}.`);
	return result;
}

function isolatedProcessEnvironment(agentDir, homeDir, tempDir) {
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: homeDir,
		TMPDIR: tempDir,
		TMP: tempDir,
		TEMP: tempDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		CI: "1",
		NO_COLOR: "1",
	};
	for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return env;
}
