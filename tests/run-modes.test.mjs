import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runFallowWithLoaderIfUi } = await jiti.import("../extensions/fallow/command/loader.ts");
const { hasFallowNavigator, isFallowTuiMode } = await jiti.import("../extensions/fallow/command/mode.ts");
const { buildFallowTranscriptContent } = await jiti.import("../extensions/fallow/command/transcript.ts");

const modes = [
	{ mode: "tui", hasUI: true, usesTui: true },
	{ mode: "rpc", hasUI: true, usesTui: false },
	{ mode: "json", hasUI: false, usesTui: false },
	{ mode: "print", hasUI: false, usesTui: false },
];

function createContext(mode, hasUI, customResult) {
	const calls = { custom: 0, statuses: [] };
	return {
		calls,
		context: {
			cwd: "/workspace",
			mode,
			hasUI,
			ui: {
				custom() {
					calls.custom++;
					if (mode !== "tui") throw new Error(`custom UI used in ${mode} mode`);
					return Promise.resolve(customResult);
				},
				setStatus(key, text) { calls.statuses.push({ key, text }); },
			},
		},
	};
}

describe("Fallow command run modes", () => {
	for (const expected of modes) {
		it(`selects the correct execution path in ${expected.mode} mode`, async () => {
			const commandResult = { mode: expected.mode };
			const { calls, context } = createContext(expected.mode, expected.hasUI, commandResult);
			let executions = 0;
			const result = await runFallowWithLoaderIfUi(context, async () => {
				executions++;
				return commandResult;
			}, ["health"]);

			assert.equal(isFallowTuiMode(expected.mode), expected.usesTui);
			assert.equal(result, commandResult);
			assert.equal(calls.custom, expected.usesTui ? 1 : 0);
			assert.equal(executions, expected.usesTui ? 0 : 1);
		});
	}

	it("uses RPC status methods without opening custom UI", async () => {
		const commandResult = { mode: "rpc" };
		const { calls, context } = createContext("rpc", true, commandResult);
		await runFallowWithLoaderIfUi(context, async () => commandResult, ["health"]);
		assert.deepEqual(calls.statuses, [
			{ key: "fallow", text: "fallow running…" },
			{ key: "fallow", text: undefined },
		]);
		assert.equal(calls.custom, 0);
	});

	it("keeps full transcript output when no TUI navigator can open", () => {
		const overview = {
			title: "Dead code",
			status: "warning",
			stats: [],
			sections: [{ title: "Findings", items: [{ label: "unused export" }] }],
			notes: [],
		};
		for (const { mode } of modes) {
			const hasNavigator = hasFallowNavigator(mode, overview);
			const content = buildFallowTranscriptContent("project", "summary", "full report", hasNavigator);
			if (mode === "tui") {
				assert.match(content, /^Opened Fallow issue navigator\./);
			} else {
				assert.equal(content, "full report");
			}
		}
	});
});
