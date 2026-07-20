import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	renderFallowMessageRenderer,
	renderFallowToolResult,
} = await jiti.import("../extensions/fallow/tool-render.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};
const overview = {
	title: "Fallow error",
	status: "error",
	stats: [],
	sections: [],
	notes: ["missing required issue type"],
};
const details = {
	command: "fallow",
	args: ["explain", "--format", "json", "--quiet"],
	cwd: process.cwd(),
	exitCode: 2,
	elapsedMs: 1,
	parsed: true,
	summary: "error: missing required issue type",
	overview,
	projectState: { configPath: ".fallowrc.json", configSource: "file", cacheEnabled: true, cacheFiles: [] },
};

describe("Fallow execution-error rendering", () => {
	it("hides unrelated project configuration from tool errors", () => {
		const rendered = renderFallowToolResult({ details }, { expanded: true }, theme).render(100).join("\n");

		assert.match(rendered, /Fallow error/);
		assert.match(rendered, /missing required issue type/);
		assert.doesNotMatch(rendered, /Config:/);
		assert.doesNotMatch(rendered, /No issues found/);
	});

	it("hides unrelated project configuration from slash-command errors", () => {
		const rendered = renderFallowMessageRenderer({ details, content: "error" }, { expanded: true }, theme).render(100).join("\n");

		assert.match(rendered, /Fallow error/);
		assert.match(rendered, /missing required issue type/);
		assert.doesNotMatch(rendered, /Config:/);
	});
});
