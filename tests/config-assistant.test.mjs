import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	createFallowConfigAssistant,
	formatFallowConfigPreview,
} = await jiti.import("../extensions/fallow/config-assistant.ts");
const { runFallowConfigAssistantCommand } = await jiti.import("../extensions/fallow/command/config-assistant.ts");

const schema = {
	$defs: {
		RulesConfig: {
			properties: {
				"unused-exports": { $ref: "#/$defs/Severity" },
				"security-sink": { $ref: "#/$defs/Severity" },
			},
		},
	},
};

function success(stdout = "") {
	return { result: { code: 0, killed: false, stdout, stderr: "" } };
}

function fixtureRunner(source, options = {}) {
	const calls = [];
	return {
		calls,
		clear() {},
		async execute(_pi, args, cwd, signal, timeout) {
			calls.push({ args, cwd, signal, timeout });
			if (args.includes("--path")) return configPathResult(source);
			return configPayloadResult(args[0], options);
		},
	};
}

function configPathResult(source) {
	return source ? success(`${source}\n`) : { result: { code: 3, killed: false, stdout: "", stderr: "" } };
}

function configPayloadResult(command, options) {
	if (command === "config-schema") return configSchemaResult(options);
	return resolvedConfigResult(options);
}

function configSchemaResult(options) {
	return success(JSON.stringify(options.schema ?? schema));
}

function resolvedConfigResult(options) {
	if (options.configFailure) return { result: { code: 2, killed: false, stdout: "", stderr: "sensitive raw config must not escape" } };
	return success(JSON.stringify(options.resolved ?? {
		entry: ["src/index.ts"],
		rules: { "unused-exports": "error", secretToken: "do-not-copy" },
		workspaces: ["private-workspace"],
		plugins: ["private-plugin"],
		boundaries: { zones: [{}], rules: [{}] },
		overrides: [{}],
	}));
}

async function workspace() {
	return mkdtemp(join(tmpdir(), "pi-fallow-config-assistant-"));
}

async function withWorkspace(run) {
	const root = await workspace();
	try { await run(root); }
	finally { await rm(root, { recursive: true, force: true }); }
}

function assistantFor(source, options) {
	return createFallowConfigAssistant({}, fixtureRunner(source, options));
}

describe("safe Fallow configuration assistant", () => {
	it("inspects only bounded counts and separates project from inherited ownership", async () => {
		await withWorkspace(async (root) => {
			const project = join(root, ".fallowrc.json");
			await writeFile(project, '{"private":"do-not-copy"}\n');
			const assistant = assistantFor(project);
			const report = await assistant.inspect(root);
			assert.equal(report.status, "ready");
			assert.equal(report.ownership, "project");
			assert.deepEqual(report.counts, { entries: 1, rules: 2, workspaces: 1, plugins: 1, boundaries: 2, overrides: 1 });
			assert.doesNotMatch(JSON.stringify(report), /do-not-copy|private-plugin|private-workspace|secretToken/);

			const child = join(root, "packages", "child");
			await mkdir(child, { recursive: true });
			const inherited = await assistant.inspect(child);
			assert.equal(inherited.ownership, "inherited");
			assert.match(inherited.summary, /externally owned/);
		});
	});

	it("keeps JSON preview read-only, then backs up and atomically applies only after use", async () => {
		await withWorkspace(async (root) => {
			const path = join(root, ".fallowrc.json");
			const original = '{\n  "rules": { "unused-exports": "error" },\n  "private": "keep-me"\n}\n';
			await writeFile(path, original);
			await chmod(path, 0o640);
			const assistant = assistantFor(path);
			const plan = await assistant.previewRule(root, "unused-exports", "warn");
			assert.equal(await readFile(path, "utf8"), original, "preview must not write");
			assert.doesNotMatch(formatFallowConfigPreview(plan.preview), /keep-me/);
			assert.equal(plan.preview.schemaPath, "$.rules.unused-exports");
			await assert.rejects(assistant.apply(plan, root), /Explicit confirmation is required/);
			assert.equal(await readFile(path, "utf8"), original);
			const result = await assistant.apply(plan, root, { confirmed: true });
			assert.equal(result.status, "applied");
			assert.equal(await readFile(`${path}.pi-fallow.bak`, "utf8"), original);
			assert.match(await readFile(path, "utf8"), /"unused-exports": "warn"/);
			assert.match(await readFile(path, "utf8"), /"private": "keep-me"/);
			if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o640);
			assert.ok((await readdir(root)).every((name) => !name.endsWith(".tmp")));
		});
	});

	it("preserves JSONC comments and TOML formatting while changing an existing rule", async () => {
		for (const [name, original, expected] of [
			[".fallowrc.jsonc", '{\n  // retain this comment\n  "rules": {\n    "unused-exports": "error", // retain trailing comma\n  },\n}\n', /"unused-exports": "off", \/\/ retain trailing comma/],
			["fallow.toml", '# retain this comment\n[rules]\n"unused\\u002Dexports" = "error" # retain inline comment\n', /"unused\\u002Dexports" = "off" # retain inline comment/],
		]) {
			await withWorkspace(async (root) => {
				const path = join(root, name);
				await writeFile(path, original);
				const assistant = assistantFor(path);
				const plan = await assistant.previewRule(root, "unused-exports", "off");
				assert.equal(await readFile(path, "utf8"), original);
				await assistant.apply(plan, root, { confirmed: true });
				assert.match(await readFile(path, "utf8"), expected);
				assert.match(await readFile(`${path}.pi-fallow.bak`, "utf8"), /retain/);
			});
		}
	});

	it("creates a project-owned JSONC override instead of modifying inherited configuration", async () => {
		await withWorkspace(async (root) => {
			const inherited = join(root, ".fallowrc.jsonc");
			const inheritedText = '{"rules":{"unused-exports":"error"},"private":"ancestor"}\n';
			await writeFile(inherited, inheritedText);
			const child = join(root, "child");
			await mkdir(child);
			const assistant = assistantFor(inherited);
			const plan = await assistant.previewRule(child, "unused-exports", "warn");
			assert.equal(plan.preview.source, ".fallowrc.jsonc");
			assert.match(plan.preview.backupPolicy, /No backup/);
			await assistant.apply(plan, child, { confirmed: true });
			assert.equal(await readFile(inherited, "utf8"), inheritedText);
			const local = await readFile(join(child, ".fallowrc.jsonc"), "utf8");
			assert.match(local, /"extends": "\.\.\/\.fallowrc\.jsonc"/);
			assert.match(local, /"unused-exports": "warn"/);
			assert.doesNotMatch(local, /ancestor/);
		});
	});

	it("names source and schema path for malformed input and invalid requests", async () => {
		await withWorkspace(async (root) => {
			const path = join(root, ".fallowrc.jsonc");
			await writeFile(path, '{"rules": { invalid }}');
			const assistant = assistantFor(path);
			await assert.rejects(
				assistant.previewRule(root, "unused-exports", "warn"),
				(error) => /\.fallowrc\.jsonc/.test(error.message) && /schema path \$/.test(error.message),
			);
			await assert.rejects(assistant.previewRule(root, "unknown-rule", "warn"), /schema path \$\.rules\.unknown-rule/);
			await assert.rejects(assistant.previewRule(root, "unused-exports", "fatal"), /schema path \$\.rules\.unused-exports/);

			const failed = createFallowConfigAssistant({}, fixtureRunner(path, { configFailure: true }));
			const inspection = await failed.inspect(root);
			assert.equal(inspection.status, "invalid");
			assert.match(inspection.diagnostic, /\.fallowrc\.jsonc.*schema path \$/);
			assert.doesNotMatch(inspection.diagnostic, /sensitive raw config/);
		});
	});

	it("refuses concurrent content/schema drift and cancellation without creating config writes or backups", async () => {
		await withWorkspace(async (root) => {
			const path = join(root, "fallow.toml");
			const original = '[rules]\nunused-exports = "error"\n';
			await writeFile(path, original);
			const assistant = assistantFor(path);
			const stale = await assistant.previewRule(root, "unused-exports", "warn");
			await writeFile(path, `${original}# concurrent edit\n`);
			await assert.rejects(assistant.apply(stale, root, { confirmed: true }), /Refusing stale.*content changed/);
			assert.ok(!(await readdir(root)).some((name) => name.includes("pi-fallow.bak")));

			await writeFile(path, original);
			const mutable = { schema: structuredClone(schema) };
			const schemaAssistant = assistantFor(path, mutable);
			const schemaPlan = await schemaAssistant.previewRule(root, "unused-exports", "warn");
			mutable.schema.$defs.RulesConfig.properties["future-rule"] = {};
			await assert.rejects(schemaAssistant.apply(schemaPlan, root, { confirmed: true }), /config schema changed/);
			assert.ok(!(await readdir(root)).some((name) => name.includes("pi-fallow.bak")));

			const cancelled = await assistant.previewRule(root, "unused-exports", "warn");
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(assistant.apply(cancelled, root, { confirmed: true, signal: controller.signal }), /cancelled; no config write/);
			assert.equal(await readFile(path, "utf8"), original);
			assert.ok(!(await readdir(root)).some((name) => name.includes("pi-fallow.bak")));
		});
	});

	it("requires interactive confirmation and treats decline as a no-write cancellation", async () => {
		await withWorkspace(async (root) => {
			const path = join(root, ".fallowrc.json");
			const original = '{"rules":{"unused-exports":"error"}}\n';
			await writeFile(path, original);
			const messages = [];
			const notices = [];
			let confirms = 0;
			const pi = { sendMessage(message) { messages.push(message); } };
			const assistant = createFallowConfigAssistant(pi, fixtureRunner(path));
			await runFallowConfigAssistantCommand(pi, {
				cwd: root, mode: "tui", hasUI: true,
				ui: { async confirm() { confirms++; return false; }, notify(message) { notices.push(message); } },
			}, ["config-assist", "apply-rule", "unused-exports", "warn"], assistant);
			assert.equal(confirms, 1);
			assert.equal(messages.length, 1);
			assert.equal(messages[0].customType, "fallow-config-assistant");
			assert.match(notices.at(-1), /cancelled/);
			assert.equal(await readFile(path, "utf8"), original);
			assert.deepEqual(await readdir(root), [".fallowrc.json"]);

			await assert.rejects(runFallowConfigAssistantCommand(pi, {
				cwd: root, mode: "rpc", hasUI: false, ui: {},
			}, ["config-assist", "apply-rule", "unused-exports", "warn"], assistant), /interactive TUI confirmation/);
			assert.equal(await readFile(path, "utf8"), original);

			await runFallowConfigAssistantCommand(pi, {
				cwd: root, mode: "tui", hasUI: true,
				ui: { async confirm() { return true; }, notify(message) { notices.push(message); } },
			}, ["config-assist", "apply-rule", "unused-exports", "warn"], assistant);
			assert.match(await readFile(path, "utf8"), /"unused-exports":"warn"/);
			assert.equal(messages.at(-1).details.status, "applied");
			assert.match(notices.at(-1), /applied/);
		});
	});
});
