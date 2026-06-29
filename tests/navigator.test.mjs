import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function createOverview() {
	return {
		title: "Fallow dead-code",
		status: "warning",
		stats: [{ label: "issues", value: 2 }],
		notes: [],
		sections: [{
			title: "Unused exports",
			count: 2,
			items: [
				{
					label: "unused helper",
					path: "src/a.ts",
					line: 7,
					meta: "export helper",
					action: "Remove the export or add a real use.",
					raw: { type: "unused_export", exportName: "helper" },
				},
				{
					label: "dead file",
					path: "src/dead.ts",
					action: "Delete src/dead.ts if it is intentionally unused.",
					raw: { type: "unused_file", path: "src/dead.ts" },
				},
			],
		}],
	};
}

describe("FallowIssueNavigator prompt generation", () => {
	it("builds an editable prompt for selected findings", () => {
		let result = null;
		let renderRequests = 0;
		const navigator = new FallowIssueNavigator(
			createOverview(),
			theme,
			(value) => {
				result = value;
			},
			() => {
				renderRequests += 1;
			},
			{ command: "dead-code --format json --quiet" },
		);

		navigator.handleInput("s");
		navigator.handleInput("j");
		navigator.handleInput("s");
		navigator.handleInput("e");

		assert.equal(renderRequests, 3);
		assert.equal(result?.type, "prompt");
		assert.equal(result?.issueCount, 2);
		assert.match(result.prompt, /Please work on the following selected Fallow findings\./);
		assert.match(result.prompt, /Additional instructions from user:/);
		assert.match(result.prompt, /Fallow command: dead-code --format json --quiet/);
		assert.match(result.prompt, /## 1\. Unused exports: unused helper/);
		assert.match(result.prompt, /Location: src\/a\.ts:7/);
		assert.match(result.prompt, /Details: export helper/);
		assert.match(result.prompt, /Suggested action: Remove the export or add a real use\./);
		assert.match(result.prompt, /"type": "unused_export"/);
		assert.match(result.prompt, /## 2\. Unused exports: dead file/);
		assert.match(result.prompt, /Location: src\/dead\.ts/);
	});

	it("builds a prompt for the current finding when none are marked", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createOverview(), theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("j");
		navigator.handleInput("a");

		assert.equal(result?.type, "prompt");
		assert.equal(result?.issueCount, 1);
		assert.doesNotMatch(result.prompt, /unused helper/);
		assert.match(result.prompt, /## 1\. Unused exports: dead file/);
	});
});
