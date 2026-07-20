#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.env.PI_FALLOW_PROCESS_FIXTURE_MODE ?? "success";

if (mode === "success") {
	process.stdout.write(JSON.stringify({ kind: "dead-code", schema_version: 7, version: "fixture", elapsed_ms: 1, total_issues: 0, unused_files: [], unused_exports: [] }));
	process.exit(0);
}

if (mode === "findings") {
	process.stdout.write(JSON.stringify({ kind: "dead-code", schema_version: 7, version: "fixture", elapsed_ms: 1, total_issues: 1, unused_files: ["unused.ts"], unused_exports: [] }));
	process.exit(1);
}

if (mode === "error") {
	process.stderr.write("fixture execution error\n");
	process.exit(2);
}

if (mode === "ignore-term") {
	process.on("SIGTERM", () => process.stderr.write("received SIGTERM\n"));
	setInterval(() => {}, 1_000);
} else if (mode === "wait") {
	setInterval(() => {}, 1_000);
} else if (mode === "tree") {
	process.on("SIGTERM", () => process.stderr.write("parent received SIGTERM\n"));
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, PI_FALLOW_PROCESS_FIXTURE_MODE: "ignore-term" },
		stdio: "ignore",
	});
	if (!child.pid) throw new Error("Fixture child did not start.");
	const pidFile = process.env.PI_FALLOW_PROCESS_FIXTURE_PID_FILE;
	if (pidFile) writeFileSync(pidFile, String(child.pid));
	setInterval(() => {}, 1_000);
} else {
	process.stderr.write(`unknown fixture mode: ${mode}\n`);
	process.exit(2);
}
