import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { assertRegistrySchema } from "../scripts/schema-registry-check.mjs";

const jiti = createJiti(import.meta.url);
const { fallowToolCommands, getFallowToolCommandSpec } = await jiti.import("../extensions/fallow/registry.ts");
const specs = fallowToolCommands.map(getFallowToolCommandSpec);
const frozen = JSON.parse(readFileSync(new URL("./fixtures/fallow/schema-3.21.0.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function changedSchema(change) {
	const schema = structuredClone(frozen);
	change(schema);
	return schema;
}

function command(schema, name) {
	return schema.commands.find((entry) => entry.name === name);
}

function globalFlag(schema, name) {
	return schema.global_flags.find((entry) => entry.name === name);
}

describe("registry versus certified Fallow schema", () => {
	it("certifies every tool command against a fixture matching the pinned development target", () => {
		assert.equal(frozen.version, manifest.devDependencies.fallow);
		assertRegistrySchema(frozen, specs);
	});

	it("identifies every affected alias when its CLI command disappears", () => {
		for (const spec of specs.filter((entry) => entry.cliPrefix.length)) {
			const root = spec.cliPrefix[0];
			const schema = changedSchema((data) => { data.commands = data.commands.filter((entry) => entry.name !== root); });
			assert.throws(() => assertRegistrySchema(schema, [spec]), {
				message: `${spec.name} -> ${root}: schema is missing command ${root}`,
			});
		}
	});

	it("checks fixed boolean flags and value-taking trace flags, not just command names", () => {
		for (const spec of specs.filter((entry) => entry.cliPrefix.some((token) => token.startsWith("--")))) {
			const [root, flag] = spec.cliPrefix;
			const schema = changedSchema((data) => {
				const entry = command(data, root).flags.find((entry) => entry.name === flag);
				entry.type = entry.type === "bool" ? "string" : "bool";
			});
			assert.throws(() => assertRegistrySchema(schema, [spec]), /must remain/);
		}
	});

	it("rejects missing managed flags, loss of JSON, and incompatible local shadows", () => {
		for (const mutate of [
			(data) => { data.global_flags = data.global_flags.filter((flag) => flag.name !== "--quiet"); },
			(data) => { data.output_formats = ["human"]; },
			(data) => { globalFlag(data, "--format").possible_values = ["human"]; },
			(data) => { command(data, "health").flags.push({ name: "--quiet", type: "string" }); },
		]) assert.throws(() => assertRegistrySchema(changedSchema(mutate), specs), /quiet|json|JSON/);
	});

	it("checks target requirements and the architecture boolean-flag scanner", () => {
		for (const mutate of [
			(data) => { command(data, "guard").flags = []; },
			(data) => { command(data, "trace").flags[0].required = false; },
			(data) => { command(data, "explain").flags[0].type = "bool"; },
			(data) => { globalFlag(data, "--no-cache").type = "string"; },
			(data) => { delete globalFlag(data, "--quiet").short; },
		]) assert.throws(() => assertRegistrySchema(changedSchema(mutate), specs), /positional target|must remain|missing -q/);
	});

	it("checks changed-file and selected type-aware requirements", () => {
		for (const mutate of [
			(data) => { globalFlag(data, "--changed-since").type = "bool"; },
			(data) => { globalFlag(data, "--type-aware-project").type = "bool"; },
			(data) => { command(data, "dead-code").flags = command(data, "dead-code").flags.filter((flag) => flag.name !== "--symbol-impact"); },
			(data) => { command(data, "health").flags = command(data, "health").flags.filter((flag) => flag.name !== "--type-coupling"); },
		]) assert.throws(() => assertRegistrySchema(changedSchema(mutate), specs), /must remain|schema is missing/);
	});

	it("requires review of manifest, default-command, and nested-prefix changes", () => {
		assert.throws(() => assertRegistrySchema(changedSchema((data) => { data.manifest_version = "2"; }), specs), /manifest format/);
		assert.throws(() => assertRegistrySchema(changedSchema((data) => { data.default_command = "health"; }), specs), /changed default command/);
		assert.throws(() => assertRegistrySchema(frozen, [{ name: "coverage-analyze", cliPrefix: ["coverage", "missing"] }]), /unverified nested CLI prefix/);
	});

	it("allows additive commands, flags, issue types, formats, and version changes", () => {
		const schema = changedSchema((data) => {
			data.version = "99.0.0";
			data.commands.push({ name: "future-command", flags: [] });
			data.global_flags.push({ name: "--future-flag", type: "bool", required: false });
			command(data, "health").flags.push({ name: "--future-health-flag", type: "string", required: false });
			data.issue_types = [{ id: "future-issue" }];
			data.output_formats.push("future-format");
		});
		assertRegistrySchema(schema, specs);
	});
});
