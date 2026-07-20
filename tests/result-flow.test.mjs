import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowTranscriptContent } = await jiti.import("../extensions/fallow/command/transcript.ts");

describe("buildFallowTranscriptContent", () => {
	it("keeps full output when no navigator is available", () => {
		assert.equal(
			buildFallowTranscriptContent("project", "summary", "full report", false),
			"full report",
		);
	});

	it("uses the compact navigator summary when findings are navigable", () => {
		assert.equal(
			buildFallowTranscriptContent("project", "summary", "full report", true),
			"Opened Fallow issue navigator.\nproject\nsummary",
		);
	});
});
