import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerPiFallow } = await jiti.import("../extensions/fallow.ts");
const { fallowCompletions } = await jiti.import("../extensions/fallow/autocomplete.ts");
const { fallowCli } = await jiti.import("../extensions/fallow/cli.ts");
const { fallowToolContract } = await jiti.import("../extensions/fallow/contract.ts");
const {
	fallowArgumentHint,
	fallowSlashRootCommands,
	fallowToolCommands,
	getFallowToolCommandSpec,
} = await jiti.import("../extensions/fallow/registry.ts");

function argsFor(command, spec) {
	if (command === "check-changed") return ["--changed-since", "main"];
	if (!spec.positionalTarget) return [];
	return [spec.pathTargets ? "@src/example.ts:target" : "target"];
}

describe("Fallow command registry", () => {
	it("is the exact source of the public tool command enum", () => {
		assert.deepEqual(fallowToolContract.parameters.properties.command.enum, fallowToolCommands);
		assert.equal(new Set(fallowToolCommands).size, fallowToolCommands.length);
		assert.ok(fallowToolCommands.includes("architecture"));
	});

	it("provides a compact CLI mapping for every tool command", () => {
		for (const command of fallowToolCommands) {
			const spec = getFallowToolCommandSpec(command);
			assert.ok(spec, `Missing registry spec for ${command}`);
			const built = fallowCli.buildFallowArgs({ command, args: argsFor(command, spec) });
			assert.deepEqual(built.slice(0, spec.cliPrefix.length), spec.cliPrefix, command);
		}
	});

	it("derives slash autocomplete and the registered argument hint from registry metadata", () => {
		const completionValues = new Set(
			fallowCompletions.getFallowRootCommandCompletions().map((item) => item.value),
		);
		for (const command of fallowSlashRootCommands) {
			if (command.autocomplete !== false) {
				assert.ok(completionValues.has(`fallow ${command.value}`), `Missing completion for ${command.value}`);
			}
		}

		const hintedRoots = fallowSlashRootCommands
			.filter((command) => command.hintOrder !== undefined)
			.sort((left, right) => left.hintOrder - right.hintOrder)
			.map((command) => command.value);
		assert.equal(fallowArgumentHint, `[${hintedRoots.join("|")}] [options]`);

		let registeredCommand;
		registerPiFallow({
			registerTool() {},
			registerCommand(name, command) { if (name === "fallow") registeredCommand = command; },
			registerMessageRenderer() {},
			on() {},
		});
		assert.equal(registeredCommand.argumentHint, fallowArgumentHint);
	});
});
