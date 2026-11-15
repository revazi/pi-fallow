#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const VERSION = "controlled-analyzer/1";
const args = process.argv.slice(2);
if (args[0] === "--version") {
	process.stdout.write(`${VERSION}\n`);
	process.exit(0);
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}
function value(flag) {
	const index = args.indexOf(flag);
	if (index < 0 || index + 1 >= args.length) fail(`missing ${flag}`);
	return args[index + 1];
}
const allowedFlags = new Set(["--root", "--output", "--receipt", "--token", "--target"]);
for (let index = 1; index < args.length; index++) {
	const item = args[index];
	if (!item.startsWith("--") || !allowedFlags.has(item)) fail(`forbidden argument: ${item}`);
	index++;
}
const operation = args[0];
if (!["scan", "inspect", "trace"].includes(operation)) fail(`unsupported operation: ${operation}`);
const root = resolve(value("--root"));
const output = resolve(value("--output"));
const receipt = resolve(value("--receipt"));
const token = value("--token");
const target = operation === "scan" ? undefined : value("--target");
if (relative(root, output).startsWith("..") === false) fail("output must be outside the snapshot");

await mkdir(dirname(receipt), { recursive: true });
await writeFile(receipt, `${JSON.stringify({ pid: process.pid, token, version: VERSION, operation, startedAt: Date.now() })}\n`, { mode: 0o600 });
if (process.env.SPIKE_BARRIER_PATH) {
	await writeFile(process.env.SPIKE_BARRIER_PATH, `${token}\n`, { mode: 0o600 });
	const release = process.env.SPIKE_RELEASE_PATH;
	if (!release) fail("barrier requires release path");
	while (true) {
		try { await stat(release); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); }
	}
}

async function filesBelow(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await filesBelow(path));
		else if (entry.isFile()) found.push(path);
	}
	return found.sort();
}
function findingId(path, line, text) {
	return createHash("sha256").update(`${path}\0${line}\0${text}`).digest("hex").slice(0, 16);
}
const sourceFiles = (await filesBelow(root)).filter((path) => /\.(?:[cm]?[jt]s|tsx?|json|md)$/.test(path));
const findings = [];
for (const path of sourceFiles) {
	const rel = relative(root, path).split("\\").join("/");
	const text = await readFile(path, "utf8");
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!/TODO|FIXME|unsafe/i.test(line)) continue;
		findings.push({ id: findingId(rel, index + 1, line.trim()), kind: /unsafe/i.test(line) ? "unsafe-marker" : "work-marker", path: rel, line: index + 1, summary: line.trim().slice(0, 240) });
	}
}
let result;
if (operation === "scan") {
	result = { version: VERSION, operation, complete: true, findingCount: findings.length, findings };
} else {
	const finding = findings.find((item) => item.id === target);
	if (!finding) result = { version: VERSION, operation, target, complete: false, completenessReason: "target-not-found", findingCount: findings.length, findings: [] };
	else if (operation === "inspect") {
		const text = await readFile(join(root, finding.path), "utf8");
		const lines = text.split(/\r?\n/);
		result = { version: VERSION, operation, target, complete: true, findingCount: 1, findings: [finding], excerpt: lines.slice(Math.max(0, finding.line - 2), finding.line + 1) };
	} else {
		const related = findings.filter((item) => item.path === finding.path).slice(0, 8);
		result = { version: VERSION, operation, target, complete: true, findingCount: related.length, findings: related, trace: related.map((item) => item.id) };
	}
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result)}\n`, { mode: 0o600 });
process.stdout.write(`${operation}:${target ?? "repository"}\n`);
