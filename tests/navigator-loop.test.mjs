import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runFallowNavigatorLoop } = await jiti.import("../extensions/fallow/command/navigator-loop.ts");

const state = {
	selectedReportIndex: 4,
	scrollStart: 2,
	expandedReportIndices: [4],
	markedReportIndices: [4, 7],
	query: "unused",
	sectionFilter: 1,
	severityFilter: "high",
	showInformational: false,
	includeFullDetails: true,
};

function actionResult(commandArgs = ["inspect", "--file", "src/a.ts"]) {
	return {
		type: "action",
		label: "Inspect file",
		commandArgs,
		returnTo: { commandArgs: ["issues"], state },
	};
}

describe("Fallow navigator action loop", () => {
	it("runs an action and restores the originating navigator after close or cancellation", async () => {
		const responses = [actionResult(), null, { type: "prompt", prompt: "restored", issueCount: 1, detail: "compact" }];
		const calls = [];
		const result = await runFallowNavigatorLoop(["issues"], true, async (args, rememberLast, initialState) => {
			calls.push({ args, rememberLast, initialState });
			return responses.shift();
		});

		assert.equal(result?.type, "prompt");
		assert.deepEqual(calls, [
			{ args: ["issues"], rememberLast: true, initialState: undefined },
			{ args: ["inspect", "--file", "src/a.ts"], rememberLast: false, initialState: undefined },
			{ args: ["issues"], rememberLast: false, initialState: state },
		]);
	});

	it("supports nested read-only actions and unwinds each preserved navigator", async () => {
		const nestedState = { ...state, selectedReportIndex: 1 };
		const nested = {
			type: "action",
			label: "Check architecture rules",
			commandArgs: ["guard", "src/a.ts"],
			returnTo: { commandArgs: ["inspect", "--file", "src/a.ts"], state: nestedState },
		};
		const responses = [actionResult(), nested, null, null, null];
		const calls = [];
		const result = await runFallowNavigatorLoop(["issues"], true, async (args, rememberLast, initialState) => {
			calls.push({ args, rememberLast, initialState });
			return responses.shift();
		});

		assert.equal(result, null);
		assert.deepEqual(calls.map((entry) => entry.args), [
			["issues"],
			["inspect", "--file", "src/a.ts"],
			["guard", "src/a.ts"],
			["inspect", "--file", "src/a.ts"],
			["issues"],
		]);
		assert.equal(calls[3].initialState, nestedState);
		assert.equal(calls[4].initialState, state);
	});

	it("does not execute navigator actions outside TUI mode", async () => {
		const calls = [];
		const result = await runFallowNavigatorLoop(["issues"], false, async (args, rememberLast) => {
			calls.push({ args, rememberLast });
			return actionResult();
		});

		assert.equal(result?.type, "action");
		assert.deepEqual(calls, [{ args: ["issues"], rememberLast: true }]);
	});
});
